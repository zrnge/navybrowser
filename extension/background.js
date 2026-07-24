// background.js — service worker for Navy.
//
// Responsibilities:
//   1. Run the native Agent observe-plan-act loop.
//   2. Take page snapshots via CDP AX-tree and screenshots.
//   3. Execute browser actions via chrome.debugger (CDP).
//   4. Enforce the domain allowlist client-side as a second line of defense.
//   5. Show clear status in the side panel and on the action icon.
//   6. Respond to the panic-stop command.

import { LocalLLM } from "./llm.js";
import { Agent } from "./agent.js";
import { DomainPolicy, AuditLogger, sanitizeLabel, looksLikeCredentialField } from "./security.js";

// Chrome refuses to attach the debugger or inject scripts into its own internal
// pages and certain protected origins. Trying to do so produces opaque errors
// like "Cannot access a chrome:// URL" mid-task. Detect these up front so we
// can tell the user clearly to switch tabs.
const RESTRICTED_URL_PREFIXES = [
  "chrome://",
  "chrome-extension://",
  "chrome-search://",
  "chrome-devtools://",
  "devtools://",
  "edge://",
  "brave://",
  "opera://",
  "vivaldi://",
  "about:",
  "view-source:",
  "file://",
  "https://chrome.google.com/webstore",
  "https://chromewebstore.google.com",
  "https://microsoftedge.microsoft.com/addons",  // Edge Add-ons gallery — cannot be scripted
];

function isRestrictedUrl(url) {
  if (!url) return true;
  const lower = url.toLowerCase();
  return RESTRICTED_URL_PREFIXES.some(p => lower.startsWith(p));
}

// -- State --------------------------------------------------------------------

const STATE = {
  attachedTabId: null,           // tab the debugger is attached to
  running: false,
  goal: null,
  lastProgress: null,
  panelClients: new Set(),       // ports from side panel for status broadcast
  lastElementMap: {},            // som_id → {x,y,w,h,label} from most recent snapshot
  // Caching elements
  lastUrl: null,
  lastTitle: null,
  lastScrollPos: null,
  lastViewportW: 0,
  lastViewportH: 0,
  lastScreenshotB64: null,
  lastElementMapArray: [],

  activeConfirmResolver: null,
  activeAnswerResolver: null,
  activeAgent: null,
  cancelled: false,
  elementMapDirty: false,   // set true after any DOM change; forces element re-scan on next snapshot
  inFlightRequests: new Set(), // active network requests in flight
  autoApprove: false,           // live auto-approve flag; updated on the fly from panel UI
  autoApproveTypes: [],         // per-action-type auto-approve buckets (e.g. ["read","navigate"])
  tabGroupId: null,             // tab group ID for Navy tasks
  navyWindowId: null,           // dedicated window ID for Navy tasks
  programmaticTabRemove: false, // flag to prevent trigger of panicStop when tab is closed programmatically
  programmaticTabs: new Set(),  // tab IDs created programmatically by actNewTab (avoids onCreated races)
  programmaticTabCreating: 0,   // count of in-flight chrome.tabs.create calls; guards onCreated race
  knownPopupWindowIds: new Set(), // window IDs opened as popups during a task (avoid aggressive tracking)
  batchDepth: 0,                 // recursion depth of batch action execution
  panelOpening: false,           // true if the panel is currently opening
  screenshotScale: 1.0,          // scale factor applied when downscaling screenshot for LLM (outW/logicalW)
  sessionTrustedActions: new Set(), // "hostname:actionType" pairs the user has trusted for this session
  pendingCanvasZoom: null,       // one-shot zoom crop injected into next snapshot by zoom_canvas action
  canvasLabelMap: {},            // som_id → [{label, x, y}] from scan_canvas — AI-generated canvas SOM
  canvasHashMap: {},             // som_id → last pixel hash of the canvas
  canvasHashSalt: 0,             // bumped to force cache invalidation across tasks
  lastX: null,                   // pointer tracker for realistic gliding (starts null until first move)
  lastY: null,
  lastHoverTarget: null,         // tracks the target of the last successful hover action
  lastActionType: null,          // tracks the type of the last successful action
  lastDialog: null,              // { type, message, url, ts } of most-recently auto-dismissed JS dialog
  sessionConversationMessages: [], // loaded from persisted cross-task memory; cleared on "New Chat"
  infobarCompensationApplied: 0, // amount of px the window was stretched to compensate for debugger infobar
  compensatedWindowId: null,     // the window that was stretched
  childSessions: new Map(),      // active flattened session IDs (OOPIFs) -> targetId
};

// Maps individual action types to their auto-approve bucket name (set in Settings).
const ACTION_BUCKETS = {
  read: "read", wait: "read", wait_for: "read", screenshot: "read", find_text: "read", zoom_canvas: "read", listen: "read",
  navigate: "navigate", new_tab: "navigate", go_back: "navigate", go_forward: "navigate",
  refresh: "navigate", switch_tab: "navigate", close_tab: "navigate", list_tabs: "navigate",
  click: "click", double_click: "click", right_click: "click", hover: "click", hold: "click",
  type: "type", select: "type", key: "type",
  scroll: "scroll", scroll_wheel: "scroll",
  drag: "drag",
  script: "script", fetch: "fetch",
  file_upload: "file", write_file: "file", download: "file",
  read_download: "read", downloads_list: "read",
};

// These action types require explicit confirmation every time they are used.
// They show the "Trust this site for session" option (except NEVER_SESSION_TRUST types).
const CONFIRM_ALWAYS = new Set(["script", "fetch", "file_upload", "write_file", "download", "listen", "history_search", "bookmark"]);

// These action types within CONFIRM_ALWAYS must NEVER be auto-approved via session trust —
// each individual use requires explicit user confirmation because the content of the
// action (e.g. which JS expression runs, which audio is captured) cannot be pre-approved.
const NEVER_SESSION_TRUST = new Set(["script", "listen", "history_search"]);

function isActionAutoApproved(actionType) {
  if (!STATE.autoApproveTypes || STATE.autoApproveTypes.length === 0) return false;
  const bucket = ACTION_BUCKETS[actionType] || actionType;
  return STATE.autoApproveTypes.includes(bucket);
}

let newTabHistoryEntry = null;
let watchdogInterval = null;
let _taskGen = 0; // incremented on every start/panic; lets old finally blocks detect they've been superseded

// -- MV3 service-worker lifetime management ------------------------------------
// Chrome kills an MV3 service worker after ~30s without extension-API activity.
// While a task runs, two independent mechanisms keep it healthy:
//   1. keepaliveInterval — a trivial API call every 20s resets the idle timer so
//      the worker survives long gaps (LLM thinking, page settles) between actions.
//   2. TASK_RECOVERY_ALARM — if Chrome kills the worker anyway (crash, update,
//      DevTools close), the alarm re-wakes it within ~30s; the top-level
//      resumeTaskIfNeeded() call then picks the task back up from storage.
const TASK_RECOVERY_ALARM = "navy-task-recovery";
let keepaliveInterval = null;

function startTaskKeepalive() {
  if (!keepaliveInterval) {
    keepaliveInterval = setInterval(() => {
      if (!STATE.running) { stopTaskKeepalive(); return; }
      chrome.runtime.getPlatformInfo(() => {});
    }, 20000);
  }
  // periodInMinutes 0.5 needs Chrome 120+; older versions clamp to 1 min, which
  // still recovers the task — just a little slower.
  chrome.alarms.create(TASK_RECOVERY_ALARM, { periodInMinutes: 0.5 });
}

function stopTaskKeepalive() {
  if (keepaliveInterval) {
    clearInterval(keepaliveInterval);
    keepaliveInterval = null;
  }
  chrome.alarms.clear(TASK_RECOVERY_ALARM).catch(() => {});
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== TASK_RECOVERY_ALARM) return;
  // The alarm's job is only to wake the worker — if it was dead, the top-level
  // resumeTaskIfNeeded() has already run by the time this handler fires. All
  // that's left is housekeeping: drop the alarm once no task remains.
  if (STATE.running) return;
  chrome.storage.local.get("activeTaskState").then(({ activeTaskState }) => {
    if (!activeTaskState && !STATE.running) chrome.alarms.clear(TASK_RECOVERY_ALARM).catch(() => {});
  }).catch(() => {});
});

function startWatchdog(tabId) {
  if (watchdogInterval) clearInterval(watchdogInterval);
  watchdogInterval = setInterval(async () => {
    // Stop if the task ended or the active tab changed (another watchdog will handle it)
    if (!STATE.running || STATE.attachedTabId !== tabId) {
      clearInterval(watchdogInterval);
      watchdogInterval = null;
      return;
    }
    // Probe the debugger connection; swallow the unchecked lastError warning by catching
    try {
      await sendCDP(tabId, "DOM.enable", {});
    } catch (e) {
      // Only attempt reconnect for genuine connection loss, not for restricted URLs
      let currentUrl = "";
      try { currentUrl = (await chrome.tabs.get(tabId)).url || ""; } catch (_) {}
      if (isRestrictedUrl(currentUrl)) {
        console.warn("[agent] Watchdog: tab navigated to restricted URL, skipping reconnect");
        return;
      }
      console.warn("[agent] CDP watchdog ping failed, attempting reconnect...", e);
      try {
        await detachDebugger().catch(() => {});
        await attachDebugger(tabId);
        STATE.attachedTabId = tabId;
        console.log("[agent] debugger reconnected");
        broadcastStatus({ event: "progress", step: 0, thought: "debugger reconnected", kind: "info" });
      } catch (err) {
        console.error("[agent] CDP watchdog reconnect failed:", err);
      }
    }
  }, 10000);
}

chrome.tabs.onCreated.addListener(async (tab) => {
  if (!STATE.running || !STATE.attachedTabId) return;

  // Skip programmatically created tabs to prevent debugger attachment race conditions.
  // Use a pre-create counter so the guard fires even before chrome.tabs.create resolves
  // (the onCreated event can fire before the awaited Promise settles).
  if (STATE.programmaticTabCreating > 0) {
    STATE.programmaticTabCreating = Math.max(0, STATE.programmaticTabCreating - 1);
    STATE.programmaticTabs.add(tab.id);
    return;
  }
  if (STATE.programmaticTabs.has(tab.id)) {
    STATE.programmaticTabs.delete(tab.id);
    return;
  }

  // ADOPT ONLY a tab that was opened FROM the tab Navy is currently driving — a
  // target=_blank link or window.open on the working page sets openerTabId to that
  // tab — or a popup the page itself spawned (tracked in knownPopupWindowIds).
  // A tab the USER opened manually (Ctrl+T, or a link clicked in some OTHER tab)
  // has no opener, or a different one, and must be left completely alone: no
  // grouping, no debugger. This is what stops Navy from attaching the debugger to
  // every tab the user opens during a task.
  // (The old logic auto-grouped any new tab in Navy's window and then treated that
  // self-inflicted group membership as permission to attach — grabbing user tabs;
  // and its gate no-op'd entirely when there was no tab group.)
  const openedFromWorkingTab = tab.openerTabId != null && tab.openerTabId === STATE.attachedTabId;
  const inKnownPopup = STATE.knownPopupWindowIds && STATE.knownPopupWindowIds.has(tab.windowId);
  if (!openedFromWorkingTab && !inKnownPopup) {
    return;
  }

  // Group the adopted tab into the Navy group — only genuinely adopted tabs reach here.
  if (STATE.tabGroupId) {
    try {
      await chrome.tabs.group({ tabIds: [tab.id], groupId: STATE.tabGroupId });
    } catch (_) {}
  }

  const prevTabId = STATE.attachedTabId;

  // Wait briefly for the tab URL to settle (it starts as "about:blank")
  await sleep(800);
  let freshTab;
  try { freshTab = await chrome.tabs.get(tab.id); } catch (_) { return; }

  // Never try to attach the debugger to a restricted chrome:// or internal URL.
  // If the new tab is restricted, stay on the previous tab unchanged.
  if (isRestrictedUrl(freshTab.url)) {
    console.log(`[agent] New tab ${tab.id} has restricted URL (${freshTab.url}), staying on tab ${prevTabId}`);
    return;
  }

  await detachDebugger().catch(() => {});
  try {
    await attachDebugger(tab.id);
    STATE.attachedTabId = tab.id;
    // Re-assert focus on the adopted tab — an in-flight snapshot of the old tab
    // may have stolen activation back in the meantime.
    chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    newTabHistoryEntry = `New tab opened: ${freshTab.url || "about:blank"}. Continuing in new tab.`;
    broadcastStatus({ event: "progress", step: 0, thought: newTabHistoryEntry, kind: "info" });
    startWatchdog(tab.id);
  } catch (e) {
    console.error("[agent] Failed to attach debugger to newly created tab:", e);
    // Restore debugger on the previous tab so the task can continue
    try {
      await attachDebugger(prevTabId);
      STATE.attachedTabId = prevTabId;
      startWatchdog(prevTabId);
    } catch (err) {
      console.error("[agent] Failed to restore debugger to previous tab:", err);
    }
  }
});

// Track popup windows opened by the automated page (window.open with popup=1)
// so that tabs created inside them are handled just like tabs in the main window.
chrome.windows.onCreated.addListener(async (win) => {
  if (!STATE.running || !STATE.attachedTabId) return;
  // Only track popups opened during an active task that appear as popup type
  if (win.type !== "popup") return;
  STATE.knownPopupWindowIds.add(win.id);
});

// -- Side Panel Tab Restrictions ---------------------------------------------
function getOpenPanelActiveTabs() {
  const activeTabs = new Set();
  for (const port of STATE.panelClients) {
    if (port.tabId) {
      activeTabs.add(port.tabId);
    }
  }
  return activeTabs;
}

async function updateSidePanelVisibilityForTab(tabId) {
  // Global side panel is enabled for all tabs, no tab-specific disabling to prevent sidebar closure
}

async function updateAllSidePanels() {
  // Global side panel is enabled for all tabs, no tab-specific disabling to prevent sidebar closure
}

async function resetAllSidePanels() {
  // Global side panel is enabled for all tabs, no tab-specific disabling to prevent sidebar closure
}

chrome.tabs.onActivated.addListener((activeInfo) => {
  updateSidePanelVisibilityForTab(activeInfo.tabId).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.groupId !== undefined || changeInfo.url !== undefined) {
    updateSidePanelVisibilityForTab(tabId).catch(() => {});
  }
  // If the attached tab is updating or loading, ensure the cursor is restored
  if (STATE.attachedTabId === tabId && (changeInfo.status === "loading" || changeInfo.status === "complete")) {
    if (STATE.lastX !== null && STATE.lastX !== undefined) {
      showAgentCursor(tabId, STATE.lastX, STATE.lastY).catch(() => {});
    }
  }
});

// Monitor Tab, Group, and Window removals to stop task and close side panel when exited/closed
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  if (!STATE.running) return;
  if (STATE.programmaticTabRemove) return;

  // If the target tab was closed:
  if (tabId === STATE.attachedTabId) {
    console.warn(`[agent] Target tab ${tabId} was closed. Stop task and close side panel.`);
    panicStop("target tab closed");
    broadcastStatus({ event: "close_side_panel" });
    return;
  }

  // If tabGroupId is active, check if all tabs in the group are closed
  if (STATE.tabGroupId) {
    try {
      const tabsInGroup = await chrome.tabs.query({ groupId: STATE.tabGroupId });
      if (tabsInGroup.length === 0) {
        console.warn(`[agent] All tabs in group ${STATE.tabGroupId} were closed. Stop task and close side panel.`);
        panicStop("all group tabs closed");
        broadcastStatus({ event: "close_side_panel" });
      }
    } catch (_) {}
  }
});

chrome.tabGroups.onRemoved.addListener(async (group) => {
  if (STATE.tabGroupId && group.id === STATE.tabGroupId) {
    if (STATE.running) {
      console.warn(`[agent] Tab group ${group.id} containing task was closed. Stop task and close side panel.`);
      panicStop("tab group closed");
      broadcastStatus({ event: "close_side_panel" });
    } else {
      STATE.tabGroupId = null;
      STATE.navyWindowId = null;
      await resetAllSidePanels();
    }
  }
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  if (!STATE.running) return;
  if (STATE.navyWindowId && windowId === STATE.navyWindowId) {
    console.warn(`[agent] Window ${windowId} containing task was closed. Stop task and close side panel.`);
    panicStop("window closed");
    broadcastStatus({ event: "close_side_panel" });
  }
});


// -- Debugger detach watchdog -------------------------------------------------
// Fires when Chrome force-detaches the debugger (user clicked Cancel on the
// orange "being debugged" banner, or DevTools opened and took over).
chrome.debugger.onDetach.addListener(async (source, reason) => {
  if (!STATE.running) return;
  if (source.tabId !== STATE.attachedTabId) return;

  if (reason === "target_closed") {
    // Check if the tab actually still exists. If it does, this was likely a 
    // cross-origin/cross-process navigation (e.g. OAuth redirect), not a true close.
    try {
      const tab = await chrome.tabs.get(source.tabId);
      if (tab) {
        console.warn(`[agent] Debugger detached (target_closed) but tab exists. Likely cross-origin navigation. Re-attaching...`);
        // Wait 500ms to let the new process spin up
        await new Promise(r => setTimeout(r, 500));
        // A failed reattach here must not become an unhandled rejection — the
        // 10s watchdog ping will keep retrying; only a dead tab warrants panic.
        await attachDebugger(source.tabId).catch((err) => {
          console.warn("[agent] Re-attach after cross-origin detach failed — watchdog will retry:", err);
        });
        return;
      }
    } catch (_) {}
  }

  // Mark already detached so detachDebugger() inside panicStop won't double-detach
  STATE.attachedTabId = null;
  const label = reason === "canceled_by_user"
    ? "user dismissed the debugger banner"
    : reason === "replaced_with_devtools"
    ? "DevTools opened and took over the debugger"
    : `debugger detached (${reason})`;
  console.warn(`[agent] Debugger detached: ${label}`);
  panicStop(label);
});

// -- Panic stop ---------------------------------------------------------------

chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === "panic-stop") {
    console.warn("[agent] PANIC STOP");
    panicStop("user pressed panic key");
  } else if (cmd === "toggle-side-panel") {
    if (chrome.sidePanel && typeof chrome.sidePanel.open === "function") {
      chrome.windows
        .getCurrent()
        .then((w) => chrome.sidePanel.open({ windowId: w.id }))
        .catch((e) => console.warn("[agent] sidePanel.open failed:", e));
    } else {
      console.warn("[agent] chrome.sidePanel.open unavailable on this Chrome build.");
    }
  }
});

function panicStop(reason) {
  _taskGen++;           // invalidate the current task's finally block so it won't clobber state
  STATE.cancelled = true;
  abortPendingDialogs();
  // Capture the tabId before anything can null it (e.g. onDetach sets it to null
  // before calling panicStop, so stopTabBlink would receive null and skip cleanup).
  const tabIdForCleanup = STATE.attachedTabId;
  stopTabBlink(tabIdForCleanup).catch(() => {});
  detachDebugger().catch(() => {});
  STATE.running = false;
  stopTaskKeepalive();
  STATE.tabGroupId = null;
  STATE.navyWindowId = null;
  broadcastStatus({ event: "panic", reason });
  setBadge("STOP", "#cc1f1f");
  clearActiveTaskState().catch(() => {});
}

function abortPendingDialogs() {
  if (STATE.activeConfirmResolver) {
    STATE.activeConfirmResolver.resolve(false);
    STATE.activeConfirmResolver = null;
  }
  if (STATE.activeAnswerResolver) {
    STATE.activeAnswerResolver.resolve("");
    STATE.activeAnswerResolver = null;
  }
}

// -- Side panel messaging -----------------------------------------------------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "panel") return;
  if (port.sender?.id !== chrome.runtime.id) return;
  STATE.panelClients.add(port);
  STATE.panelOpening = false;

  // Auto-focus and activate the working grouped tab directly when Navy panel is opened
  if (STATE.attachedTabId) {
    port.tabId = STATE.attachedTabId; // Set immediately to prevent race conditions during sidepanel transitions
    chrome.tabs.update(STATE.attachedTabId, { active: true }).catch(() => {});
    chrome.tabs.get(STATE.attachedTabId).then((tab) => {
      if (tab) {
        port.windowId = tab.windowId;
        if (tab.windowId) {
          chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
        }
      }
    }).catch(() => {});
  } else {
    // Automatically group the current active tab in the window when Navy opens
    chrome.tabs.query({ active: true, currentWindow: true }).then(([activeTab]) => {
      if (activeTab) {
        port.tabId = activeTab.id; // Set immediately to prevent race conditions during sidepanel transitions
        port.windowId = activeTab.windowId;
        if (!isRestrictedUrl(activeTab.url)) {
          isolateAndGroupTab(activeTab.id).catch(() => {});
        }
      }
    }).catch(() => {});
  }

  port.onDisconnect.addListener(async () => {
    STATE.panelClients.delete(port);
    if (STATE.panelClients.size === 0) {
      await clearSessionConversation();
      if (!STATE.running) {
        STATE.tabGroupId = null;
        STATE.navyWindowId = null;
        STATE.attachedTabId = null;
      }
      await resetAllSidePanels();
    }
  });
  port.onMessage.addListener(async (msg) => {
    try {
      await handlePanelMessage(msg, port);
    } catch (e) {
      port.postMessage({ type: "error", error: String(e) });
    }
  });
  // Send initial status
  port.postMessage({
    type: "status",
    running: STATE.running,
    goal: STATE.goal,
    lastProgress: STATE.lastProgress,
    attachedTabId: STATE.attachedTabId,
    tabGroupId: STATE.tabGroupId,
  });
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!STATE.attachedTabId || source.tabId !== STATE.attachedTabId) return;

  if (method === "Target.attachedToTarget") {
    const sessionId = params.sessionId;
    if (params.targetInfo && params.targetInfo.type === "iframe") {
      STATE.childSessions.set(sessionId, params.targetInfo.targetId);
      sendSessionCDP(source.tabId, sessionId, "DOM.enable", {}).catch(()=>{});
      sendSessionCDP(source.tabId, sessionId, "Accessibility.enable", {}).catch(()=>{});
    }
    return;
  }
  if (method === "Target.detachedFromTarget") {
    if (params.sessionId) {
      STATE.childSessions.delete(params.sessionId);
      // Reject any pending promises for this detached session to prevent memory leaks/hangs
      for (const [id, msg] of pendingSessionMessages.entries()) {
        if (msg.sessionId === params.sessionId) {
          msg.reject(new Error("Target detached before message could be processed"));
          pendingSessionMessages.delete(id);
        }
      }
    }
    return;
  }
  if (method === "Target.receivedMessageFromTarget") {
    try {
      const msg = JSON.parse(params.message);
      if (msg.id && pendingSessionMessages.has(msg.id)) {
        if (msg.error) pendingSessionMessages.get(msg.id).reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else pendingSessionMessages.get(msg.id).resolve(msg.result);
        pendingSessionMessages.delete(msg.id);
      }
    } catch (_) {}
    return;
  }

  // Re-inject the cursor immediately on frame navigations and document updates
  if (method === "DOM.documentUpdated" || method === "Page.frameNavigated") {
    if (STATE.lastX !== null && STATE.lastX !== undefined) {
      showAgentCursor(source.tabId, STATE.lastX, STATE.lastY).catch(() => {});
    }
  }

  // Native JS dialogs (alert / confirm / prompt / beforeunload) completely freeze
  // CDP communication — no commands are processed until the dialog is dismissed.
  // We MUST auto-dismiss immediately; waiting for the agent would cause a deadlock
  // where every subsequent CDP call (screenshot, script, etc.) silently hangs.
  //
  // Strategy by type:
  //   alert   → accept:true  (OK — the only meaningful action)
  //   confirm → accept:true  (default Yes — safer for automation; agent can work around)
  //   prompt  → accept:true, promptText:""  (accept with empty; agent re-types if needed)
  //   beforeunload → accept:true  (allow navigation to proceed)
  //
  // The dialog message is stored in STATE.lastDialog so the next snapshot surfaces
  // it to the LLM as a history entry, giving it full visibility of what the page said.
  if (method === "Page.javascriptDialogOpening") {
    const dialogType    = params.type    || "alert";
    const dialogMessage = params.message || "";
    STATE.lastDialog = { type: dialogType, message: dialogMessage, url: params.url || "", ts: Date.now() };
    const dismissArgs = { accept: true };
    if (dialogType === "prompt") dismissArgs.promptText = params.defaultPrompt || "";
    sendCDP(source.tabId, "Page.handleJavaScriptDialog", dismissArgs).catch(() => {});
    return;
  }

  if (method === "Network.requestWillBeSent") {
    // Only track XHR, Fetch, Document, and Script resource types to avoid getting clogged by media/images
    if (["XHR", "Fetch", "Document", "Script"].includes(params.type)) {
      STATE.inFlightRequests.add(params.requestId);
    }
  } else if (
    method === "Network.loadingFinished" ||
    method === "Network.loadingFailed"
  ) {
    STATE.inFlightRequests.delete(params.requestId);
  }
});

function broadcastStatus(evt) {
  for (const port of STATE.panelClients) {
    try {
      port.postMessage(evt);
    } catch (_) {
      STATE.panelClients.delete(port);
    }
  }
}

async function handlePanelMessage(msg, port) {
  switch (msg.type) {
    case "panel_init":
    case "panel_tab_active":
      port.windowId = msg.windowId;
      port.tabId = msg.tabId;
      break;
    case "classify_intent": {
      // If a task is already attached, always use the known-good attached tab; reject mismatched callers
      const ciTabId = STATE.attachedTabId || msg.tabId;
      classifyAndRoute(msg.goal, ciTabId, msg.autoApprove || false, msg.attachedImages || []).catch(err => {
        console.error("Failed in classifyAndRoute:", err);
        broadcastStatus({ event: "error", message: `Classification failed: ${err.message || err}` });
      });
      break;
    }
    case "start_task": {
      const stTabId = STATE.attachedTabId || msg.tabId;
      startTask(msg.goal, stTabId, msg.autoApprove || false, msg.attachedImages || []).catch(err => {
        console.error("Failed in startTask:", err);
      });
      break;
    }
    case "cancel_task":
      panicStop("user cancelled from panel");
      break;
    case "focus_task_tab":
      if (STATE.attachedTabId) {
        chrome.tabs.update(STATE.attachedTabId, { active: true }).catch(() => {});
        chrome.tabs.get(STATE.attachedTabId).then((tab) => {
          if (tab && tab.windowId) {
            chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
          }
        }).catch(() => {});
      }
      break;
    case "update_config":
      console.log("Config update event received from panel UI.");
      break;
    case "update_autoApprove":
      STATE.autoApprove = !!msg.autoApprove;
      break;
    case "update_autoApproveTypes":
      STATE.autoApproveTypes = Array.isArray(msg.types) ? msg.types : [];
      break;
    case "confirm_response":
      if (STATE.activeConfirmResolver && STATE.activeConfirmResolver.rid === msg.payload.rid) {
        // If the user checked "Trust for session", remember it for this domain + action type
        if (msg.payload.trust && msg.payload.actionType && STATE.attachedTabId) {
          chrome.tabs.get(STATE.attachedTabId).then(tab => {
            try {
              const trustKey = `${new URL(tab.url).hostname}:${msg.payload.actionType}`;
              STATE.sessionTrustedActions.add(trustKey);
              console.log(`[trust] Session trust added: ${trustKey}`);
            } catch (_) {}
          }).catch(() => {});
        }
        STATE.activeConfirmResolver.resolve(msg.payload.ok);
        STATE.activeConfirmResolver = null;
      }
      break;
    case "answer_response":
      if (STATE.activeAnswerResolver && STATE.activeAnswerResolver.rid === msg.payload.rid) {
        // Panel sends the reply as `answer`; accept legacy `text` too and always
        // deliver a string — an undefined here crashed the agent run loop.
        STATE.activeAnswerResolver.resolve(String(msg.payload.answer ?? msg.payload.text ?? ""));
        STATE.activeAnswerResolver = null;
      }
      break;
    case "clear_task":
      await chrome.storage.local.remove("lastActiveTaskState");
      await clearActiveTaskState();
      await clearSessionConversation();
      break;
  }
}

// -- Session memory -----------------------------------------------------------
// Tasks are stored in chrome.storage.local so they survive browser restarts.
// We keep the last 20 records; each is a compact summary, not raw history.

const SESSION_STORAGE_KEY = "navyTaskHistory";
const SESSION_MAX_RECORDS = 20;
const CROSS_TASK_MEMORY_KEY = "navyCrossTaskMemory";
const CROSS_TASK_MEMORY_MAX_MESSAGES = 30;

async function saveTaskRecord(goal, result) {
  try {
    const { navyTaskHistory = [] } = await chrome.storage.local.get(SESSION_STORAGE_KEY);
    const record = {
      ts:     Math.floor(Date.now() / 1000),
      goal:   goal.substring(0, 200),
      ok:     result.success,
      summary: (result.summary || result.reason || "").substring(0, 300),
      answer:  result.finalAnswer ? result.finalAnswer.substring(0, 400) : null,
      url:     result.url || null,
      steps:   result.stepsTaken || 0,
    };
    navyTaskHistory.push(record);
    // Keep only the most recent records
    if (navyTaskHistory.length > SESSION_MAX_RECORDS) {
      navyTaskHistory.splice(0, navyTaskHistory.length - SESSION_MAX_RECORDS);
    }
    await chrome.storage.local.set({ [SESSION_STORAGE_KEY]: navyTaskHistory });
  } catch (e) {
    console.warn("saveTaskRecord failed:", e);
  }
}

async function loadSessionContext() {
  try {
    const { navyTaskHistory = [] } = await chrome.storage.local.get(SESSION_STORAGE_KEY);
    if (navyTaskHistory.length === 0) return null;

    const now = Math.floor(Date.now() / 1000);
    // Build a compact summary of up to the last 8 tasks
    const recent = navyTaskHistory.slice(-8).map(r => {
      const agoSec = now - r.ts;
      const agoStr = agoSec < 60 ? "just now"
        : agoSec < 3600 ? `${Math.round(agoSec / 60)}m ago`
        : agoSec < 86400 ? `${Math.round(agoSec / 3600)}h ago`
        : `${Math.round(agoSec / 86400)}d ago`;
      const status = r.ok ? "✓" : "✗";
      const answer = r.answer ? ` → "${r.answer.substring(0, 120)}"` : "";
      return `  [${agoStr}] ${status} "${r.goal}"${answer}`;
    });

    return `<SESSION_CONTEXT>\nRecent tasks this session — you may reference these findings:\n${recent.join("\n")}\n</SESSION_CONTEXT>`;
  } catch (e) {
    return null;
  }
}

async function clearActiveTaskState() {
  try {
    const { activeTaskState } = await chrome.storage.local.get("activeTaskState");
    if (activeTaskState) {
      await chrome.storage.local.set({ lastActiveTaskState: activeTaskState });
    }
    // Mark the task as ENDED before removing it. resumeTaskIfNeeded() refuses to resume
    // while this flag is set, so a straggling end-of-step save that lands AFTER this
    // clear (an in-flight write racing the stop) can no longer resurrect the task on the
    // next service-worker wake. startTask/resumeTask clear the flag for a real new task.
    await chrome.storage.local.set({ taskStopped: true });
    await chrome.storage.local.remove("activeTaskState");
    await resetAllSidePanels();
  } catch (e) {
    console.warn("Failed to clear active task state:", e);
  }
}

async function saveActiveTaskState(goal, tabId, autoApprove, attachedImages = []) {
  try {
    // A real task is starting — lift the "stopped" guard so a genuine service-worker
    // kill mid-task can still be resumed. (Only set here and in resumeTask, i.e. only
    // on an explicit user-initiated run.)
    await chrome.storage.local.set({ taskStopped: false });
    await chrome.storage.local.set({
      activeTaskState: {
        userGoal: goal,
        attachedTabId: tabId,
        autoApprove: autoApprove || false,
        attachedImages,
        startedAt: Date.now(),
        taskId: "active_task",
        stepNum: 0,
      }
    });
  } catch (e) {
    console.warn("Failed to save active task state:", e);
  }
}

async function clearSessionConversation() {
  STATE.sessionConversationMessages = [];
  clearCrossTaskMemory().catch(() => {});
}


async function loadCrossTaskMemory() {
  try {
    const { navyCrossTaskMemory = [] } = await chrome.storage.local.get(CROSS_TASK_MEMORY_KEY);
    STATE.sessionConversationMessages = Array.isArray(navyCrossTaskMemory) ? navyCrossTaskMemory : [];
  } catch (_) {
    STATE.sessionConversationMessages = [];
  }
}

async function saveCrossTaskMemory() {
  try {
    let msgs = STATE.sessionConversationMessages || [];
    if (msgs.length > CROSS_TASK_MEMORY_MAX_MESSAGES) {
      msgs = msgs.slice(-CROSS_TASK_MEMORY_MAX_MESSAGES);
    }
    await chrome.storage.local.set({ [CROSS_TASK_MEMORY_KEY]: msgs });
  } catch (_) {}
}

async function appendCrossTaskMemory(role, text, images = null) {
  const content = images && images.length > 0
    ? [{ type: "text", text }, ...images.map(b64 => ({ type: "image_url", image_url: { url: b64 }, is_user_upload: true }))]
    : [{ type: "text", text }];
  STATE.sessionConversationMessages.push({ role, content });
  await saveCrossTaskMemory();
}

async function clearCrossTaskMemory() {
  STATE.sessionConversationMessages = [];
  try { await chrome.storage.local.remove(CROSS_TASK_MEMORY_KEY); } catch (_) {}
}

// Shared agent callback factory — avoids duplicating ~60 lines across startTask and resumeTask.
// myGen must match _taskGen at call time for the cancelCheck to work correctly.
function makeAgentCallbacks(myGen) {
  return {
    userConfirm: async (prompt, targetUrl, mustConfirm = false, actionType = null) => {
      // Non-mustConfirm path: global auto-approve covers everything
      if (!mustConfirm && STATE.autoApprove) return true;
      // mustConfirm=true normally requires explicit user input, BUT: if the user has
      // explicitly enabled auto-approval for this specific action type in Settings,
      // that deliberate choice takes precedence.  mustConfirm was designed to block
      // silent system-level auto-approve, not to override the user's own configuration.
      if (actionType && isActionAutoApproved(actionType)) return true;
      const rid = Math.random().toString(36).substring(2, 14);
      broadcastStatus({ event: "confirm_request", rid, prompt, targetUrl: targetUrl || null });
      return new Promise((resolve) => {
        STATE.activeConfirmResolver = { rid, resolve };
      });
    },

    verifyConfirm: async (observation, verified, shouldPause, actionType) => {
      if (STATE.autoApprove) return true;
      if (actionType && isActionAutoApproved(actionType)) return true;
      if (!shouldPause) return true;

      if (CONFIRM_ALWAYS.has(actionType) && !NEVER_SESSION_TRUST.has(actionType) && STATE.attachedTabId) {
        try {
          const trustTab = await chrome.tabs.get(STATE.attachedTabId);
          const trustKey = `${new URL(trustTab.url).hostname}:${actionType}`;
          if (STATE.sessionTrustedActions.has(trustKey)) return true;
        } catch (_) {}
      }

      const rid = Math.random().toString(36).substring(2, 14);
      const prompt = verified
        ? `Step result: ${observation}\n\nContinue to the next step?`
        : `⚠ Verification issue: ${observation}\n\nContinue anyway?`;
      broadcastStatus({ event: "verify_request", rid, observation, verified, prompt, actionType });
      return new Promise((resolve) => {
        STATE.activeConfirmResolver = { rid, resolve };
      });
    },

    onStreamToken: (chunk, step) => {
      // Drop tokens once the task is cancelled/superseded. The LLM stream that is
      // already in flight keeps firing chunks after panicStop; without this guard they
      // render as a fresh "Thinking" block in the panel AFTER the cancel/PANIC message.
      if (STATE.cancelled || myGen !== _taskGen) return;
      broadcastStatus({ event: "stream_token", text: chunk, step });
    },

    userAnswer: async (question) => {
      const rid = Math.random().toString(36).substring(2, 14);
      broadcastStatus({ event: "answer_request", rid, question });
      return new Promise((resolve) => {
        STATE.activeAnswerResolver = { rid, resolve };
      });
    },

    cancelCheck: () => STATE.cancelled || myGen !== _taskGen,

    progressCb: async (progress) => {
      STATE.lastProgress = progress;
      broadcastStatus({
        event: "progress",
        step: progress.step,
        thought: progress.thought,
        tokens_used: progress.tokensUsed,
        tokens_max: progress.tokensMax,
        kind: progress.kind || "think",
        steps_max: progress.stepsMax,
        active_subtask_idx: progress.activeSubtaskIdx,
        subtasks_len: progress.subtasksLen
      });
    }
  };
}

async function resumeTask(activeTaskState) {
  if (STATE.running) {
    console.warn("Cannot resume task: a task is already running.");
    return;
  }

  const myGen = ++_taskGen;
  const { userGoal, attachedTabId, autoApprove } = activeTaskState;

  // This resume is now the live task — lift the "stopped" guard (resumeTaskIfNeeded
  // already refused to get here if the task had been explicitly stopped).
  chrome.storage.local.set({ taskStopped: false }).catch(() => {});

  STATE.goal = userGoal;
  STATE.running = true;
  STATE.cancelled = false;
  STATE.inFlightRequests.clear();
  STATE.lastX = null;
  STATE.lastY = null;
  startTaskKeepalive();
  setBadge("ON", "#1f8b4c");

  STATE.attachedTabId = attachedTabId;
  try {
    await attachDebugger(attachedTabId);
    try {
      const tabObj = await chrome.tabs.get(attachedTabId);
      STATE.navyWindowId = tabObj.windowId;
      if (tabObj.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
        STATE.tabGroupId = tabObj.groupId;
      } else {
        // Re-establish the Navy tab group on resume so new_tab auto-grouping keeps working
        await isolateAndGroupTab(attachedTabId);
      }
    } catch (_) {}
    await startTabBlink(attachedTabId);
    startWatchdog(attachedTabId);
  } catch (e) {
    STATE.running = false;
    stopTaskKeepalive();
    STATE.goal = null;
    setBadge("", "#444");
    broadcastStatus({
      event: "error",
      message: `failed to attach debugger to tab on resume: ${e.message || e}`,
    });
    await clearActiveTaskState();
    return;
  }

  broadcastStatus({ event: "started", goal: userGoal, isResume: true, attachedTabId: STATE.attachedTabId, tabGroupId: STATE.tabGroupId });

  const settings = await chrome.storage.local.get({
    provider:          "ollama",
    baseUrl:           "http://127.0.0.1:11434/v1",
    apiKey:            "",
    anthropicKey:      "",
    model:             "minicpm-v:8b",
    temperature:       0.2,
    maxOutputTokens:   4096,
    maxSteps:          100,
    uncensored:        false,
    thinking:          false,
    allowlist:         [],
    autoApproveTypes:  [],
  });
  STATE.autoApproveTypes = settings.autoApproveTypes || [];

  const llm = new LocalLLM({
    provider:    settings.provider,
    baseUrl:     settings.baseUrl,
    model:       settings.model,
    temperature: settings.temperature,
    maxTokens:   settings.maxOutputTokens || 4096,
    apiKey:      settings.apiKey || settings.anthropicKey,
    jsonMode:    true,
    uncensored:  settings.uncensored,
    thinking:    settings.thinking,
  });

  const policy = new DomainPolicy({
    uncensored: settings.uncensored,
    allowlist: settings.allowlist || []
  });

  const budget = {
    maxSteps: settings.maxSteps || 100,
    maxTokens: 2000000,
    maxWallSeconds: 3600
  };

  const snapshotter = async (forceFresh) => {
    if (!STATE.attachedTabId) throw cancellationError();
    const state = await takeSnapshot(STATE.attachedTabId, forceFresh);
    STATE.lastElementMap = {};
    if (Array.isArray(state.element_map)) {
      for (const el of state.element_map) STATE.lastElementMap[el.id] = el;
    }
    if (state.screenshot_b64) {
      const mime = state.screenshot_mime || "image/jpeg";
      const dataUrl = `data:${mime};base64,${state.screenshot_b64}`;
      try { chrome.storage.session.set({ lastScreenshot: dataUrl }).catch(() => {}); } catch (_) {}
      console.log("[BG] screenshot_ready → clients:", STATE.panelClients.size, "b64 len:", state.screenshot_b64.length);
      broadcastStatus({ event: "screenshot_ready", lastScreenshot: dataUrl });
    } else {
      console.log("[BG] snapshot returned no screenshot_b64 (startTask)");
    }
    return state;
  };

  const executor = async (step) => {
    const actionType = (step?.action?.type || step?.type || '');
    // wait/wait_for/listen manage their own timeouts; let them run unconstrained
    if (actionType === 'wait' || actionType === 'wait_for' || actionType === 'listen') {
      return await executeStep(STATE.attachedTabId, step);
    }
    const timeoutMs = actionType === 'navigate' ? 35000
      : actionType === 'type' ? 25000
      : (actionType === 'script' || actionType === 'fetch') ? 20000
      : actionType === 'batch' ? 60000
      : 15000;
    // Capture canvas pixel hash before action — lets us detect visual changes
    // on canvas-heavy pages where DOM mutations never fire (games, VNC, etc.)
    const preCanvasHash = await getCanvasHashes(STATE.attachedTabId);
    let result;
    try {
      result = await withTimeout(
        executeStep(STATE.attachedTabId, step),
        timeoutMs,
        `action '${actionType}' timed out after ${timeoutMs / 1000}s — page may be frozen`
      );
    } catch (err) {
      if (String(err).includes('timed out')) {
        return { success: false, error: String(err), page_changed: false };
      }
      throw err;
    }
    // If DOM reported no change but canvas pixels changed, the action still had effect.
    // Spread into a new object rather than mutating result — some action return values
    // are non-extensible (CDP response objects, frozen error results) and strict-mode
    // property assignment on them throws a TypeError.
    if (result && !result.page_changed && preCanvasHash) {
      const postCanvasHash = await getCanvasHashes(STATE.attachedTabId);
      if (postCanvasHash && postCanvasHash !== preCanvasHash) {
        result = { ...result, page_changed: true, canvas_changed: true };
      }
    }
    return result;
  };

  const origin = (() => { try { return new URL(tab.url).origin; } catch (_) { return "_"; } })();
  const agent = new Agent(llm, policy, budget, snapshotter, executor, { ...makeAgentCallbacks(myGen), autoApprove: STATE.autoApprove, origin });

  STATE.activeAgent = agent;

  const sessionContext = await loadSessionContext();

  try {
    const result = await agent.run(userGoal, {
      sessionContext,
      sessionConversationMessages: STATE.sessionConversationMessages,
      resumeState: activeTaskState,
      attachedTabId,
      autoApprove,
      attachedImages: activeTaskState.attachedImages || []
    });
    broadcastStatus({ event: "done", result });
    await saveTaskRecord(userGoal, result);
  } catch (err) {
    console.error("Agent execution error on resume:", err);
    try {
      await AuditLogger.record({
        event: "crash",
        taskId: activeTaskState.taskId || "active_task",
        step: activeTaskState.stepNum || 0,
        url: STATE.lastUrl,
        extra: { error: err.message || String(err), stack: err.stack || "" }
      });
    } catch (_) {}
    broadcastStatus({ event: "error", message: `Agent resume run error: ${err.message || err}` });
  } finally {
    if (_taskGen !== myGen) return;
    if (watchdogInterval) {
      clearInterval(watchdogInterval);
      watchdogInterval = null;
    }
    STATE.running = false;
    stopTaskKeepalive();
    STATE.tabGroupId = null;
    STATE.navyWindowId = null;
    STATE.activeAgent = null;
    abortPendingDialogs();
    await stopTabBlink(STATE.attachedTabId);
    await detachDebugger();
    setBadge("", "#444");
    broadcastStatus({ event: "closed" });
    await clearActiveTaskState();
  }
}

async function resumeTaskIfNeeded() {
  try {
    const { activeTaskState, taskStopped } = await chrome.storage.local.get(["activeTaskState", "taskStopped"]);
    if (!activeTaskState) {
      return;
    }
    // The task was explicitly stopped/finished — never auto-resume it. This is the guard
    // that stops a "zombie" task from re-attaching the debugger and acting on its own
    // after the user pressed stop (a straggling save can leave activeTaskState behind).
    if (taskStopped) {
      console.log("[agent] activeTaskState found but task was stopped — discarding, not resuming.");
      await chrome.storage.local.remove("activeTaskState");
      return;
    }

    console.log("Found suspended task state. Attempting to resume...", activeTaskState);
    
    const { attachedTabId } = activeTaskState;
    if (!attachedTabId) {
      console.warn("No attachedTabId found in activeTaskState. Cannot resume.");
      await clearActiveTaskState();
      return;
    }
    
    // Check if the tab still exists
    try {
      await chrome.tabs.get(attachedTabId);
    } catch (tabErr) {
      console.warn(`Tab ${attachedTabId} no longer exists. Cannot resume.`, tabErr);
      await clearActiveTaskState();
      return;
    }
    
    // Resume task execution
    resumeTask(activeTaskState).catch(err => {
      console.error("Failed to resume task:", err);
    });
  } catch (e) {
    console.error("Error in resumeTaskIfNeeded:", e);
  }
}

function isContinuationPrompt(goal) {
  if (!goal) return false;
  const normalized = goal.trim().toLowerCase();
  const patterns = [
    /^continue\b/i,
    /^keep\s+going\b/i,
    /^resume\b/i,
    /^go\s+ahead\b/i,
    /^carry\s+on\b/i,
    /^next\s+step\b/i,
    /^please\s+continue\b/i
  ];
  return patterns.some(p => p.test(normalized));
}

function extractContinuationInstruction(goal) {
  if (!goal) return "";
  const normalized = goal.trim();
  const prefixes = [
    /^please\s+continue\s+(?:with|and|to)?\s*/i,
    /^continue\s+(?:with|and|to)?\s*/i,
    /^keep\s+going\s+(?:with|and|to)?\s*/i,
    /^resume\s+(?:with|and|to)?\s*/i,
    /^go\s+ahead\s+(?:with|and|to)?\s*/i,
    /^carry\s+on\s+(?:with|and|to)?\s*/i
  ];
  for (const regex of prefixes) {
    if (regex.test(normalized)) {
      return normalized.replace(regex, "").trim();
    }
  }
  return "";
}

// -- Intent classification ----------------------------------------------------
// Lightweight LLM call to determine if user wants a chat response or browser action.
// Chat messages get an instant AI reply; action messages start the full agent loop.

let _classifyInFlight = false;

async function classifyAndRoute(goal, tabId, autoApprove = false, attachedImages = []) {
  if (_classifyInFlight) {
    console.warn("[agent] classifyAndRoute already in flight — ignoring duplicate call");
    return;
  }
  _classifyInFlight = true;
  try {
    return await _classifyAndRouteInner(goal, tabId, autoApprove, attachedImages);
  } finally {
    _classifyInFlight = false;
  }
}

async function _classifyAndRouteInner(goal, tabId, autoApprove = false, attachedImages = []) {
  // Check if this is a continuation prompt
  if (isContinuationPrompt(goal)) {
    try {
      const { lastActiveTaskState } = await chrome.storage.local.get("lastActiveTaskState");
      if (lastActiveTaskState) {
        let tabExists = false;
        try {
          if (lastActiveTaskState.attachedTabId) {
            await chrome.tabs.get(lastActiveTaskState.attachedTabId);
            tabExists = true;
          }
        } catch (tabErr) {
          console.warn("[agent] Tab for continuation does not exist:", tabErr);
        }

        if (tabExists) {
          const extraInstruction = extractContinuationInstruction(goal);
          let newGoal = lastActiveTaskState.userGoal;
          
          // Remove any existing (continued) suffix before appending a new one to prevent accumulation
          newGoal = newGoal.replace(/\s*\(continued:.*?\)/g, "").replace(/\s*\(continued\)/g, "");

          if (extraInstruction) {
            newGoal = `${newGoal} (continued: ${extraInstruction})`;
          } else {
            newGoal = `${newGoal} (continued)`;
          }

          console.log(`[agent] Continuation detected. Resuming task with goal: "${newGoal}"`);
          
          lastActiveTaskState.userGoal = newGoal;
          lastActiveTaskState.attachedTabId = tabId || lastActiveTaskState.attachedTabId;
          lastActiveTaskState.autoApprove = autoApprove;
          lastActiveTaskState.stepNum = 0; // Reset step count for continuation run

          broadcastStatus({ event: "action_confirmed", goal: newGoal });
          await resumeTask(lastActiveTaskState);
          return;
        }
      }
    } catch (err) {
      console.warn("[agent] Failed during continuation check, falling back to classification:", err);
    }
  }

  // Get LLM settings
  const settings = await chrome.storage.local.get({
    provider:     "ollama",
    baseUrl:      "http://127.0.0.1:11434/v1",
    apiKey:       "",
    anthropicKey: "",
    model:        "minicpm-v:8b",
    temperature:  0.2,
    uncensored:   false,
    thinking:     false,
  });

  const llm = new LocalLLM({
    provider:    settings.provider,
    baseUrl:     settings.baseUrl,
    model:       settings.model,
    temperature: settings.temperature,
    apiKey:      settings.apiKey || settings.anthropicKey,
    jsonMode:    true,
    uncensored:  settings.uncensored,
    thinking:    false,  // No thinking needed for classification
  });

  broadcastStatus({ event: "classifying", goal });

  try {
    const result = await llm.classify(goal, STATE.sessionConversationMessages, attachedImages);

    if (result.intent === "chat") {
      // If the reply looks like a refusal, route to the agent instead of showing it.
      // The agent loop has proper refusal detection and retry logic.
      const replyLo = (result.reply || "").toLowerCase();
      const isRefusalReply = ["i cannot", "i can't", "i'm not able", "i am not able",
        "i'm unable", "i am unable", "cannot assist", "not able to assist",
        "fulfill your request", "not designed to"].some(p => replyLo.includes(p));

      if (!isRefusalReply) {
        let userContent = [{ type: "text", text: `<USER_GOAL>\n${goal}\n</USER_GOAL>` }];
        if (attachedImages && attachedImages.length > 0) {
          for (const b64 of attachedImages) {
            userContent.push({ type: "image_url", image_url: { url: b64 }, is_user_upload: true });
          }
        }
        // Save this turn to conversationMessages
        STATE.sessionConversationMessages.push({ role: "user", content: userContent });
        STATE.sessionConversationMessages.push({ role: "assistant", content: [{ type: "text", text: result.reply }] });

        // Limit size
        const maxHistoryMessages = 41;
        if (STATE.sessionConversationMessages.length > maxHistoryMessages) {
          STATE.sessionConversationMessages.splice(0, STATE.sessionConversationMessages.length - maxHistoryMessages);
        }

        // Return the conversational reply directly — no debugger, no screenshot
        broadcastStatus({ event: "chat_response", reply: result.reply, goal });
        return;
      }
      // Refusal reply — fall through to the full agent loop below
    }
  } catch (e) {
    console.warn("[agent] Intent classification failed, proceeding as action:", e);
    // Fall through to startTask on error
  }

  // Intent is "action" (or classification failed) — start the full agent loop
  broadcastStatus({ event: "action_confirmed", goal });
  await startTask(goal, tabId, autoApprove, attachedImages);
}

// -- Task lifecycle -----------------------------------------------------------

async function isolateAndGroupTab(tabId) {
  try {
    let tab = await chrome.tabs.get(tabId);
    STATE.navyWindowId = tab.windowId;

    console.log(`[agent] Grouping tab ${tabId} under "Navy Task" in the current window`);
    let groupId = tab.groupId;
    if (groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
      groupId = await chrome.tabs.group({ tabIds: [tab.id] });
      await chrome.tabGroups.update(groupId, { title: "Navy Task", color: "blue" });
    }
    STATE.tabGroupId = groupId;
    // Small delay to let Chrome finish any pending tab state transitions
    // (e.g. side panel opening) before we iterate all tabs to update options.
    await sleep(150);
    await updateAllSidePanels();
  } catch (err) {
    console.error("[agent] Failed to group tab:", err);
  }
}

async function startTask(goal, tabId, autoApprove = false, attachedImages = []) {
  if (STATE.running) {
    broadcastStatus({ event: "error", message: "task already running" });
    return;
  }
  const myGen = ++_taskGen; // claim ownership — if this changes we've been superseded
  STATE.autoApprove = autoApprove;

  // Set attachedTabId early to prevent side panel auto-closing during setup
  STATE.attachedTabId = tabId;

  try {
    await isolateAndGroupTab(tabId);
    let tab = await chrome.tabs.get(tabId);
    if (isRestrictedUrl(tab.url)) {
      // Chrome blocks debugger on internal pages (chrome://, newtab, etc.).
      // Auto-navigate to a real page so the agent can start immediately.
      broadcastStatus({ event: "progress", step: 0, thought: "restricted tab — opening a blank page to start…", kind: "think" });
      await chrome.tabs.update(tabId, { url: "about:blank" });
      await waitForLoad(tabId);
      tab = await chrome.tabs.get(tabId);
    }
  } catch (err) {
    console.error("[agent] Failed task startup sequence:", err);
    STATE.attachedTabId = null;
    broadcastStatus({ event: "error", message: `Failed to initialize task: ${err.message || err}` });
    return;
  }

  STATE.goal = goal;
  STATE.running = true;
  STATE.cancelled = false;
  STATE.inFlightRequests.clear();
  STATE.lastX = null;
  STATE.lastY = null;
  startTaskKeepalive();
  setBadge("ON", "#1f8b4c");

  try {
    await attachDebugger(tabId);
    await startTabBlink(tabId);
    startWatchdog(tabId);
  } catch (e) {
    // Some non-scriptable pages aren't caught by the URL prefix check (Edge's
    // new-tab variants resolve to an MSN/NTP or add-ons-gallery URL; uncommitted
    // URLs; the web store). If the attach failed specifically because the page
    // can't be scripted, fall back to a blank page and retry once — the task's own
    // navigate step takes it from there. Transient errors on a REAL page do NOT
    // match this, so we never destroy the user's page over a temporary hiccup.
    const emsg = String(e && e.message || e);
    const nonScriptable = /cannot be scripted|extensions gallery|cannot access|chrome-untrusted|devtools/i.test(emsg);
    if (nonScriptable) {
      try {
        broadcastStatus({ event: "progress", step: 0, thought: "this page can't be automated — opening a blank page to start…", kind: "think" });
        await detachDebugger().catch(() => {});
        await chrome.tabs.update(tabId, { url: "about:blank" });
        await waitForLoad(tabId);
        await attachDebugger(tabId);
        STATE.attachedTabId = tabId;
        await startTabBlink(tabId);
        startWatchdog(tabId);
      } catch (e2) {
        STATE.running = false;
        stopTaskKeepalive();
        STATE.goal = null;
        setBadge("", "#444");
        broadcastStatus({
          event: "error",
          message: `failed to attach debugger to tab: ${e2.message || e2}. Try a different tab.`,
        });
        return;
      }
    } else {
      STATE.running = false;
      stopTaskKeepalive();
      STATE.goal = null;
      setBadge("", "#444");
      broadcastStatus({
        event: "error",
        message: `failed to attach debugger to tab: ${emsg}. Try a different tab.`,
      });
      return;
    }
  }

  broadcastStatus({ event: "started", goal, attachedTabId: STATE.attachedTabId, tabGroupId: STATE.tabGroupId });

  // Persist task state so it can be resumed if the service worker is killed by Chrome.
  await saveActiveTaskState(goal, tabId, autoApprove, attachedImages);

  // Get active settings from local storage
  const settings = await chrome.storage.local.get({
    provider:         "ollama",
    baseUrl:          "http://127.0.0.1:11434/v1",
    apiKey:           "",
    anthropicKey:     "",
    model:            "minicpm-v:8b",
    temperature:      0.2,
    maxOutputTokens:  4096,
    maxSteps:         100,
    uncensored:       false,
    thinking:         false,
    allowlist:        [],
    autoApproveTypes: [],
  });
  STATE.autoApproveTypes = settings.autoApproveTypes || [];

  // Instantiate LLM client
  const llm = new LocalLLM({
    provider:    settings.provider,
    baseUrl:     settings.baseUrl,
    model:       settings.model,
    temperature: settings.temperature,
    maxTokens:   settings.maxOutputTokens || 4096,
    apiKey:      settings.apiKey || settings.anthropicKey,
    jsonMode:    true,
    uncensored:  settings.uncensored,
    thinking:    settings.thinking,
  });

  // Instantiate Domain Policy
  const policy = new DomainPolicy({
    uncensored: settings.uncensored,
    allowlist: settings.allowlist || []
  });

  // Budget
  const budget = {
    maxSteps: settings.maxSteps || 100,
    maxTokens: 2000000,
    maxWallSeconds: 3600
  };

  // Snapshotter & Executor callbacks
  const snapshotter = async (forceFresh) => {
    if (!STATE.attachedTabId) throw cancellationError();
    const state = await takeSnapshot(STATE.attachedTabId, forceFresh);
    // Cache element map so coordinates can be resolved
    STATE.lastElementMap = {};
    if (Array.isArray(state.element_map)) {
      for (const el of state.element_map) STATE.lastElementMap[el.id] = el;
    }
    // Set visual state
    if (state.screenshot_b64) {
      const mime = state.screenshot_mime || "image/jpeg";
      const dataUrl = `data:${mime};base64,${state.screenshot_b64}`;
      try { chrome.storage.session.set({ lastScreenshot: dataUrl }).catch(() => {}); } catch (_) {}
      console.log("[BG] screenshot_ready → clients:", STATE.panelClients.size, "b64 len:", state.screenshot_b64.length);
      broadcastStatus({ event: "screenshot_ready", lastScreenshot: dataUrl });
    } else {
      console.log("[BG] snapshot returned no screenshot_b64 (resumeTask)");
    }
    return state;
  };

  const executor = async (step) => {
    const actionType = (step?.action?.type || step?.type || '');
    // wait/wait_for/listen manage their own timeouts; let them run unconstrained
    if (actionType === 'wait' || actionType === 'wait_for' || actionType === 'listen') {
      return await executeStep(STATE.attachedTabId, step);
    }
    const timeoutMs = actionType === 'navigate' ? 35000
      : actionType === 'type' ? 25000
      : (actionType === 'script' || actionType === 'fetch') ? 20000
      : actionType === 'batch' ? 60000
      : 15000;
    // Capture canvas pixel hash before action — lets us detect visual changes
    // on canvas-heavy pages where DOM mutations never fire (games, VNC, etc.)
    const preCanvasHash = await getCanvasHashes(STATE.attachedTabId);
    let result;
    try {
      result = await withTimeout(
        executeStep(STATE.attachedTabId, step),
        timeoutMs,
        `action '${actionType}' timed out after ${timeoutMs / 1000}s — page may be frozen`
      );
    } catch (err) {
      if (String(err).includes('timed out')) {
        return { success: false, error: String(err), page_changed: false };
      }
      throw err;
    }
    // If DOM reported no change but canvas pixels changed, the action still had effect.
    // Spread into a new object rather than mutating result — some action return values
    // are non-extensible (CDP response objects, frozen error results) and strict-mode
    // property assignment on them throws a TypeError.
    if (result && !result.page_changed && preCanvasHash) {
      const postCanvasHash = await getCanvasHashes(STATE.attachedTabId);
      if (postCanvasHash && postCanvasHash !== preCanvasHash) {
        result = { ...result, page_changed: true, canvas_changed: true };
      }
    }
    return result;
  };

  // Instantiate native agent
  const resumeOrigin = (() => { try { return new URL(STATE.lastUrl || tab.url || "https://example.com").origin; } catch (_) { return "_"; } })();
  const agent = new Agent(llm, policy, budget, snapshotter, executor, { ...makeAgentCallbacks(myGen), autoApprove: STATE.autoApprove, origin: resumeOrigin });

  STATE.activeAgent = agent;

  // Load previous task context to give the agent session memory
  const sessionContext = await loadSessionContext();

  try {
    const result = await agent.run(goal, {
      sessionContext,
      sessionConversationMessages: STATE.sessionConversationMessages,
      attachedTabId: tabId,
      autoApprove: autoApprove,
      attachedImages: attachedImages
    });
    broadcastStatus({ event: "done", result });
    // Persist this task so future tasks can reference it
    await saveTaskRecord(goal, result);
    // Append the outcome to cross-task chat memory so the next request has context
    const outcomeText = result.success
      ? `Previous task completed successfully. Goal: "${goal}". Final page: ${STATE.lastTitle || "(unknown)"} at ${STATE.lastUrl || "(unknown)"}. Summary: ${result.summary || result.reason || "done"}.`
      : `Previous task failed or was stopped. Goal: "${goal}". Final page: ${STATE.lastTitle || "(unknown)"} at ${STATE.lastUrl || "(unknown)"}. Reason: ${result.reason || "stopped"}.`;
    await appendCrossTaskMemory("system", outcomeText);
  } catch (err) {
    console.error("Agent execution error:", err);
    try {
      await AuditLogger.record({
        event: "crash",
        taskId: STATE.goal ? "active_task" : "none",
        step: 0,
        url: STATE.lastUrl,
        extra: { error: err.message || String(err), stack: err.stack || "" }
      });
    } catch (_) {}
    broadcastStatus({ event: "error", message: `Agent run error: ${err.message || err}` });
    await appendCrossTaskMemory("system", `Previous task crashed. Goal: "${goal}". Error: ${err.message || err}.`);
  } finally {
    if (_taskGen !== myGen) return;
    if (watchdogInterval) {
      clearInterval(watchdogInterval);
      watchdogInterval = null;
    }
    STATE.running = false;
    stopTaskKeepalive();
    STATE.tabGroupId = null;
    STATE.navyWindowId = null;
    STATE.activeAgent = null;
    abortPendingDialogs();
    await stopTabBlink(STATE.attachedTabId);
    await detachDebugger();
    setBadge("", "#444");
    broadcastStatus({ event: "closed" });
    await clearActiveTaskState();
  }
}

// -- Screenshot helpers -------------------------------------------------------

let lastCaptureTime = 0;
const MIN_CAPTURE_INTERVAL_MS = 600;

async function safeCaptureVisibleTab(windowId, options = {}) {
  let attempt = 0;
  while (attempt < 4) {
    attempt++;
    const now = Date.now();
    const elapsed = now - lastCaptureTime;
    if (elapsed < MIN_CAPTURE_INTERVAL_MS) {
      await sleep(MIN_CAPTURE_INTERVAL_MS - elapsed);
    }
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, options);
      lastCaptureTime = Date.now();
      return dataUrl;
    } catch (err) {
      const isQuota = err.message && err.message.includes("quota");
      if (isQuota && attempt < 4) {
        console.warn(`[safeCaptureVisibleTab] Quota exceeded on attempt ${attempt}, waiting 1s before retry...`);
        await sleep(1000);
        continue;
      }
      throw err;
    }
  }
}

// Samples a 160×100 downsample of a data-URL JPEG to estimate blank/white ratio.
// Returns true when >threshold of sampled pixels are near-white (RGB > 240).
// Used to detect "first-paint race" screenshots where the GPU surface hasn't rendered yet.
async function isBlankScreenshot(dataUrl, threshold = 0.93) {
  try {
    const bitmap = await createImageBitmap(dataUrlToBlob(dataUrl));
    const sw = 160, sh = 100;
    const canvas = new OffscreenCanvas(sw, sh);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, sw, sh);
    bitmap.close();
    const data = ctx.getImageData(0, 0, sw, sh).data;
    const totalPx = sw * sh;
    const midRow  = Math.floor(sh / 2);
    const topPx   = sw * midRow;
    const botPx   = totalPx - topPx;
    let whiteAll = 0, whiteTop = 0, whiteBot = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240) {
        whiteAll++;
        if (Math.floor((i / 4) / sw) < midRow) whiteTop++; else whiteBot++;
      }
    }
    // Case 1: entire image near-white — page not yet painted or pure white page.
    if (whiteAll / totalPx > threshold) return true;
    // Case 2: top half is near-all-white while bottom half has visible content.
    // This pattern indicates a cross-origin iframe that the GPU compositor renders
    // as a white rectangle (fromSurface:true artifact). The fromSurface:false retry
    // re-renders through the DOM paint path and typically shows the iframe correctly.
    if (whiteTop / topPx > 0.92 && whiteBot / botPx < 0.5) return true;
    return false;
  } catch (_) {
    return false;
  }
}

// CDP Page.captureScreenshot — preferred over captureVisibleTab for three reasons:
//  1. Works regardless of whether the tab is the active/focused window.
//  2. Captures directly from the GPU compositor surface (more consistent with what
//     the page actually renders, including compositor effects).
//  3. No Chrome extension captureVisibleTab quota throttling.
//
// DPR handling: clip.scale = 1/DPR requests exactly one output pixel per CSS pixel.
// At scale=1 (the naive default), Chrome outputs DPR × CSS pixels — the same HiDPI
// bloat that captureVisibleTab produces. Using 1/DPR collapses the output back to
// CSS dimensions in a single pass with no re-encoding, eliminating double-JPEG loss.
// resizeScreenshotToLogical still runs as a safety net for the MAX_SCREENSHOT_W cap
// and for any platform where DPR detection fails.
// Returns { dataUrl, w, h } where w/h are the CSS viewport dimensions measured
// immediately before the capture — callers should use these instead of any
// earlier getViewportSize result to avoid the race where the panel resizes between
// the size query and the actual screenshot.
async function safeCaptureScreenshot(tabId, quality = 90) {
  const now = Date.now();
  const elapsed = now - lastCaptureTime;
  if (elapsed < MIN_CAPTURE_INTERVAL_MS) await sleep(MIN_CAPTURE_INTERVAL_MS - elapsed);
  try {
    // Re-query viewport size here, immediately before the capture, so the clip
    // dimensions are always fresh (eliminates the panel-resize race condition).
    const { w: logicalW, h: logicalH } = await getViewportSize(tabId);

    // Query DPR so we can request a CSS-scale screenshot.
    // clip.scale = 1/DPR collapses device pixels → CSS pixels in one pass.
    let dpr = 1;
    try {
      const r = await sendCDP(tabId, "Runtime.evaluate", {
        expression: "window.devicePixelRatio || 1",
        returnByValue: true,
      });
      const v = r?.result?.value;
      // Reject sub-unity values (browser zoomed out, e.g. 50% zoom → DPR=0.5).
      // A sub-unity DPR inverts clip.scale (1/0.5 = 2), producing a 2× upscaled
      // screenshot and halving all coordinate scale factors — clicks land at wrong positions.
      if (typeof v === "number" && v >= 1 && v <= 8) dpr = v;
    } catch (_) {}

    const captureH = logicalH;
    let scrollX = 0, scrollY = 0;
    try {
      const r = await sendCDP(tabId, "Runtime.evaluate", {
        expression: "({ x: Math.round(window.scrollX || 0), y: Math.round(window.scrollY || 0) })",
        returnByValue: true
      });
      if (r?.result?.value) {
        scrollX = r.result.value.x;
        scrollY = r.result.value.y;
      }
    } catch (_) {}

    const captureArgs = {
      format: "jpeg",
      quality,
      clip: {
        x: scrollX,
        y: scrollY,
        width: logicalW, height: captureH, scale: 1 / dpr
      },
      captureBeyondViewport: false,
      fromSurface: true,
    };

    let result = await sendCDP(tabId, "Page.captureScreenshot", captureArgs);
    lastCaptureTime = Date.now();
    if (!result?.data) throw new Error("no data");

    // Blank/white-screen detection — the GPU compositor surface can be white when
    // the screenshot races ahead of the page's first paint (heavy CSS-in-JS, SPA
    // hydration, slow network).  Retry once after a short delay with fromSurface:false
    // (reads the actual screen pixels) so the LLM always gets a meaningful image.
    const dataUrl = `data:image/jpeg;base64,${result.data}`;
    if (await isBlankScreenshot(dataUrl)) {
      await sleep(500);
      try {
        const retry = await sendCDP(tabId, "Page.captureScreenshot", {
          ...captureArgs,
          fromSurface: false,   // fall back to screen pixels on retry
        });
        if (retry?.data) {
          const retryUrl = `data:image/jpeg;base64,${retry.data}`;
          // Only use the retry if it's NOT also blank (page might genuinely be white)
          if (!(await isBlankScreenshot(retryUrl))) {
            return { dataUrl: retryUrl, w: logicalW, h: logicalH, captureH };
          }
        }
      } catch (_) {}
    }

    return { dataUrl, w: logicalW, h: logicalH, captureH };
  } catch (cdpErr) {
    // Debugger not attached or page navigating — fall back to extension API.
    // Log so transient CDP errors are visible in debug logs rather than silently dropped.
    console.warn("[safeCaptureScreenshot] CDP failed, falling back:", cdpErr?.message || cdpErr);
    // Re-query viewport size here too so the fallback path is also race-free.
    const { w: logicalW, h: logicalH } = await getViewportSize(tabId);
    try {
      const tab = await chrome.tabs.get(Number(tabId));
      // captureVisibleTab captures whichever tab is currently active in the window,
      // NOT necessarily tabId. If our tab is not active (e.g. user switched to a
      // different tab, or a navigation briefly left the old tab visible), we would
      // capture the wrong page. Activate our tab first to guarantee the right capture.
      if (!tab.active) {
        await chrome.tabs.update(Number(tabId), { active: true }).catch(() => {});
        await sleep(150);
      }
      const dataUrl = await safeCaptureVisibleTab(tab.windowId, { format: "jpeg", quality });
      return { dataUrl, w: logicalW, h: logicalH };
    } catch (e2) {
      throw e2;
    }
  }
}

// Lightweight tab-specific screenshot for the "dataUrlBefore" change-detection
// pattern. Prefers CDP Page.captureScreenshot (always captures the correct tab)
// over captureVisibleTab (captures whichever tab happens to be active).
// Returns a dataUrl string, or null if capture fails.
async function captureTabForDiff(tabId, windowId) {
  try {
    const result = await sendCDP(tabId, "Page.captureScreenshot", {
      format: "jpeg", quality: 60, fromSurface: true,
    });
    if (result?.data) return `data:image/jpeg;base64,${result.data}`;
  } catch (_) {}
  // CDP unavailable (page navigating, debugger just attached, etc.) — fall back
  // to the extension API, but ensure the correct tab is active first.
  try {
    const tab = await chrome.tabs.get(Number(tabId));
    if (!tab.active) {
      await chrome.tabs.update(Number(tabId), { active: true }).catch(() => {});
      await sleep(100);
    }
    return await safeCaptureVisibleTab(windowId, { format: "jpeg", quality: 60 });
  } catch (_) {
    return null;
  }
}

// captureVisibleTab — kept as fallback and for change-detection captures
// (dataUrlBefore pattern) where the tab is guaranteed active.
//
// Fix: always resize the screenshot to the logical (CSS) pixel dimensions of the
// viewport before storing or sending it anywhere.  OffscreenCanvas is available
// in Chrome service workers since Chrome 69.
// Resizes a raw device-pixel screenshot to CSS logical dimensions, then caps width at
// MAX_SCREENSHOT_W (1280px) for LLM cost reduction.  Returns { b64, scale } where
// scale = outW / logicalW — callers must divide raw LLM x,y coords by scale to get
// true CSS coordinates.
// Converts a data: URL to a Blob without using fetch() (fetch is blocked by
// connect-src CSP in the service worker context for data: scheme URLs).
function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(",");
  const meta  = dataUrl.slice(0, comma);
  const b64   = dataUrl.slice(comma + 1);
  const mime  = (meta.match(/:(.*?);/) || [])[1] || "image/jpeg";
  const byteStr = atob(b64);
  const ab = new ArrayBuffer(byteStr.length);
  const ia = new Uint8Array(ab);
  for (let i = 0; i < byteStr.length; i++) ia[i] = byteStr.charCodeAt(i);
  return new Blob([ab], { type: mime });
}

// Cap the screenshot width sent to the LLM. Set to 1568 to match the point where
// vision providers (e.g. Anthropic) resize an image's long edge server-side: sending
// wider means the model actually sees a downsized image Navy didn't account for, so
// screenshotScale under-reports the real downscale (breaking the adaptive cursor and
// coordinate legibility). Capping here makes "what Navy sent" == "what the model saw",
// keeps screenshotScale honest, and cuts tokens. Viewports narrower than this (the
// common panel-open case) are unaffected — they pass through at scale 1.0.
const MAX_SCREENSHOT_W = 1568;
async function resizeScreenshotToLogical(dataUrl) {
  try {
    const bitmap = await createImageBitmap(dataUrlToBlob(dataUrl));
    
    // Instead of forcing the image to logicalW x logicalH, respect its native aspect ratio.
    // The CDP screenshot already has `scale: 1/DPR`, so bitmap.width is the true logical width.
    const actualW = bitmap.width;
    const actualH = bitmap.height;
    
    // Cap width to per-model max long edge (fallback to MAX_SCREENSHOT_W)
    const maxLongEdge = STATE.maxScreenshotLongEdge || MAX_SCREENSHOT_W;
    const outW = actualW > maxLongEdge ? maxLongEdge : actualW;
    const outH = actualW > maxLongEdge ? Math.round(actualH * maxLongEdge / actualW) : actualH;
    
    // The mapping scale from actual logical CSS DOM coordinates to this output image
    const scale = outW / actualW;

    if (actualW === outW && actualH === outH) {
      bitmap.close();
      const comma = dataUrl.indexOf(",");
      const b64 = comma !== -1 ? dataUrl.slice(comma + 1) : dataUrl;
      return { b64, scale, outW, outH, actualH, actualW };
    }

    const canvas = new OffscreenCanvas(outW, outH);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, outW, outH);
    bitmap.close();
    const resizedBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
    const buf = await resizedBlob.arrayBuffer();
    const arr = new Uint8Array(buf);
    let b64 = "";
    for (let i = 0; i < arr.length; i += 8192) {
      b64 += String.fromCharCode(...arr.subarray(i, Math.min(i + 8192, arr.length)));
    }
    return { b64: btoa(b64), scale, outW, outH, actualH, actualW };
  } catch (_) {
    return null;
  }
}

// Crops a high-resolution 350x350 visual square centered around logical coords (cx, cy).
// Maps the logical coords to the image's raw device pixels using the device pixel ratio (DPR).
async function cropScreenshotAroundCoords(dataUrl, cx, cy, logicalW, logicalH, cropW = 350, cropH = 350) {
  try {
    const bitmap = await createImageBitmap(dataUrlToBlob(dataUrl));

    // Enforce a uniform DPR to prevent Y-coordinate skew if logicalH is incorrect
    const dpr = bitmap.width / logicalW;
    
    // Scale center coordinates and crop dimensions to raw device pixels
    const rawCx = cx * dpr;
    const rawCy = cy * dpr;
    const rawCropW = cropW * dpr;
    const rawCropH = cropH * dpr;
    
    // Determine the source bounding box to crop from (clamped to image dimensions)
    const sx = Math.max(0, Math.min(bitmap.width - rawCropW, rawCx - rawCropW / 2));
    const sy = Math.max(0, Math.min(bitmap.height - rawCropH, rawCy - rawCropH / 2));
    
    // Draw the cropped region onto an OffscreenCanvas
    const canvas = new OffscreenCanvas(cropW, cropH);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, sx, sy, rawCropW, rawCropH, 0, 0, cropW, cropH);
    bitmap.close();
    
    const croppedBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.90 });
    const buf = await croppedBlob.arrayBuffer();
    const arr = new Uint8Array(buf);
    let b64 = "";
    for (let i = 0; i < arr.length; i += 8192) {
      b64 += String.fromCharCode(...arr.subarray(i, Math.min(i + 8192, arr.length)));
    }
    return b64 ? btoa(b64) : null;
  } catch (e) {
    console.error("[visual-crop] failed to crop screenshot:", e);
    return null;
  }
}

// Compares a baseline screenshot (dataUrlBefore) with a live captured screenshot.
// Downsamples to 160x100 to reduce computation, smooth JPEG artifacts, and avoid high DPI differences.
// Returns true if a significant portion of pixels changed.
async function detectVisualChange(tabId, windowId, dataUrlBefore) {
  if (!dataUrlBefore) return false;
  try {
    const dataUrlAfter = await captureTabForDiff(tabId, windowId);
    const [bitmapBefore, bitmapAfter] = await Promise.all([
      createImageBitmap(dataUrlToBlob(dataUrlBefore)),
      createImageBitmap(dataUrlToBlob(dataUrlAfter))
    ]);

    const cmpW = 160;
    const cmpH = 100;
    const canvasBefore = new OffscreenCanvas(cmpW, cmpH);
    const canvasAfter = new OffscreenCanvas(cmpW, cmpH);

    const ctxBefore = canvasBefore.getContext("2d");
    const ctxAfter = canvasAfter.getContext("2d");

    ctxBefore.drawImage(bitmapBefore, 0, 0, cmpW, cmpH);
    ctxAfter.drawImage(bitmapAfter, 0, 0, cmpW, cmpH);

    bitmapBefore.close();
    bitmapAfter.close();

    const imgDataBefore = ctxBefore.getImageData(0, 0, cmpW, cmpH).data;
    const imgDataAfter = ctxAfter.getImageData(0, 0, cmpW, cmpH).data;

    let diffPixels = 0;
    for (let i = 0; i < imgDataBefore.length; i += 4) {
      const dr = Math.abs(imgDataBefore[i] - imgDataAfter[i]);
      const dg = Math.abs(imgDataBefore[i+1] - imgDataAfter[i+1]);
      const db = Math.abs(imgDataBefore[i+2] - imgDataAfter[i+2]);

      if (dr + dg + db > 25) {
        diffPixels++;
      }
    }

    const threshold = (cmpW * cmpH) * 0.002; // 0.2% — catches small VNC cursor/text changes
    console.log(`[visual-diff] diffPixels: ${diffPixels}, threshold: ${threshold}`);
    return diffPixels > threshold;
  } catch (e) {
    console.error("[visual-diff] failed to compare screenshots:", e);
    return false;
  }
}

// -- Set-of-Marks (SoM) -------------------------------------------------------
// Overlays numbered red boxes on every interactive element in the screenshot.
// The LLM sees the labeled image and can reference elements by their number
// from the ELEMENT_MAP — eliminating raw coordinate guessing.

// Step 1: collect all interactable elements with their bounding boxes.
// Runs as an injected script so it can pierce shadow roots.
function _getInteractiveElementsPage() {
  var TAGS  = ["a","button","input","select","textarea","details","summary","video","audio","canvas"];
  var ROLES = ["button","link","tab","menuitem","menuitemcheckbox","menuitemradio",
               "option","checkbox","radio","switch","combobox","textbox",
               "searchbox","spinbutton","slider","treeitem","listitem",
               "gridcell","columnheader","rowheader","cell","row","tree"];
  var seen = new WeakSet();
  var out  = [];
  var deadline = Date.now() + 1800;

  function getUniqueSelector(el) {
    if (!el || el.nodeType !== 1) return "";
    var parts = [];
    var current = el;
    while (current) {
      var root = current.getRootNode();
      var path = [];
      var ARIA_ATTRS = ["aria-label", "placeholder", "title", "name"];
      var uniqueAttrSel = null;
      for (var i = 0; i < ARIA_ATTRS.length; i++) {
        var val = current.getAttribute ? current.getAttribute(ARIA_ATTRS[i]) : null;
        if (val) {
          var sel = current.tagName.toLowerCase() + "[" + ARIA_ATTRS[i] + "=\"" + val.replace(/"/g, "\\\"") + "\"]";
          try {
            if (root.querySelectorAll(sel).length === 1) {
              uniqueAttrSel = sel;
              break;
            }
          } catch(_) {}
        }
      }
      if (uniqueAttrSel) {
        path.unshift(uniqueAttrSel);
      } else {
        var node = current;
        while (node && node !== root && node.nodeType === 1) {
          var tag = node.tagName.toLowerCase();
          if (node.id) {
            try { path.unshift(tag + "#" + CSS.escape(node.id)); } catch (_) { path.unshift(tag + "#" + node.id); }
            break;
          }
          var siblings = node.parentNode ? node.parentNode.children : null;
          if (siblings && siblings.length > 1) {
            var sameTagSiblings = Array.prototype.filter.call(siblings, function(child) {
              return child.tagName.toLowerCase() === tag;
            });
            if (sameTagSiblings.length > 1) {
              var index = Array.prototype.indexOf.call(sameTagSiblings, node) + 1;
              tag += ":nth-of-type(" + index + ")";
            }
          }
          path.unshift(tag);
          node = node.parentNode;
        }
      }
      parts.unshift(path.join(" > "));
      if (typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot) {
        current = root.host;
      } else if (root && root.defaultView && root.defaultView.frameElement) {
        current = root.defaultView.frameElement;
      } else {
        break;
      }
    }
    return parts.join(" >>> ");
  }

  // ── Stable ID assignment ────────────────────────────────────────────────────
  // Fingerprint each element from its tag, identity attributes, and rounded
  // viewport position. Store the fingerprint→id map on window so the SAME
  // element keeps the SAME id across consecutive snapshots on the same page.
  var prevIds = {};
  try { prevIds = window.__navy_somIds || {}; } catch(_) {}
  var nextId = 1;
  try { nextId = window.__navy_somNextId || 1; } catch(_) {}
  var usedIds = new Set(Object.values(prevIds));
  var newIds  = {};
  // Identity map (element → id), like Claude-for-Chrome's WeakRef ref map. Keyed on
  // the actual DOM node, so an element keeps its id even when it MOVES or its content
  // changes (list reorder, game-piece move, reflow) — the position-based fingerprint
  // below would mint a new id in those cases, causing id "drift" the model can't track.
  var reverse = null;
  try { reverse = window.__navy_somReverse || (window.__navy_somReverse = new WeakMap()); } catch(_) {}

  function makeFingerprint(el, lcx, lcy) {
    var tag  = (el.tagName || '').toLowerCase();
    var elId = el.id ? ('#' + el.id.slice(0, 20)) : '';
    var cls  = (typeof el.className === 'string')
      ? el.className.trim().split(/\s+/).filter(function(c){ return c.length > 0; }).slice(0, 2).join('.')
      : '';
    var lbl  = ((el.getAttribute ? el.getAttribute('aria-label') : '') ||
                (el.getAttribute ? el.getAttribute('placeholder') : '') || '').slice(0, 20);
    // Round to nearest 20 px — minor reflows don't change the fingerprint
    var rx = Math.round(lcx / 20) * 20;
    var ry = Math.round(lcy / 20) * 20;
    return tag + elId + '.' + cls + '|' + lbl + '|' + rx + ',' + ry;
  }

  function assignId(el, fp) {
    // Identity first: the SAME DOM node always keeps its id, wherever it moves.
    if (reverse) {
      var byIdentity = reverse.get(el);
      if (byIdentity != null) { newIds[fp] = byIdentity; return byIdentity; }
    }
    // Then fingerprint (handles a fresh node that replaced an old one in place).
    if (prevIds[fp]) { newIds[fp] = prevIds[fp]; if (reverse) reverse.set(el, prevIds[fp]); return prevIds[fp]; }
    while (usedIds.has(nextId)) nextId++;
    var id = nextId++;
    usedIds.add(id);
    newIds[fp] = id;
    if (reverse) reverse.set(el, id);
    return id;
  }

  function formatTime(s) {
    if (isNaN(s) || s === null || s === undefined) return '0:00';
    var mins = Math.floor(s / 60);
    var secs = Math.floor(s % 60);
    return mins + ":" + (secs < 10 ? "0" : "") + secs;
  }

  var __navy_labelForMap;
  function lbl(el) {
    // <label for="id"> association — often the ONLY label a form input has. Build the
    // for->text map ONCE per scan (lazily) instead of a querySelector per element,
    // which was O(elements × DOM) on form-heavy pages. Also drops the CSS.escape/
    // selector-building since we now look up by exact id string.
    var forLabel = "";
    if (el.id) {
      if (!__navy_labelForMap) {
        __navy_labelForMap = {};
        try {
          var __lfs = document.querySelectorAll('label[for]');
          for (var __li = 0; __li < __lfs.length; __li++) {
            var __lf = __lfs[__li].getAttribute('for');
            if (__lf && !(__lf in __navy_labelForMap)) __navy_labelForMap[__lf] = (__lfs[__li].textContent || "").trim();
          }
        } catch(_) {}
      }
      forLabel = __navy_labelForMap[el.id] || "";
    }
    var labelText = (el.getAttribute("aria-label") || el.getAttribute("placeholder") ||
            el.getAttribute("title") || forLabel || el.getAttribute("alt") ||
            (el.textContent||"").trim().slice(0,35) ||
            el.tagName.toLowerCase()).trim().replace(/\s+/g, " ");

    try {
      if (el.tagName && el.tagName.toLowerCase() === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {
        labelText = (el.checked ? "☑ " : "☐ ") + labelText;
      }
      else if (el.tagName && el.tagName.toLowerCase() === 'select') {
        var selectedOpt = el.options && el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : '';
        labelText = "Dropdown: " + labelText + (selectedOpt ? " [" + selectedOpt + " ▼]" : "");
      }
      else if (el.tagName && (el.tagName.toLowerCase() === 'video' || el.tagName.toLowerCase() === 'audio')) {
        var state = el.paused ? "paused" : "playing";
        var cur = formatTime(el.currentTime);
        var dur = formatTime(el.duration);
        labelText = (el.tagName.toLowerCase() === 'video' ? "Video: " : "Audio: ") + cur + " / " + dur + " [" + state + "]";
      }
      else if (el.isContentEditable) {
        var preview = (el.textContent || '').trim().slice(0, 40);
        labelText = "Text editor: [" + preview + "]";
      }
      else if (el.tagName && el.tagName.toLowerCase() === 'input' && el.type) {
        var t = el.type.toLowerCase();
        if (t === 'date') labelText = "Date input (YYYY-MM-DD): " + labelText;
        else if (t === 'datetime-local') labelText = "DateTime input (YYYY-MM-DDTHH:MM): " + labelText;
        else if (t === 'time') labelText = "Time input (HH:MM): " + labelText;
        else if (t === 'month') labelText = "Month input (YYYY-MM): " + labelText;
        else if (t === 'week') labelText = "Week input (YYYY-Www): " + labelText;
      }

      if (el.hasAttribute && (el.hasAttribute('required') || el.getAttribute('aria-required') === 'true')) {
        labelText = "★ Required: " + labelText;
      }

      var form = el.closest ? el.closest('form') : null;
      if (form) {
        var hasNextBtn = Array.from(form.querySelectorAll('button, input[type="button"], input[type="submit"]')).some(function(btn) {
          var t = (btn.textContent || btn.value || '').toLowerCase();
          return t.indexOf('next') !== -1 || t.indexOf('continue') !== -1;
        });
        if (hasNextBtn) {
          var steps = Array.from(form.querySelectorAll('fieldset, .form-step, .step-panel, [id*="step"], [class*="step"]'));
          steps = steps.filter(function(s, idx) {
            return !steps.some(function(other, oIdx) {
              return oIdx !== idx && other.contains(s);
            });
          });
          if (steps.length > 1) {
            var myStep = steps.find(function(s) { return s.contains(el); });
            if (myStep) {
              var stepIndex = steps.indexOf(myStep) + 1;
              labelText = "Step " + stepIndex + " of " + steps.length + " — " + labelText;
            }
          }
        }
      }
    } catch (_) {}

    return labelText;
  }

  function add(el, offsetLeft, offsetTop) {
    if (out.length >= 450 || seen.has(el) || Date.now() > deadline) return;
    seen.add(el);
    var r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return;
    if (r.right  + (offsetLeft || 0) < 0 || r.bottom + (offsetTop || 0) < 0) return;
    if (r.left   + (offsetLeft || 0) > window.innerWidth  ||
        r.top    + (offsetTop  || 0) > window.innerHeight) return;
    var s = window.getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none") return;
    if (parseFloat(s.opacity) < 0.1) return;

    // Viewport-local center (no iframe offset) — used for occlusion + fingerprint
    var lcx = Math.round(r.left + r.width  / 2);
    var lcy = Math.round(r.top  + r.height / 2);

    // ── Occlusion check ────────────────────────────────────────────────────
    // Skip elements that are visually covered by a higher-stacking element
    // (e.g. a modal backdrop, cookie banner, or sticky header).
    // Canvas elements are exempt — they serve as coordinate containers for
    // canvas-click protocol even when overlaid by DOM elements.
    // Only feasible for main-document elements; iframe-offset elements are
    // already in a different coordinate space.
    var elTag = (el.tagName || '').toLowerCase();
    if (!offsetLeft && !offsetTop && elTag !== 'canvas') {
      try {
        var topEl = document.elementFromPoint(lcx, lcy);
        if (topEl && topEl !== el && !el.contains(topEl)) {
          return; // another element sits on top at this point
        }
      } catch(_) {}
    }

    var cx = lcx + (offsetLeft || 0);
    var cy = lcy + (offsetTop  || 0);

    var fp = makeFingerprint(el, lcx, lcy);
    var id = assignId(el, fp);
    var tag = (el.tagName || '').toLowerCase();

    // Compact semantic role so the model can disambiguate by element TYPE (button
    // vs link vs input) instead of guessing from the screenshot. Explicit ARIA role
    // wins; otherwise derive from tag / input type.
    var role = (el.getAttribute && el.getAttribute('role')) ||
      (tag === 'a' ? 'link'
        : tag === 'button' ? 'button'
        : tag === 'select' ? 'select'
        : tag === 'textarea' ? 'textbox'
        : tag === 'input' ? ('input:' + ((el.type || 'text').toLowerCase()))
        : tag);

    // Nearest semantic container (form / nav / dialog / landmark) — lets the model
    // disambiguate identical controls in different regions ("Submit" in the checkout
    // form vs the newsletter form) without dumping the whole DOM tree. Bounded walk.
    var group = '';
    try {
      var gp = el.parentElement, ghops = 0;
      while (gp && ghops < 12) {
        var gt = gp.tagName ? gp.tagName.toLowerCase() : '';
        var grole = gp.getAttribute ? gp.getAttribute('role') : '';
        if (gt === 'form' || gt === 'nav' || gt === 'dialog' || gt === 'aside' || gt === 'main' || gt === 'header' || gt === 'footer' ||
            grole === 'dialog' || grole === 'navigation' || grole === 'form' || grole === 'search' || grole === 'menu' || grole === 'tablist' || grole === 'region') {
          var gname = (((gp.getAttribute && (gp.getAttribute('aria-label') || gp.getAttribute('name'))) || gp.id || '') + '').trim().slice(0, 24);
          group = (grole || gt) + (gname ? ':' + gname : '');
          break;
        }
        gp = gp.parentElement; ghops++;
      }
    } catch(_) {}

    out.push({ id: id, x: cx, y: cy,
               w: Math.round(r.width), h: Math.round(r.height), label: lbl(el), role: role, group: group, selector: getUniqueSelector(el),
               isCanvas: tag === 'canvas' });
  }

  function scan(root, offsetLeft, offsetTop) {
    offsetLeft = offsetLeft || 0;
    offsetTop = offsetTop || 0;
    if (Date.now() > deadline || out.length >= 450) return;

    TAGS.forEach(function(t)  {
      try {
        root.querySelectorAll(t).forEach(function(el) {
          add(el, offsetLeft, offsetTop);
        });
      } catch(_){}
    });
    ROLES.forEach(function(r) {
      try {
        root.querySelectorAll('[role="'+r+'"]').forEach(function(el) {
          add(el, offsetLeft, offsetTop);
        });
      } catch(_){}
    });
    try {
      root.querySelectorAll('[tabindex="0"],[onclick]').forEach(function(el) {
        add(el, offsetLeft, offsetTop);
      });
    } catch(_){}

    // Capture any visible element whose cursor signals interactivity.
    // This catches custom components (drag handles, canvas overlays, game pieces,
    // sortable cards, etc.) that don't use standard HTML semantics or ARIA roles.
    //
    // Two tiers, because `cursor` INHERITS. DIRECT cursors are only ever set on the
    // clickable thing itself, so any element carrying one is worth a som_id. AMBIENT
    // cursors are routinely set on a whole play/edit surface and inherited by every
    // descendant — taking them unconditionally would surface every layout wrapper in
    // the subtree. An inheriting descendant only earns a som_id if it is a distinct
    // visual unit (paints its own background/border/image) or if the page explicitly
    // gave it a different cursor from its parent's. That keeps the game piece, the
    // map pin, and the drawing handle while dropping the invisible flex wrappers
    // around them. Mirrors INTERACTIVE_CURSORS, minus `text` — that one is the UA
    // default on all selectable prose and would flood the map.
    var DIRECT_CURSORS  = { pointer: 1, grab: 1, grabbing: 1, move: 1 };
    var AMBIENT_CURSORS = { crosshair: 1, cell: 1, "zoom-in": 1, "zoom-out": 1,
                            copy: 1, alias: 1, "context-menu": 1 };
    function paintsOwnSurface(el, s) {
      try {
        if (s.backgroundImage && s.backgroundImage !== 'none') return true;
        // Painting == non-zero ALPHA. Parse the channels; do not pattern-match the
        // string. A "last channel is 0" test silently classifies rgb(0,0,0) (black)
        // and rgb(255,255,0) (yellow) as transparent, which would drop exactly the
        // solid-coloured controls this function exists to catch.
        var bg = (s.backgroundColor || '').trim();
        if (bg && bg !== 'transparent') {
          var m = bg.match(/^rgba?\(([^)]+)\)$/i);
          if (!m) return true;                       // named/hex colour → opaque
          var ch = m[1].split(/[,\/]/).map(function (v) { return parseFloat(v); });
          var alpha = ch.length > 3 && !isNaN(ch[3]) ? ch[3] : 1;
          if (alpha > 0.05) return true;
        }
        if (parseFloat(s.borderTopWidth) > 0 || parseFloat(s.borderLeftWidth) > 0) return true;
        var t = (el.tagName || '').toLowerCase();
        if (t === 'img' || t === 'svg' || t === 'canvas' || t === 'video') return true;
      } catch (_) {}
      return false;
    }
    try {
      root.querySelectorAll("*").forEach(function(el) {
        if (seen.has(el) || out.length >= 450 || Date.now() > deadline) return;
        var r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) return;
        var s = window.getComputedStyle(el);
        if (DIRECT_CURSORS[s.cursor]) {
          add(el, offsetLeft, offsetTop);
          return;
        }
        if (AMBIENT_CURSORS[s.cursor]) {
          var pc = '';
          try {
            if (el.parentElement) pc = window.getComputedStyle(el.parentElement).cursor;
          } catch (_) {}
          if (s.cursor !== pc || paintsOwnSurface(el, s)) add(el, offsetLeft, offsetTop);
        }
      });
    } catch(_) {}

    try {
      root.querySelectorAll("*").forEach(function(el) {
        if (seen.has(el) || out.length >= 450 || Date.now() > deadline) return;
        var s = window.getComputedStyle(el);
        var fs = parseFloat(s.fontSize);
        if (fs > 20) {
          var hasDirectText = false;
          for (var i = 0; i < el.childNodes.length; i++) {
            if (el.childNodes[i].nodeType === 3 && el.childNodes[i].textContent.trim().length > 0) {
              hasDirectText = true;
              break;
            }
          }
          if (hasDirectText) {
            add(el, offsetLeft, offsetTop);
          }
        }
      });
    } catch(_) {}

    try {
      root.querySelectorAll("*").forEach(function(el) {
        if (el.shadowRoot) scan(el.shadowRoot, offsetLeft, offsetTop);
      });
    } catch(_) {}
    try {
      root.querySelectorAll("iframe").forEach(function(fr) {
        try {
          var frRect = fr.getBoundingClientRect();
          var doc = fr.contentDocument || fr.contentWindow.document;
          if (doc && doc.body) {
            scan(doc.body, offsetLeft + frRect.left, offsetTop + frRect.top);
          }
        } catch(_) {}
      });
    } catch(_) {}
  }

  scan(document.body || document.documentElement, 0, 0);

  // Remove near-duplicate boxes (>70% overlap — keep the smaller, more specific one).
  // Canvas elements are coordinate containers for canvas-click protocol — never remove them.
  var toRemove = new Set();
  for (var i = 0; i < out.length; i++) {
    for (var j = i + 1; j < out.length; j++) {
      var box1 = out[i];
      var box2 = out[j];
      if (box1.isCanvas || box2.isCanvas) continue;
      var l1 = box1.x - box1.w/2, r1 = box1.x + box1.w/2, t1 = box1.y - box1.h/2, b1 = box1.y + box1.h/2;
      var l2 = box2.x - box2.w/2, r2 = box2.x + box2.w/2, t2 = box2.y - box2.h/2, b2 = box2.y + box2.h/2;
      var il = Math.max(l1, l2), ir = Math.min(r1, r2), it = Math.max(t1, t2), ib = Math.min(b1, b2);
      if (ir > il && ib > it) {
        var interArea = (ir - il) * (ib - it);
        var area1 = box1.w * box1.h;
        var area2 = box2.w * box2.h;
        var unionArea = area1 + area2 - interArea;
        if (interArea / unionArea > 0.7) {
          // Prefer the smaller, more specific interactive element over its wrapper.
          var score1 = (box1.role === "generic" ? 0 : 2) + (box1.label ? 1 : 0);
          var score2 = (box2.role === "generic" ? 0 : 2) + (box2.label ? 1 : 0);
          var keep1 = score1 > score2 || (score1 === score2 && area1 <= area2);
          toRemove.add(keep1 ? box2.id : box1.id);
        }
      }
    }
  }
  out = out.filter(function(item) { return !toRemove.has(item.id); });
  out = out.slice(0, 300);

  // Persist fingerprint→id map so next snapshot on this page reuses the same ids.
  // IDs are NOT renumbered — stable fingerprint ids survive DOM changes.
  try {
    window.__navy_somIds     = newIds;
    window.__navy_somNextId  = nextId;
  } catch(_) {}

  return out;
}

async function getInteractiveElements(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: _getInteractiveElementsPage,
    });
    let map = Array.isArray(res && res.result) ? res.result : [];
    if (map.length < 10) {
      const [resAgg] = await chrome.scripting.executeScript({
        target: { tabId },
        func: _getInteractiveElementsPageAggressive,
      });
      if (resAgg && Array.isArray(resAgg.result) && resAgg.result.length > map.length) {
        map = resAgg.result;
      }
    }
    // Supplement with shadow-DOM elements found via CDP (pierce:true covers closed shadow roots
    // that chrome.scripting.executeScript can't access).
    if (map.length < 200) {
      const shadowEls = await getInteractiveElementsFromShadowDOM(tabId, map).catch(() => []);
      if (shadowEls.length > 0) map = map.concat(shadowEls);
    }
    return map;
  } catch (_) { return []; }
}

// Uses CDP DOM.getDocument(pierce:true) to find interactive elements inside closed shadow roots.
// Returns only elements NOT already covered by the content-script scan (no spatial overlap).
async function getInteractiveElementsFromShadowDOM(tabId, existingMap) {
  const INTERACTIVE_TAGS = new Set(["a","button","input","select","textarea","summary"]);
  const INTERACTIVE_ROLES = new Set(["button","link","checkbox","radio","textbox","combobox","listbox","menuitem","tab","switch","option"]);

  let doc;
  try {
    ({ root: doc } = await withTimeout(sendCDP(tabId, "DOM.getDocument", { depth: -1, pierce: true }), 5000, "DOM.getDocument"));
  } catch (_) { return []; }

  const candidates = [];
  function walkNode(node, currentPath = "", siblings = []) {
    if (!node) return;
    const tag = (node.nodeName || "").toLowerCase();
    
    let segment = "";
    if (node.nodeType === 1) { // ELEMENT_NODE
      const attrs = node.attributes || [];
      let idVal = "";
      for (let i = 0; i + 1 < attrs.length; i += 2) {
        if (attrs[i] === "id") { idVal = attrs[i + 1]; break; }
      }
      if (idVal) {
        segment = tag + "#" + idVal;
      } else {
        segment = tag;
        const sameTagSiblings = siblings.filter(s => s.nodeType === 1 && (s.nodeName || "").toLowerCase() === tag);
        if (sameTagSiblings.length > 1) {
          const index = sameTagSiblings.indexOf(node) + 1;
          segment += `:nth-of-type(${index})`;
        }
      }
    }

    let nextPath = currentPath;
    if (node.nodeType === 1) {
      if (!nextPath) {
        nextPath = segment;
      } else if (nextPath.endsWith(" >>> ")) {
        nextPath += segment;
      } else {
        nextPath += " > " + segment;
      }
    }

    const attrs = node.attributes || [];
    let roleVal = "";
    for (let i = 0; i + 1 < attrs.length; i += 2) {
      if (attrs[i] === "role") { roleVal = attrs[i + 1]; break; }
    }

    if (node.nodeType === 1 && (INTERACTIVE_TAGS.has(tag) || INTERACTIVE_ROLES.has(roleVal))) {
      candidates.push({ nodeId: node.nodeId, selector: nextPath });
    }

    const children = node.children || [];
    children.forEach(child => {
      walkNode(child, nextPath, children);
    });

    const shadowRoots = node.shadowRoots || [];
    shadowRoots.forEach(sr => {
      walkNode(sr, nextPath + " >>> ", [sr]);
    });

    if (node.contentDocument) {
      walkNode(node.contentDocument, nextPath + " >>> ", [node.contentDocument]);
    }
  }
  walkNode(doc, "", [doc]);

  if (candidates.length === 0) return [];

  // Build set of occupied coordinate zones from existing map for deduplication
  const occupied = existingMap.map(el => ({ x: el.x, y: el.y, w: el.w || 1, h: el.h || 1 }));
  function isOccupied(cx, cy) {
    return occupied.some(z => {
      const hw = (z.w || 1) / 2 + 4, hh = (z.h || 1) / 2 + 4;
      return Math.abs(cx - z.x) < hw && Math.abs(cy - z.y) < hh;
    });
  }

  const results = [];
  if (!STATE.shadowSomIds) {
    STATE.shadowSomIds = {};
    STATE.shadowSomNextId = 2000;
  }

  // Per-node geometry + visibility + label/role, all in ONE call, resolved directly
  // on the element (not a re-query by selector -- selectors can be ambiguous/stale).
  //
  // Why not DOM.getBoxModel: it returns an element's LAYOUT box regardless of whether
  // an ancestor clips it away (overflow:hidden + height:0 is the classic collapsed
  // accordion / closed-drawer / hidden-consent-panel pattern). A button inside such a
  // container still gets full, real-looking coordinates from getBoxModel -- so a
  // hidden panel's entire control set silently becomes a field of phantom SOM boxes
  // scattered over whatever content happens to sit underneath. getBoundingClientRect
  // has the exact same blind spot (clipping affects PAINT, not layout geometry), so
  // switching APIs alone does not fix it.
  //
  // The only signal that reflects what is actually PAINTED is a hit-test: ask the
  // element's own root (piercing shadow boundaries via getRootNode(), which works for
  // closed roots too since this runs with the element's own script access) whether its
  // own center point resolves back to itself. A clipped/hidden element fails this even
  // though its geometry looks perfectly normal -- the same principle the other two
  // collectors already apply via document.elementFromPoint.
  const EVAL_FN = function () {
    try {
      var r = this.getBoundingClientRect();
      var w = Math.round(r.width), h = Math.round(r.height);
      if (w < 4 || h < 4) return JSON.stringify({ visible: false });
      var s = getComputedStyle(this);
      if (s.visibility === "hidden" || s.display === "none" || parseFloat(s.opacity) < 0.1) {
        return JSON.stringify({ visible: false });
      }
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return JSON.stringify({ visible: false });
      var root = this.getRootNode ? this.getRootNode() : document;
      var hit = root.elementFromPoint ? root.elementFromPoint(cx, cy) : document.elementFromPoint(cx, cy);
      if (!hit || (hit !== this && !this.contains(hit))) return JSON.stringify({ visible: false });
      var t = (this.getAttribute && this.getAttribute("aria-label")) || "";
      if (!t) t = (this.innerText || this.textContent || "").trim();
      if (!t) t = (this.getAttribute && (this.getAttribute("placeholder") || "")) || "";
      if (!t) t = (this.getAttribute && (this.getAttribute("title") || "")) || "";
      if (!t) t = (this.getAttribute && (this.getAttribute("alt") || "")) || "";
      if (!t && this.value) t = String(this.value);
      if (!t) t = (this.getAttribute && (this.getAttribute("name") || "")) || "";
      var tag = this.tagName ? this.tagName.toLowerCase() : "";
      var role = (this.getAttribute && this.getAttribute("role")) || "";
      if (!role) {
        role = tag === "a" ? "link" : tag === "button" ? "button" : tag === "textarea" ? "textbox"
             : tag === "select" ? "combobox" : tag === "input" ? ("input:" + ((this.type || "text").toLowerCase())) : tag;
      }
      return JSON.stringify({ visible: true, x: Math.round(cx), y: Math.round(cy), w: w, h: h,
        label: String(t).replace(/\s+/g, " ").trim().slice(0, 120), role: role, tag: tag });
    } catch (e) { return JSON.stringify({ visible: false }); }
  }.toString();

  for (const item of candidates.slice(0, 80)) {
    const { nodeId, selector } = item;
    try {
      const { object } = await sendCDP(tabId, "DOM.resolveNode", { nodeId });
      if (!object || !object.objectId) continue;
      const { result } = await sendCDP(tabId, "Runtime.callFunctionOn", {
        objectId: object.objectId, functionDeclaration: EVAL_FN, returnByValue: true,
      });
      const info = result && result.value ? JSON.parse(result.value) : null;
      if (!info || !info.visible) continue;
      if (isOccupied(info.x, info.y)) continue;

      let id = STATE.shadowSomIds[selector];
      if (id === undefined) {
        id = STATE.shadowSomNextId++;
        STATE.shadowSomIds[selector] = id;
      }

      results.push({ id, x: info.x, y: info.y, w: info.w, h: info.h,
        label: info.label || "(shadow)", role: info.role, selector });
      occupied.push({ x: info.x, y: info.y, w: info.w, h: info.h });
    } catch (_) {}
  }

  return results;
}

function _getInteractiveElementsPageAggressive() {
  var TAGS  = ["a","button","input","select","textarea","details","summary","video","audio","canvas","div","span","p","li","h1","h2","h3","h4"];
  var seen = new WeakSet();
  var out  = [];
  var deadline = Date.now() + 1800;

  function getUniqueSelector(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.id) {
      try { return "#" + CSS.escape(el.id); } catch (_) { return "#" + el.id; }
    }
    var ARIA_ATTRS = ["aria-label", "placeholder", "title", "name"];
    for (var i = 0; i < ARIA_ATTRS.length; i++) {
      var val = el.getAttribute(ARIA_ATTRS[i]);
      if (val) {
        var sel = el.tagName.toLowerCase() + "[" + ARIA_ATTRS[i] + "=\"" + val.replace(/"/g, "\\\"") + "\"]";
        try {
          if (document.querySelectorAll(sel).length === 1) return sel;
        } catch(_) {}
      }
    }
    var path = [];
    var current = el;
    while (current && current.nodeType === 1) {
      var tag = current.tagName.toLowerCase();
      if (current.id) {
        try { path.unshift(tag + "#" + CSS.escape(current.id)); } catch (_) { path.unshift(tag + "#" + current.id); }
        break;
      }
      var siblings = current.parentNode ? current.parentNode.children : null;
      if (siblings && siblings.length > 1) {
        var sameTagSiblings = Array.prototype.filter.call(siblings, function(child) {
          return child.tagName.toLowerCase() === tag;
        });
        if (sameTagSiblings.length > 1) {
          var index = Array.prototype.indexOf.call(sameTagSiblings, current) + 1;
          tag += ":nth-of-type(" + index + ")";
        }
      }
      path.unshift(tag);
      current = current.parentNode;
    }
    return path.join(" > ");
  }

  // Reuse the same stable-ID state written by _getInteractiveElementsPage so
  // aggressive-mode scans don't reset the fingerprint counter.
  var prevIds = {};
  try { prevIds = window.__navy_somIds || {}; } catch(_) {}
  var nextId = 1;
  try { nextId = window.__navy_somNextId || 1; } catch(_) {}
  var usedIds = new Set(Object.values(prevIds));
  var newIds  = {};
  // Shared identity map (element → id) — same one the primary scan uses, so ids stay
  // consistent whether an element was found by the normal or aggressive pass.
  var reverse = null;
  try { reverse = window.__navy_somReverse || (window.__navy_somReverse = new WeakMap()); } catch(_) {}

  function makeFingerprint(el, lcx, lcy) {
    var tag  = (el.tagName || '').toLowerCase();
    var elId = el.id ? ('#' + el.id.slice(0, 20)) : '';
    var cls  = (typeof el.className === 'string')
      ? el.className.trim().split(/\s+/).filter(function(c){ return c.length > 0; }).slice(0, 2).join('.')
      : '';
    var lbl  = ((el.getAttribute ? el.getAttribute('aria-label') : '') ||
                (el.getAttribute ? el.getAttribute('placeholder') : '') || '').slice(0, 20);
    var rx = Math.round(lcx / 20) * 20;
    var ry = Math.round(lcy / 20) * 20;
    return tag + elId + '.' + cls + '|' + lbl + '|' + rx + ',' + ry;
  }

  function assignId(el, fp) {
    if (reverse) {
      var byIdentity = reverse.get(el);
      if (byIdentity != null) { newIds[fp] = byIdentity; return byIdentity; }
    }
    if (prevIds[fp]) { newIds[fp] = prevIds[fp]; if (reverse) reverse.set(el, prevIds[fp]); return prevIds[fp]; }
    while (usedIds.has(nextId)) nextId++;
    var id = nextId++;
    usedIds.add(id);
    newIds[fp] = id;
    if (reverse) reverse.set(el, id);
    return id;
  }

  function formatTime(s) {
    if (isNaN(s) || s === null || s === undefined) return '0:00';
    var mins = Math.floor(s / 60);
    var secs = Math.floor(s % 60);
    return mins + ":" + (secs < 10 ? "0" : "") + secs;
  }

  var __navy_labelForMap;
  function lbl(el) {
    // <label for="id"> association — often the ONLY label a form input has. Build the
    // for->text map ONCE per scan (lazily) instead of a querySelector per element,
    // which was O(elements × DOM) on form-heavy pages. Also drops the CSS.escape/
    // selector-building since we now look up by exact id string.
    var forLabel = "";
    if (el.id) {
      if (!__navy_labelForMap) {
        __navy_labelForMap = {};
        try {
          var __lfs = document.querySelectorAll('label[for]');
          for (var __li = 0; __li < __lfs.length; __li++) {
            var __lf = __lfs[__li].getAttribute('for');
            if (__lf && !(__lf in __navy_labelForMap)) __navy_labelForMap[__lf] = (__lfs[__li].textContent || "").trim();
          }
        } catch(_) {}
      }
      forLabel = __navy_labelForMap[el.id] || "";
    }
    var labelText = (el.getAttribute("aria-label") || el.getAttribute("placeholder") ||
            el.getAttribute("title") || forLabel || el.getAttribute("alt") ||
            (el.textContent||"").trim().slice(0,35) ||
            el.tagName.toLowerCase()).trim().replace(/\s+/g, " ");

    try {
      if (el.tagName && el.tagName.toLowerCase() === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {
        labelText = (el.checked ? "☑ " : "☐ ") + labelText;
      }
      if (el.hasAttribute && (el.hasAttribute('required') || el.getAttribute('aria-required') === 'true')) {
        labelText = "★ Required: " + labelText;
      }
    } catch (_) {}

    return labelText;
  }

  function add(el, offsetLeft, offsetTop) {
    if (out.length >= 450 || seen.has(el) || Date.now() > deadline) return;
    seen.add(el);
    var r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return;
    var s = window.getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none") return;
    if (parseFloat(s.opacity) < 0.1) return;
    var lcx = Math.round(r.left + r.width  / 2);
    var lcy = Math.round(r.top  + r.height / 2);
    var elTagAgg = (el.tagName || '').toLowerCase();
    if (!offsetLeft && !offsetTop && elTagAgg !== 'canvas') {
      try {
        var topEl = document.elementFromPoint(lcx, lcy);
        if (topEl && topEl !== el && !el.contains(topEl)) return;
      } catch(_) {}
    }
    var cx = lcx + (offsetLeft || 0);
    var cy = lcy + (offsetTop  || 0);
    var fp = makeFingerprint(el, lcx, lcy);
    var id = assignId(el, fp);
    var roleAgg = (el.getAttribute && el.getAttribute('role')) ||
      (elTagAgg === 'a' ? 'link'
        : elTagAgg === 'button' ? 'button'
        : elTagAgg === 'select' ? 'select'
        : elTagAgg === 'textarea' ? 'textbox'
        : elTagAgg === 'input' ? ('input:' + ((el.type || 'text').toLowerCase()))
        : elTagAgg);
    out.push({ id: id, x: cx, y: cy,
               w: Math.round(r.width), h: Math.round(r.height), label: lbl(el), role: roleAgg, selector: getUniqueSelector(el),
               isCanvas: elTagAgg === 'canvas' });
  }

  function scan(root, offsetLeft, offsetTop) {
    offsetLeft = offsetLeft || 0;
    offsetTop = offsetTop || 0;
    if (Date.now() > deadline || out.length >= 450) return;
    TAGS.forEach(function(t)  {
      try {
        root.querySelectorAll(t).forEach(function(el) {
          if (seen.has(el)) return;
          var s = window.getComputedStyle(el);
          var tag = el.tagName.toLowerCase();
          if (["a","button","input","select","textarea"].includes(tag) ||
              s.cursor === "pointer" || el.onclick || el.getAttribute("tabindex") !== null ||
              el.isContentEditable) {
            add(el, offsetLeft, offsetTop);
          }
        });
      } catch(_){}
    });
    try {
      root.querySelectorAll("*").forEach(function(el) {
        if (el.shadowRoot) scan(el.shadowRoot, offsetLeft, offsetTop);
      });
    } catch(_) {}
    try {
      root.querySelectorAll("iframe").forEach(function(fr) {
        try {
          var frRect = fr.getBoundingClientRect();
          var doc = fr.contentDocument || fr.contentWindow.document;
          if (doc && doc.body) {
            scan(doc.body, offsetLeft + frRect.left, offsetTop + frRect.top);
          }
        } catch(_) {}
      });
    } catch(_) {}
  }

  scan(document.body || document.documentElement, 0, 0);
  out = out.slice(0, 300);
  try {
    window.__navy_somIds    = newIds;
    window.__navy_somNextId = nextId;
  } catch(_) {}
  return out;
}

// Step 2: draw numbered labels onto the screenshot using OffscreenCanvas.
// outW/outH are the already-downscaled pixel dimensions from resizeScreenshotToLogical.
// scale = outW/logicalW — element coordinates (CSS pixels) are multiplied by scale
// to map onto the output canvas.
async function addSetOfMarks(dataUrl, elements, outW, outH, scale) {
  if (!elements || elements.length === 0) return null;
  try {
    const bitmap = await createImageBitmap(dataUrlToBlob(dataUrl));
    const canvas = new OffscreenCanvas(outW, outH);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, outW, outH);
    bitmap.close();

    for (const el of elements) {
      const lx = Math.max(0, (el.x - el.w / 2) * scale);
      const ly = Math.max(0, (el.y - el.h / 2) * scale);
      const lw = Math.min(el.w * scale, outW - lx);
      const lh = Math.min(el.h * scale, outH - ly);
      if (lw < 2 || lh < 2) continue;

      // Element classes with distinct visual treatments:
      //   canvas container  → dashed cyan border + cyan pill
      //   canvas text hit   → solid green border + green pill   (from draw-call hook)
      //   canvas sprite     → solid violet border + violet pill (from drawImage hook)
      //   visual anchor     → solid amber border + amber pill   (from pixel segmentation)
      //   DOM element       → solid red border  + red pill
      const isCanvasEl     = el.isCanvas       === true;
      const isCanvasText   = el.isCanvasText   === true;
      const isCanvasSprite = el.isCanvasSprite === true;
      const isVisual       = el.isVisual       === true;
      const boxColor = isCanvasText ? "#22c55e"
                     : isCanvasSprite ? "#a855f7"
                     : isVisual ? "#f59e0b"
                     : isCanvasEl ? "#00e5ff" : "#FF3300";
      ctx.strokeStyle = boxColor;
      ctx.lineWidth   = isCanvasEl ? 2 : 1.5;
      if (isCanvasEl) {
        ctx.setLineDash([8, 4]);
      } else {
        ctx.setLineDash([]);
      }
      ctx.strokeRect(lx + 0.5, ly + 0.5, lw, lh);
      ctx.setLineDash([]);

      // Label pill
      const lbl = String(el.id);
      const fontSize = Math.max(12, Math.round(outW / 100));
      ctx.font = `bold ${fontSize}px Arial`;
      const pillW = Math.max(ctx.measureText(lbl).width + 6, 18);
      const pillH = fontSize + 4;
      const px = Math.min(lx, outW - pillW);
      const py = ly > pillH ? ly - pillH : ly;
      ctx.fillStyle = boxColor;
      if (ctx.roundRect) {
        ctx.beginPath(); ctx.roundRect(px, py, pillW, pillH, 2); ctx.fill();
      } else {
        ctx.fillRect(px, py, pillW, pillH);
      }
      ctx.fillStyle = (isCanvasEl || isVisual) ? "#000000" : "#FFFFFF";
      ctx.fillText(lbl, px + 2, py + pillH - 3);
    }

    // JPEG 0.78 — enough to preserve label text clearly; ~50% smaller than 0.95
    const outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.78 });
    const buf = await outBlob.arrayBuffer();
    const arr = new Uint8Array(buf);
    let b64 = "";
    for (let i = 0; i < arr.length; i += 8192)
      b64 += String.fromCharCode(...arr.subarray(i, Math.min(i + 8192, arr.length)));
    return btoa(b64);
  } catch (_) { return null; }
}

// Draws AI-generated canvas element labels onto a screenshot image.
// elements: [{label, x, y}] where x/y are CSS pixels (absolute viewport coords).
// scale: imgScale (screenshotScale) to convert CSS → screenshot pixels.
// Returns base64 JPEG, or null on failure.
async function addCanvasLabels(dataUrl, elements, scale, outW, outH) {
  if (!elements || elements.length === 0) return null;
  try {
    const bitmap = await createImageBitmap(dataUrlToBlob(dataUrl));
    const canvas = new OffscreenCanvas(outW, outH);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, outW, outH);
    bitmap.close();

    for (const el of elements) {
      const sx = Math.round(el.x * scale);
      const sy = Math.round(el.y * scale);
      const lbl = String(el.label);
      const fontSize = Math.max(13, Math.round(outW / 90));
      ctx.font = `bold ${fontSize}px Arial`;
      const tw = ctx.measureText(lbl).width;
      const pillW = Math.max(tw + 8, 22);
      const pillH = fontSize + 6;
      const px = Math.max(0, Math.min(sx - Math.round(pillW / 2), outW - pillW));
      const py = Math.max(pillH, sy) - pillH;

      // Green pill — visually distinct from the red DOM SOM labels
      ctx.fillStyle = "#22c55e";
      if (ctx.roundRect) {
        ctx.beginPath(); ctx.roundRect(px, py, pillW, pillH, 3); ctx.fill();
      } else {
        ctx.fillRect(px, py, pillW, pillH);
      }
      ctx.fillStyle = "#000000";
      ctx.fillText(lbl, px + (pillW - tw) / 2, py + pillH - 3);

      // Small crosshair dot at the exact click point
      ctx.strokeStyle = "#22c55e";
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(sx - 5, sy); ctx.lineTo(sx + 5, sy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(sx, sy - 5); ctx.lineTo(sx, sy + 5); ctx.stroke();
    }

    const outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 });
    const buf = await outBlob.arrayBuffer();
    const arr = new Uint8Array(buf);
    let b64 = "";
    for (let i = 0; i < arr.length; i += 8192)
      b64 += String.fromCharCode(...arr.subarray(i, Math.min(i + 8192, arr.length)));
    return btoa(b64);
  } catch (_) { return null; }
}

// -- Visual segmentation: Set-of-Marks for pixels -------------------------------
// Derives click anchors from PIXELS, with zero domain assumptions. This is what
// removes coordinate guessing on surfaces with no DOM (canvas 2D, WebGL, VNC,
// video): Navy segments the rendered image into visually distinct regions and
// offers each as a numbered anchor with exact coordinates — the same mechanism
// that makes DOM clicking reliable (som_id), applied to raw pixels.
//
// Two structural detectors, both domain-agnostic:
//   1. Grid detection — projection profiles of the edge map. Any cell-based UI
//      (boards, keypads, tile games, spreadsheets rendered on canvas) produces
//      regularly spaced full-length edge lines in both axes.
//   2. Blob detection — connected components of non-edge pixels. Buttons, cards,
//      panels and icons are flat regions bounded by edges.
// Everything runs on a downscaled work image (max 384px) in the service worker;
// the pure `_vseg*` functions below have no chrome.* dependencies so the
// algorithm is unit-testable in Node.

function _vsegGray(rgba, w, h) {
  const g = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; p < g.length; i += 4, p++) {
    g[p] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
  }
  return g;
}

function _vsegSobel(gray, w, h) {
  const mag = new Uint8ClampedArray(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = -gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1]
               +  gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1];
      const gy = -gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1]
               +  gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1];
      mag[i] = Math.min(255, (Math.abs(gx) + Math.abs(gy)) >> 2);
    }
  }
  return mag;
}

function _vsegEdgeThreshold(mag) {
  let sum = 0;
  for (let i = 0; i < mag.length; i++) sum += mag[i];
  const mean = sum / mag.length;
  let varSum = 0;
  for (let i = 0; i < mag.length; i++) { const d = mag[i] - mean; varSum += d * d; }
  const std = Math.sqrt(varSum / mag.length);
  return Math.min(96, Math.max(24, Math.round(mean + std)));
}

// Finds regularly spaced full-length edge lines along one axis.
// profile[i] = fraction of the cross-axis that is edge at position i.
// axisLen = length of this axis, used to add virtual border lines when the grid
// is flush with the region edge (Sobel cannot see lines at the boundary pixels).
// Returns line positions, or null when lines are absent or irregular.
function _vsegGridLines(profile, minGap, axisLen) {
  const LINE_FRAC = 0.35;
  // Merge consecutive above-threshold runs into single line positions.
  const lines = [];
  let runStart = -1;
  for (let i = 0; i <= profile.length; i++) {
    const on = i < profile.length && profile[i] >= LINE_FRAC;
    if (on && runStart === -1) runStart = i;
    else if (!on && runStart !== -1) {
      lines.push(Math.round((runStart + i - 1) / 2));
      runStart = -1;
    }
  }
  if (lines.length < 3) return null;
  let gaps = [];
  for (let i = 1; i < lines.length; i++) gaps.push(lines[i] - lines[i - 1]);
  let sorted = [...gaps].sort((a, b) => a - b);
  let median = sorted[Math.floor(sorted.length / 2)];
  if (median < minGap) return null;                  // too fine — texture, not cells
  // Virtual border lines: a board/keypad flush with the region edge has its
  // outermost lines AT the boundary, invisible to Sobel. If the first/last
  // detected line sits ≈ one cell-gap from the edge, the edge IS a line.
  if (lines[0] >= median * 0.7 && lines[0] <= median * 1.3) lines.unshift(0);
  const tail = (axisLen - 1) - lines[lines.length - 1];
  if (tail >= median * 0.7 && tail <= median * 1.3) lines.push(axisLen - 1);
  if (lines.length < 4) return null;                 // need ≥3 cells per axis
  gaps = [];
  for (let i = 1; i < lines.length; i++) gaps.push(lines[i] - lines[i - 1]);
  sorted = [...gaps].sort((a, b) => a - b);
  median = sorted[Math.floor(sorted.length / 2)];
  const regular = gaps.filter(g => g >= median * 0.7 && g <= median * 1.3).length;
  if (regular / gaps.length < 0.75) return null;     // irregular spacing — not a grid
  return lines;
}

// Connected components of non-edge pixels (flood fill, 4-connectivity, seed-gray
// tolerance). Flat UI faces (buttons, cards, tiles) become components; the page
// background becomes one giant component excluded by the size filter.
function _vsegBlobs(gray, mag, thr, rgba, w, h) {
  const visited = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const blobs = [];
  const totalArea = w * h;

  for (let seed = 0; seed < gray.length; seed++) {
    if (visited[seed] || mag[seed] >= thr) continue;
    const seedGray = gray[seed];
    let sp = 0;
    stack[sp++] = seed;
    visited[seed] = 1;
    let minX = w, minY = h, maxX = 0, maxY = 0, area = 0;
    let rSum = 0, gSum = 0, bSum = 0, graySum = 0, graySqSum = 0;
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % w, y = (i / w) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      area++;
      const q = i * 4;
      rSum += rgba[q]; gSum += rgba[q + 1]; bSum += rgba[q + 2];
      graySum += gray[i]; graySqSum += gray[i] * gray[i];
      // 4-neighbours
      if (x > 0)     { const n = i - 1; if (!visited[n] && mag[n] < thr && Math.abs(gray[n] - seedGray) <= 48) { visited[n] = 1; stack[sp++] = n; } }
      if (x < w - 1) { const n = i + 1; if (!visited[n] && mag[n] < thr && Math.abs(gray[n] - seedGray) <= 48) { visited[n] = 1; stack[sp++] = n; } }
      if (y > 0)     { const n = i - w; if (!visited[n] && mag[n] < thr && Math.abs(gray[n] - seedGray) <= 48) { visited[n] = 1; stack[sp++] = n; } }
      if (y < h - 1) { const n = i + w; if (!visited[n] && mag[n] < thr && Math.abs(gray[n] - seedGray) <= 48) { visited[n] = 1; stack[sp++] = n; } }
    }
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    if (bw < 8 || bh < 8) continue;                        // too small to be a control
    if (bw * bh > totalArea * 0.9) continue;               // the background itself
    if (bw > w * 0.6 && bh > h * 0.6) continue;            // near-full panel — not a target
    if (area < 48 || area / (bw * bh) < 0.30) continue;    // sparse/ring-like — not a face
    // Flatness gate: a real UI face (button, card, tile) is near-uniform inside
    // (σ ≈ 3–12 even with gradients); random noise chained through the ±48 seed
    // tolerance lands at σ ≈ 27. Gate at 18 separates the two decisively —
    // precision over recall: on pixel surfaces a hallucinated anchor is worse
    // than a missing one (the model can always fall back to scan_canvas/zoom).
    const grayMean = graySum / area;
    const grayStd = Math.sqrt(Math.max(0, graySqSum / area - grayMean * grayMean));
    if (grayStd > 18) continue;
    blobs.push({
      x: minX, y: minY, w: bw, h: bh, area,
      r: Math.round(rSum / area), g: Math.round(gSum / area), b: Math.round(bSum / area),
    });
  }

  // Suppress near-duplicates: keep largest, drop overlapping smaller ones.
  blobs.sort((a, b) => b.area - a.area);
  const kept = [];
  for (const c of blobs) {
    let dup = false;
    for (const k of kept) {
      const ix = Math.max(0, Math.min(c.x + c.w, k.x + k.w) - Math.max(c.x, k.x));
      const iy = Math.max(0, Math.min(c.y + c.h, k.y + k.h) - Math.max(c.y, k.y));
      const inter = ix * iy;
      const iou = inter / (c.w * c.h + k.w * k.h - inter);
      if (iou > 0.55 || inter >= 0.8 * c.w * c.h) { dup = true; break; }
    }
    if (!dup) kept.push(c);
    if (kept.length >= 40) break;
  }
  return kept;
}

// Detect horizontal TEXT LABELS that the flood-fill blob pass structurally cannot
// represent: bare text (a title, a "SKIP INTRO"/"START" prompt, a score) is thin
// glyph strokes, not a filled face, so it never becomes a blob — leaving a canvas/
// WebGL label with no anchor at any contrast. This runs at a LOWERED edge threshold
// so faint labels still register, and returns wide, sparsely-inked horizontal bands.
// The caller gates it to SPARSE surfaces (no grid, few blobs) so it can never flood a
// busy game frame with noise — precision over recall stays the rule everywhere else.
function _vsegTextBands(gray, mag, w, h, baseThr) {
  const loThr = Math.max(10, baseThr >> 1);
  // Row edge-density at the lowered threshold.
  const rowN = new Int32Array(h);
  for (let y = 0; y < h; y++) {
    let n = 0; const base = y * w;
    for (let x = 0; x < w; x++) if (mag[base + x] >= loThr) n++;
    rowN[y] = n;
  }
  // A line of text is a run of rows whose edge density sits in a MIDDLE band: dense
  // enough to be glyph strokes, not so dense it is a solid rule or filled block.
  const MIN = w * 0.015, MAX = w * 0.55;
  const bands = [];
  let y0 = -1;
  for (let y = 0; y <= h; y++) {
    const on = y < h && rowN[y] >= MIN && rowN[y] <= MAX;
    if (on && y0 === -1) y0 = y;
    else if (!on && y0 !== -1) { const bh = y - y0; if (bh >= 5 && bh <= 64) bands.push([y0, y]); y0 = -1; }
  }
  const out = [];
  for (const [by0, by1] of bands) {
    let minX = w, maxX = -1, edgeN = 0;
    for (let y = by0; y < by1; y++) {
      const base = y * w;
      for (let x = 0; x < w; x++) if (mag[base + x] >= loThr) { if (x < minX) minX = x; if (x > maxX) maxX = x; edgeN++; }
    }
    if (maxX < 0) continue;
    const bw = maxX - minX + 1, bh = by1 - by0;
    if (bw < 14 || bw > w * 0.95) continue;   // too short to be a label, or a full-width rule
    if (bw < bh * 1.3) continue;              // labels read wider than tall
    const fill = edgeN / (bw * bh);
    // Reject a solid block (edges only at its border → very low fill) and pure noise
    // (nearly every pixel an edge). The upper bound is generous because downscaling a
    // small label blurs its glyphs into a denser edge mass; noise is already excluded
    // upstream by the row-density MAX gate, so this bound only needs to spare real text.
    if (fill < 0.03 || fill > 0.6) continue;
    out.push({ x: minX, y: by0, w: bw, h: bh, dens: edgeN });
  }
  // Bound the count: keep the few strongest (widest × densest) so a textured band
  // cannot spray dozens of anchors even on the surfaces where this pass is allowed.
  out.sort((a, b) => (b.w * b.dens) - (a.w * a.dens));
  return out.slice(0, 6);
}

const _VSEG_PALETTE = [
  ["black", 15, 15, 15], ["white", 245, 245, 245], ["gray", 128, 128, 128],
  ["red", 210, 55, 55], ["orange", 235, 145, 45], ["yellow", 230, 215, 70],
  ["green", 75, 175, 85], ["teal", 60, 185, 185], ["blue", 65, 110, 225],
  ["purple", 150, 85, 215], ["pink", 230, 120, 175], ["brown", 140, 95, 55],
];

function _vsegColorName(r, g, b) {
  let best = "gray", bestD = Infinity;
  for (const [name, pr, pg, pb] of _VSEG_PALETTE) {
    const d = (r - pr) * (r - pr) + (g - pg) * (g - pg) + (b - pb) * (b - pb);
    if (d < bestD) { bestD = d; best = name; }
  }
  return best;
}

// Full analysis of one RGBA work image. Returns work-pixel-space results:
//   grid:  { cols, rows, cells: [{x,y,w,h,row,col,content}] } | null
//   blobs: [{x,y,w,h,r,g,b}]  (centers NOT yet computed; x/y = top-left)
function _vsegAnalyze(rgba, w, h) {
  const gray = _vsegGray(rgba, w, h);
  const mag = _vsegSobel(gray, w, h);
  const thr = _vsegEdgeThreshold(mag);

  // Projection profiles: fraction of edge pixels per column / per row.
  const colProf = new Float32Array(w);
  const rowProf = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mag[y * w + x] >= thr) { colProf[x] += 1; rowProf[y] += 1; }
    }
  }
  for (let x = 0; x < w; x++) colProf[x] /= h;
  for (let y = 0; y < h; y++) rowProf[y] /= w;

  const colLines = _vsegGridLines(colProf, 6, w);
  const rowLines = _vsegGridLines(rowProf, 6, h);

  let grid = null;
  if (colLines && rowLines) {
    const nCells = (colLines.length - 1) * (rowLines.length - 1);
    if (nCells >= 6 && nCells <= 100) {
      const cells = [];
      for (let r = 0; r < rowLines.length - 1; r++) {
        for (let c = 0; c < colLines.length - 1; c++) {
          const cx = colLines[c], cy = rowLines[r];
          const cw = colLines[c + 1] - cx, ch = rowLines[r + 1] - cy;
          if (cw < 8 || ch < 8) continue;
          // Content probe: edge density in the cell interior (inset 20% to
          // exclude the gridlines themselves). A glyph/piece/icon drawn in the
          // cell produces interior edges; an empty cell is flat.
          const ix0 = cx + Math.round(cw * 0.2), ix1 = cx + Math.round(cw * 0.8);
          const iy0 = cy + Math.round(ch * 0.2), iy1 = cy + Math.round(ch * 0.8);
          let edgeN = 0, total = 0;
          for (let yy = iy0; yy < iy1; yy++) {
            for (let xx = ix0; xx < ix1; xx++) {
              total++;
              if (mag[yy * w + xx] >= thr) edgeN++;
            }
          }
          cells.push({ x: cx, y: cy, w: cw, h: ch, row: r + 1, col: c + 1,
                       content: total > 0 && edgeN / total >= 0.05 });
        }
      }
      if (cells.length >= 6) {
        grid = { cols: colLines.length - 1, rows: rowLines.length - 1, cells,
                 bbox: { x: colLines[0], y: rowLines[0],
                         w: colLines[colLines.length - 1] - colLines[0],
                         h: rowLines[rowLines.length - 1] - rowLines[0] } };
      }
    }
  }

  let blobs = _vsegBlobs(gray, mag, thr, rgba, w, h);
  if (grid) {
    // Grid cells are the anchors inside the grid area; keep only blobs OUTSIDE
    // it (e.g. a display strip above a keypad, a side panel next to a board).
    const gb = grid.bbox;
    blobs = blobs.filter(bl => {
      const bcx = bl.x + bl.w / 2, bcy = bl.y + bl.h / 2;
      return !(bcx >= gb.x && bcx <= gb.x + gb.w && bcy >= gb.y && bcy <= gb.y + gb.h);
    });
  }
  // Bare-text pass — ONLY on sparse surfaces (no grid, few filled controls), i.e. the
  // splash/menu/title screens where a canvas draws a lone label the blob pass can't
  // catch. Skipping it whenever a grid or several blobs already exist keeps busy game
  // frames and structured UIs exactly as before (no new anchors, no regression).
  let textBands = [];
  if (!grid && blobs.length < 6) textBands = _vsegTextBands(gray, mag, w, h, thr);
  return { grid, blobs, textBands };
}

// Async wrapper: crops the given CSS-space region out of a raw screenshot,
// downscales to work resolution, runs the analysis, and maps anchors back to
// absolute CSS viewport coordinates.
// region: { left, top, w, h } in CSS px. snapW: CSS viewport width of the shot.
// Returns [{ x, y, w, h, kind: 'cell'|'region', label }] — x/y are CENTERS, CSS px.
async function segmentCanvasRegions(rawDataUrl, snapW, region) {
  try {
    if (!region || region.w < 60 || region.h < 60) return [];
    const bitmap = await createImageBitmap(dataUrlToBlob(rawDataUrl));
    const dpr = bitmap.width / snapW;
    const srcX = Math.max(0, region.left * dpr);
    const srcY = Math.max(0, region.top * dpr);
    const srcW = Math.min(bitmap.width - srcX, region.w * dpr);
    const srcH = Math.min(bitmap.height - srcY, region.h * dpr);
    if (srcW < 30 || srcH < 30) { bitmap.close(); return []; }

    // Work resolution. Blob detection finds a control by flood-filling its uniform
    // face out to the strong edges of its border, so a border must SURVIVE the
    // downscale to this work image. A typical UI border is 1–2 CSS px: at 384 a
    // 1000px-wide surface is squeezed to ~0.37×, the border anti-aliases away, and
    // outlined controls dissolve into the background — only big saturated shapes
    // (titles, logos) still register. 768 keeps a 1px border on a ~1000px surface
    // above the Sobel threshold while staying a cheap O(n) pass in the worker.
    // Measured on a 1044px Flash/Ruffle title screen with three outlined menu buttons:
    //   384 → 8 anchors, 0 of 3 buttons found;  768 → 20 anchors, 2 of 3 found.
    // Costs 4x the pixels of a Sobel + flood-fill pass (still O(n), tens of ms in the
    // worker) and buys the difference between "no canvas control has a som_id" and
    // "most do". Raise further only with a measurement — see the note below on why
    // resolution is the binding constraint, not the thresholds.
    const WORK_MAX = 768;
    const ds = Math.min(1, WORK_MAX / Math.max(srcW, srcH));
    const workW = Math.max(16, Math.round(srcW * ds));
    const workH = Math.max(16, Math.round(srcH * ds));
    const canvas = new OffscreenCanvas(workW, workH);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, srcX, srcY, srcW, srcH, 0, 0, workW, workH);
    bitmap.close();
    const rgba = ctx.getImageData(0, 0, workW, workH).data;

    const { grid, blobs, textBands } = _vsegAnalyze(rgba, workW, workH);

    // work px → CSS px: work → source device px (÷ds) → CSS (÷dpr).
    // Origin and extents use the CLAMPED source rect so a region that pokes
    // outside the screenshot still maps every anchor to its true CSS position.
    const kx = srcW / (workW * dpr);
    const ky = srcH / (workH * dpr);
    const originX = srcX / dpr;
    const originY = srcY / dpr;
    const cssX = (wx) => Math.round(originX + wx * kx);
    const cssY = (wy) => Math.round(originY + wy * ky);

    const anchors = [];
    if (grid) {
      for (const cell of grid.cells) {
        anchors.push({
          x: cssX(cell.x + cell.w / 2), y: cssY(cell.y + cell.h / 2),
          w: Math.max(8, Math.round(cell.w * kx)), h: Math.max(8, Math.round(cell.h * ky)),
          kind: "cell",
          label: `cell r${cell.row}c${cell.col}${cell.content ? " (content)" : " (empty)"}`,
        });
      }
    }
    for (const bl of blobs) {
      const wCss = Math.max(8, Math.round(bl.w * kx));
      const hCss = Math.max(8, Math.round(bl.h * ky));
      anchors.push({
        x: cssX(bl.x + bl.w / 2), y: cssY(bl.y + bl.h / 2),
        w: wCss, h: hCss,
        kind: "region",
        label: `${_vsegColorName(bl.r, bl.g, bl.b)} region ${wCss}×${hCss}`,
      });
    }
    for (const tb of (textBands || [])) {
      const wCss = Math.max(10, Math.round(tb.w * kx));
      const hCss = Math.max(8, Math.round(tb.h * ky));
      anchors.push({
        x: cssX(tb.x + tb.w / 2), y: cssY(tb.y + tb.h / 2),
        w: wCss, h: hCss,
        kind: "text",
        label: `text label ${wCss}×${hCss}`,
      });
    }
    return anchors;
  } catch (e) {
    console.warn("[vseg] segmentation failed:", e);
    return [];
  }
}

// -- Form state ---------------------------------------------------------------
// Reads the current value of every visible form field so the LLM gets explicit
// DOM state rather than inferring values from a screenshot.

function _getFormStatePage() {
  var els = document.querySelectorAll(
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]),' +
    'textarea, select'
  );
  var fields = [];
  var deadline = Date.now() + 400;
  for (var i = 0; i < els.length && fields.length < 30; i++) {
    if (Date.now() > deadline) break;
    var el = els[i];
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    var name = (el.name || el.id || el.getAttribute('aria-label') || el.placeholder || '').trim().slice(0, 40);
    var type = el.tagName === 'SELECT' ? 'select' : (el.type || 'text');
    var value = '';
    if (el.tagName === 'SELECT') {
      value = Array.prototype.map.call(el.selectedOptions || [], function(o) { return o.text.trim(); }).join(', ');
    } else if (type === 'checkbox' || type === 'radio') {
      value = el.checked ? 'checked' : 'unchecked';
    } else {
      value = (el.value || '').slice(0, 100);
    }
    var autocomplete = (el.getAttribute && el.getAttribute('autocomplete')) || '';
    if (name || value) fields.push({ name: name, type: type, value: value, autocomplete: autocomplete });
  }
  return fields;
}

async function getFormState(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: _getFormStatePage });
    return Array.isArray(res?.result) ? res.result : [];
  } catch (_) { return []; }
}

// -- Special page detection ---------------------------------------------------
// Detects CAPTCHA walls and 2FA prompts so the agent can pause and ask the user
// instead of spinning trying to automate something it cannot solve.

function _detectSpecialPagePage() {
  var title = document.title ? document.title.toLowerCase() : '';
  var body = document.body ? document.body.innerText.toLowerCase().slice(0, 3000) : '';

  // Purely behavioral/structural detection — NO vendor domains or brand class
  // names. Matches only the generic common-noun tokens ("captcha"/"challenge"/
  // "verify") and displayed page text, plus challenge input/widget structure.
  // The exact challenge form is identified visually by the model (see R18); the
  // detector only needs to flag WHICH kind of handling applies.

  // Structural widget signals (generic tokens only).
  var challengeIframe = document.querySelector(
    'iframe[src*="captcha" i], iframe[title*="captcha" i], iframe[title*="challenge" i], iframe[title*="verify" i]'
  );
  var challengeWidget = document.querySelector(
    '[class*="captcha" i], [id*="captcha" i], [class*="challenge" i], [id*="challenge" i]'
  );
  var captchaImage = document.querySelector('img[src*="captcha" i], canvas[id*="captcha" i]');
  var captchaInput = document.querySelector('input[name*="captcha" i], input[id*="captcha" i]');

  // Behavioral text signals (what the page displays).
  var robotKeywords = body.includes('not a robot') || body.includes("i'm human") ||
    body.includes('verify you are human') || body.includes('are you human') ||
    body.includes('prove you') || body.includes('press & hold') || body.includes('press and hold');
  var captchaKeyword = body.includes('captcha') || title.includes('captcha');

  // JS auto-challenge interstitial — detected by displayed text + a challenge
  // form/iframe structure (no vendor attributes). The page auto-solves via JS.
  var jsChallengeText = title.includes('just a moment') || title.includes('checking your browser') ||
    body.includes('verifying you are human') || body.includes('checking if the site connection is secure') ||
    body.includes('enable javascript and cookies to continue');
  if (jsChallengeText && (document.querySelector('form[id*="challenge" i], [id*="challenge" i]') || challengeIframe)) {
    return 'js_challenge';
  }

  // Text/image CAPTCHA — distorted-character image + a text field. Distinct
  // because the action differs (read the characters, then type them).
  if ((captchaKeyword || robotKeywords) && captchaImage && (captchaInput || document.querySelector('input[type="text"]'))) {
    return 'captcha_text';
  }

  // Interactive challenge (checkbox / image-grid / audio / slide-puzzle). The
  // model identifies the exact form visually and handles it per the unified hint.
  if (challengeIframe || (challengeWidget && (robotKeywords || captchaKeyword)) ||
      (robotKeywords && (captchaImage || captchaInput))) {
    return 'captcha_interactive';
  }

  // 2FA / OTP — keyword + input structure.
  var otpInput = document.querySelector('input[autocomplete="one-time-code"]');
  var singleDigitInputs = document.querySelectorAll('input[type="text"][maxlength="1"], input[type="number"][maxlength="1"]');
  var has2FAKeywords = body.includes('verification code') || body.includes('one-time') ||
    body.includes('two-factor') || body.includes('authenticator') ||
    body.includes('enter the code') || body.includes('6-digit') ||
    body.includes('sent you a code') || body.includes('check your phone') ||
    body.includes('check your email and enter');
  if (otpInput || singleDigitInputs.length >= 4 || has2FAKeywords) return '2fa_required';
  return '';
}

async function detectSpecialPage(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: _detectSpecialPagePage });
    return res?.result || '';
  } catch (_) { return ''; }
}

// -- Canvas environment helpers -----------------------------------------------
// These functions run in page context and are used for:
//  1. Detecting HTML5 game/VNC frameworks so the LLM gets tailored guidance
//  2. Taking canvas pixel hashes to detect visual changes (page_changed on canvas apps)
//  3. Auto zoom-cropping large canvas elements when no SOM elements produce crops

function _getCanvasHashesPage() {
  var result = [];
  document.querySelectorAll('canvas').forEach(function(c) {
    var r = c.getBoundingClientRect();
    if (r.width < 100 || r.height < 100) return;
    try {
      var tc = document.createElement('canvas');
      tc.width = 8; tc.height = 8;
      tc.getContext('2d').drawImage(c, 0, 0, c.width, c.height, 0, 0, 8, 8);
      result.push(tc.toDataURL('image/jpeg', 0.1).slice(-20));
    } catch (e) { result.push('x'); } // cross-origin canvas blocked — that's ok
  });
  return result.join('|');
}

async function getCanvasHashes(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: _getCanvasHashesPage });
    return res?.result || '';
  } catch (_) { return ''; }
}

function _detectCanvasEnvPage() {
  // A top-document-only check returns '' for the single most common shape of canvas app:
  // the whole thing living inside an embedded frame. The model then never receives its
  // canvas guidance. Look across same-origin frames and open shadow roots, and also
  // accept a large DOM-opaque (cross-origin) frame — its interior is pixels to us, which
  // is the same situation from the agent's point of view.
  var _hasSurface = (function () {
    var found = false;
    (function walk(root, depth) {
      if (found || depth > 5) return;
      try { if (root.querySelector('canvas')) { found = true; return; } } catch (_) {}
      try {
        root.querySelectorAll('*').forEach(function (el) { if (el.shadowRoot) walk(el.shadowRoot, depth + 1); });
      } catch (_) {}
      try {
        root.querySelectorAll('iframe').forEach(function (fr) {
          var idoc = null;
          try { idoc = fr.contentDocument; } catch (_) { idoc = null; }
          if (idoc) { walk(idoc, depth + 1); return; }
          var r = fr.getBoundingClientRect();
          var vp = Math.max(1, window.innerWidth * window.innerHeight);
          if (r.width * r.height >= vp * 0.25) found = true;   // opaque frame IS the surface
        });
      } catch (_) {}
    })(document, 0);
    return found;
  })();
  if (!_hasSurface) return '';
  // noVNC / Guacamole remote desktop
  if (window._rfb || document.querySelector('#noVNC_canvas, canvas[id*="vnc"], canvas[id*="guac"]')) return 'novnc';
  // Unity WebGL
  if (window.unityInstance || (window.Module && typeof window.Module.SetFullscreen === 'function')) return 'unity_webgl';
  // Phaser (v2/v3)
  if (window.Phaser || (window.game && window.game.scene)) return 'phaser';
  // PixiJS
  if (window.PIXI && window.PIXI.VERSION) return 'pixijs';
  // Babylon.js
  if (window.BABYLON && window.BABYLON.Engine) return 'babylonjs';
  // Konva (used in diagram tools, whiteboards)
  if (window.Konva) return 'konva';
  // Generic large pixel surface — likely a game or complex app. Same traversal problem
  // as the guard above: a top-document-only scan sees nothing when the canvas lives in
  // an embedded frame, so the env silently comes back '' for the exact pages that need
  // it most. Reuse the cross-frame surface check and apply the size gate there.
  var large = false;
  (function walk(root, depth) {
    if (large || depth > 5) return;
    try {
      root.querySelectorAll('canvas').forEach(function (c) {
        var r = c.getBoundingClientRect();
        if (r.width > 400 && r.height > 300) large = true;
      });
    } catch (_) {}
    try {
      root.querySelectorAll('*').forEach(function (el) { if (el.shadowRoot) walk(el.shadowRoot, depth + 1); });
    } catch (_) {}
    try {
      root.querySelectorAll('iframe').forEach(function (fr) {
        var idoc = null;
        try { idoc = fr.contentDocument; } catch (_) { idoc = null; }
        if (idoc) { walk(idoc, depth + 1); return; }
        var r = fr.getBoundingClientRect();
        var vp = Math.max(1, window.innerWidth * window.innerHeight);
        if (r.width * r.height >= vp * 0.25) large = true;
      });
    } catch (_) {}
  })(document, 0);
  return large ? 'canvas_app' : '';
}

async function detectCanvasEnv(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: _detectCanvasEnvPage });
    return res?.result || '';
  } catch (_) { return ''; }
}

// Finds the largest region of the page whose contents the DOM cannot explain — the
// region where pixels are the only available handle. Three ways that happens:
//
//   1. <canvas>            — pixels by definition. Walk same-origin iframes too: a
//                            canvas app is very often the ENTIRE content of an embedded
//                            frame, and a top-document-only query returns null for
//                            those, silently disabling visual segmentation.
//   2. shadow-root canvas  — querySelectorAll does not pierce shadow roots, so a canvas
//                            inside a custom element (players, embedded runtimes) is
//                            invisible to a plain query even same-origin.
//   3. cross-origin iframe — contentDocument is null, so we can never enumerate what is
//                            inside. That is exactly the definition of "the DOM cannot
//                            explain this region". We CAN still measure it: the <iframe>
//                            element lives in OUR document, so getBoundingClientRect
//                            works, and CDP screenshots composite the frame's pixels in.
//                            So the rect plus the screenshot is all segmentation needs.
//
// Without (3), every cross-origin embedded game/app/widget yields zero anchors and the
// model gets a screenshot it can see but has no som_id to act on.
//
// `kind` lets canvas-only callers (scan_canvas, canvas geometry, the canvas-hook query)
// tell a real canvas from an opaque frame; everything that just needs a RECT — visual
// segmentation, the crop, the async-paint delay — works the same for both.
function _getLargestCanvasPage() {
  var best = null;
  var viewportArea = Math.max(1, (window.innerWidth || 1) * (window.innerHeight || 1));
  function consider(r, dx, dy, kind) {
    if (r.width < 200 || r.height < 150) return;
    var area = r.width * r.height;
    // An opaque cross-origin frame only counts as THE pixel surface of the page when it
    // is actually the page's main surface. Ordinary sites are full of small third-party
    // frames — ads, video embeds, social buttons, comment widgets — and every one of them
    // is cross-origin and DOM-opaque. Without a size floor the first such frame becomes
    // "the canvas": segmentation burns CPU producing junk anchors over an advert, every
    // action pays the canvas paint-delay, and clicks inside it get reclassified as pixel
    // clicks. A real embedded app/game fills a large share of the viewport; an ad does
    // not. A genuine <canvas> needs no such gate — it IS pixels wherever it appears.
    if (kind === 'opaque-frame' && area < viewportArea * 0.25) return;
    if (best && area <= best.area) return;
    best = { cx: Math.round(r.left + dx + r.width / 2),
             cy: Math.round(r.top  + dy + r.height / 2),
             w: Math.round(r.width), h: Math.round(r.height),
             area: area, kind: kind };
  }
  function walk(root, dx, dy, depth) {
    if (depth > 5) return;
    try {
      root.querySelectorAll('canvas').forEach(function(c) {
        consider(c.getBoundingClientRect(), dx, dy, 'canvas');
      });
    } catch (_) {}
    // Pierce open shadow roots — a plain querySelectorAll stops at the boundary.
    try {
      root.querySelectorAll('*').forEach(function(el) {
        if (el.shadowRoot) walk(el.shadowRoot, dx, dy, depth + 1);
      });
    } catch (_) {}
    try {
      root.querySelectorAll('iframe').forEach(function(fr) {
        var ir = fr.getBoundingClientRect();   // works even cross-origin
        var idoc = null;
        try { idoc = fr.contentDocument; } catch (_) { idoc = null; }
        if (idoc) {
          walk(idoc, dx + ir.left, dy + ir.top, depth + 1);
        } else {
          // Opaque to the DOM — pixels are the only handle we will ever get here.
          consider(ir, dx, dy, 'opaque-frame');
        }
      });
    } catch (_) {}
  }
  walk(document, 0, 0, 0);
  return best;
}

// Returns the coordinate mapping info for the largest canvas:
// CSS dimensions, pixel buffer dimensions, DPR scale, and noVNC remote framebuffer size.
// Lets the agent compute exact CSS offsets from canvas-local or VNC coordinates.
function _getCanvasGeometryPage() {
  // Must select the SAME canvas _getLargestCanvasPage does, or the coordinate formula
  // handed to the model describes a different surface than the one Navy segments and
  // clicks. A top-document-only query returns null for an iframed canvas (the common
  // "the whole app is an embedded canvas" case), and on a page with a small top-level
  // canvas beside a large iframed one it would describe the small one. Walk same-origin
  // frames and open shadow roots, exactly as the segmentation side does.
  var best = null, bestArea = 0;
  function walk(root, depth) {
    if (depth > 5) return;
    try {
      root.querySelectorAll('canvas').forEach(function (c) {
        var a = c.offsetWidth * c.offsetHeight;
        if (a > bestArea) { bestArea = a; best = c; }
      });
    } catch (_) {}
    try {
      root.querySelectorAll('*').forEach(function (el) {
        if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
      });
    } catch (_) {}
    try {
      root.querySelectorAll('iframe').forEach(function (fr) {
        var idoc = null;
        try { idoc = fr.contentDocument; } catch (_) { idoc = null; }  // cross-origin → opaque
        if (idoc) walk(idoc, depth + 1);
      });
    } catch (_) {}
  }
  walk(document, 0);
  if (!best) return null;
  var r = best.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  var geo = {
    cssW: Math.round(r.width), cssH: Math.round(r.height),
    pixelW: best.width || Math.round(r.width),
    pixelH: best.height || Math.round(r.height),
    scaleX: parseFloat(((best.width || r.width) / r.width).toFixed(3)),
    scaleY: parseFloat(((best.height || r.height) / r.height).toFixed(3))
  };
  try {
    if (window._rfb) {
      geo.vncFbW = window._rfb._fb_width || null;
      geo.vncFbH = window._rfb._fb_height || null;
    }
  } catch (_) {}
  return geo;
}

async function getCanvasGeometry(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: _getCanvasGeometryPage });
    return res?.result || null;
  } catch (_) { return null; }
}

// Reads structured state from JS-accessible game frameworks (Phaser, PixiJS, Konva, Babylon.js).
// This is the "game internal state" — works for any game that runs in JS, not WASM.
function _getGameStatePage() {
  var out = { framework: '', objects: [], raw: '' };
  try {
    if (window.game && window.game.scene) {
      out.framework = 'phaser3';
      var active = null;
      try { active = window.game.scene.scenes.filter(function(s) { return s.sys && s.sys.isActive(); })[0]; } catch (_) {}
      if (active) {
        out.objects = ((active.children && active.children.list) || []).slice(0, 40).map(function(o) {
          return { type: (o.type || (o.constructor && o.constructor.name) || '?'),
                   name: o.name || '', x: Math.round(o.x || 0), y: Math.round(o.y || 0),
                   visible: o.visible !== false, text: o.text || o._text || '',
                   texture: (o.texture && o.texture.key) ? o.texture.key : '' };
        });
        try {
          var entries = active.data && active.data.entries ? Array.from(active.data.entries) : [];
          out.raw = JSON.stringify(Object.fromEntries(entries)).slice(0, 400);
        } catch (_) {}
      }
    } else if (window.Phaser && window.Phaser.Game) {
      // Phaser 2 / older structure
      out.framework = 'phaser2';
    } else if (window.PIXI) {
      out.framework = 'pixijs';
      var app = window.__PIXI_APP__ || window.app;
      if (app && app.stage) {
        (function flatten(container, depth) {
          if (depth > 3 || out.objects.length >= 30) return;
          (container.children || []).forEach(function(c) {
            out.objects.push({ type: (c.constructor ? c.constructor.name : '?'),
              x: Math.round(c.x || 0), y: Math.round(c.y || 0), visible: c.visible !== false,
              text: c.text || '', name: c.label || c.name || '' });
            flatten(c, depth + 1);
          });
        })(app.stage, 0);
      }
    } else if (window.Konva && window.Konva.stages && window.Konva.stages.length) {
      out.framework = 'konva';
      try {
        out.objects = window.Konva.stages[0].find('Text').slice(0, 30).map(function(n) {
          return { type: 'Text', text: n.text ? n.text() : '', x: Math.round(n.x()), y: Math.round(n.y()), visible: n.visible() };
        });
      } catch (_) {}
    } else if (window.BABYLON && window.BABYLON.Engine && window.BABYLON.Engine.Instances.length) {
      out.framework = 'babylonjs';
      try {
        var babylonScene = window.BABYLON.Engine.Instances[0].scenes[0];
        if (babylonScene) {
          out.objects = babylonScene.meshes.slice(0, 20).map(function(m) {
            return { type: 'mesh', name: m.name, visible: m.isVisible,
                     x: Math.round(m.position.x), y: Math.round(m.position.y), z: Math.round(m.position.z) };
          });
        }
      } catch (_) {}
    }
  } catch (_) {}
  return out;
}

async function getGameState(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: _getGameStatePage });
    const r = res?.result;
    return (r && r.framework) ? r : null;
  } catch (_) { return null; }
}

// Page function: finds iframes whose contentDocument is cross-origin (SecurityError).
// Returns basic metadata so the LLM knows cross-origin widgets are present and
// can suggest navigating to them directly instead of failing silently.
function _detectCrossOriginIframesPage() {
  var out = [];
  document.querySelectorAll('iframe').forEach(function(fr) {
    try { void fr.contentDocument; }
    catch(e) {
      if (e instanceof DOMException) {
        var r = fr.getBoundingClientRect();
        if (r.width > 10 && r.height > 10) {
          out.push({
            src: fr.src || fr.getAttribute('src') || '',
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2),
            w: Math.round(r.width),
            h: Math.round(r.height),
          });
        }
      }
    }
  });
  return out;
}

async function detectCrossOriginIframes(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: _detectCrossOriginIframesPage });
    return Array.isArray(res?.result) ? res.result : [];
  } catch (_) { return []; }
}

// -- File download tracking ---------------------------------------------------
// Consumed once per snapshot so the agent knows a download was triggered.
let pendingDownloadInfo = null;
chrome.downloads.onCreated.addListener(function(item) {
  if (!STATE.running) return;
  const name = (item.filename || item.url || '').split(/[/\\]/).pop().slice(0, 80) || 'file';
  pendingDownloadInfo = { filename: name, url: item.url || '' };
});

// -- Snapshot -----------------------------------------------------------------

// Returns the CSS viewport size (content area, excluding browser chrome).
// Cross-checks two sources and takes the larger height:
//   • Page.getLayoutMetrics.cssLayoutViewport — authoritative for width, but
//     reports the REDUCED viewport when the Navy panel is docked (e.g. bottom
//     panel halves the page viewport height).
//   • window.innerHeight from the page — also reflects the reduced viewport,
//     but in some panel configurations agrees with the visual tab height better.
// Taking Math.max of both avoids clipping the screenshot to half-height when
// the panel layout makes cssLayoutViewport shorter than the visible page area.
async function getViewportSize(tabId) {
  let metricsW = 0, metricsH = 0;
  try {
    const { cssLayoutViewport } = await sendCDP(tabId, "Page.getLayoutMetrics");
    if (cssLayoutViewport && cssLayoutViewport.clientWidth > 0 && cssLayoutViewport.clientHeight > 0) {
      metricsW = Math.round(cssLayoutViewport.clientWidth);
      metricsH = Math.round(cssLayoutViewport.clientHeight);
    }
  } catch (_) {}

  // Also ask the page itself — window.innerHeight is the visual viewport height
  // and may differ from cssLayoutViewport when the panel affects layout metrics.
  let innerH = 0;
  try {
    const r = await sendCDP(tabId, "Runtime.evaluate", {
      expression: "window.innerHeight || 0",
      returnByValue: true,
    });
    const v = r?.result?.value;
    if (typeof v === "number" && v > 0) innerH = Math.round(v);
  } catch (_) {}

  const h = Math.max(metricsH, innerH);
  if (metricsW > 0 && h > 0) return { w: metricsW, h };

  // Last resort: both CDP paths failed (e.g. debugger detached mid-call). Read the
  // viewport directly via chrome.scripting, which doesn't need the debugger.
  // (The old code used tab.width/height, which don't exist on Tab objects and so
  // always fell through to a hardcoded 1920×1080.)
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: Number(tabId) },
      func: () => ({ w: window.innerWidth, h: window.innerHeight }),
    });
    if (result && result.w > 0 && result.h > 0) {
      return { w: Math.round(result.w), h: Math.round(result.h) };
    }
  } catch (_) {}
  return { w: 1280, h: 800 };
}

// Race a promise against a timeout. Returns the promise result or throws on timeout.
// Tagged cancellation error — lets the agent loop recognize a clean stop
// (task cancelled / tab closed) by property, not by matching the message string,
// so rewording the message can't silently turn a cancel into a scary failure.
function cancellationError() {
  const e = new Error("Tab was closed or task was cancelled");
  e.navyCancelled = true;
  return e;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

async function takeSnapshot(tabId, forceFresh = false) {
  if (!tabId || isNaN(Number(tabId))) {
    throw new Error("Invalid tabId (task cancelled or detached)");
  }
  tabId = Number(tabId);
  const tab = await chrome.tabs.get(tabId);
  if (tab && tab.url !== STATE.lastUrl) {
    STATE.shadowSomIds = {};
    STATE.shadowSomNextId = 2000;
  }
  // Use Page.getLayoutMetrics for exact CSS viewport (excludes browser chrome height)
  const { w: logicalW, h: logicalH } = await getViewportSize(tabId);

  let scrollPosStr = "";
  try {
    const { result } = await sendCDP(tabId, "Runtime.evaluate", {
      expression: `(function(){
        var scrollY = Math.round(window.scrollY);
        var viewH = Math.round(window.innerHeight);
        var pageHeight = Math.round(document.documentElement.scrollHeight);
        var pct = pageHeight > 0 ? Math.round((scrollY / pageHeight) * 100) : 0;
        var below = Math.max(0, pageHeight - scrollY - viewH);
        var pagesBelow = viewH > 0 ? Math.round((below / viewH) * 10) / 10 : 0;
        return {
          scroll: "scrollY=" + scrollY + " / pageHeight=" + pageHeight + " (" + pct + "% scrolled, " + below + "px below fold ~ " + pagesBelow + " viewports of unseen content)"
        };
      })()`,
      returnByValue: true
    });
    if (result && result.value) {
      scrollPosStr = `<SCROLL_POS>${result.value.scroll}</SCROLL_POS>`;
    }
  } catch (_) {}

  // Probe page mutation state cheaply via Runtime.evaluate before trusting the cache.
  let pageMutationDirty = false;
  try {
    const { result: mutCheck } = await sendCDP(tabId, "Runtime.evaluate", {
      expression: `(function(){return !!(window.__navy_element_map_dirty && (Date.now() - (window.__navy_last_mutation||0) < 30000));})()`,
      returnByValue: true,
    });
    pageMutationDirty = !!(mutCheck && mutCheck.value);
    // Clear the flag once we have observed it; we will rebuild the map now.
    if (pageMutationDirty) {
      sendCDP(tabId, "Runtime.evaluate", {
        expression: `(function(){window.__navy_element_map_dirty=false;window.__navy_last_mutation=0;})()`,
        returnByValue: true,
      }).catch(() => {});
    }
  } catch (_) {}

  // The interactive ELEMENT MAP (the expensive ~1.8s DOM scan) may be reused when the page
  // is provably unchanged. The SCREENSHOT is NEVER reused: a page can repaint its pixels
  // (canvas/video redraw, CSS or SVG animation, SPA content swap) WITHOUT tripping any of
  // these DOM-level signals, so a cached screenshot can silently go stale — the planner
  // then acts on the previous step's image, which is the top cause of "clicked the wrong
  // thing / thought nothing happened" failures. Re-capturing costs a little latency, not
  // tokens: a screenshot is sent to the model every step whether it is fresh or cached.
  const canReuseElementMap = !forceFresh &&
                      !STATE.elementMapDirty &&
                      !pageMutationDirty &&
                      tab.url === STATE.lastUrl &&
                      tab.title === STATE.lastTitle &&
                      scrollPosStr === STATE.lastScrollPos &&
                      logicalW === STATE.lastViewportW &&
                      logicalH === STATE.lastViewportH &&
                      Array.isArray(STATE.lastElementMapArray) && STATE.lastElementMapArray.length > 0;

  let a11yText = "";
  let a11yFailed = false;
  let visibleText = "";
  let elementMap = [];
  let screenshotB64 = null;
  let screenshotMime = "image/jpeg";
  let zoomCrops = [];

  {
    // Force the tab to be active to un-throttle requestAnimationFrame for canvas terminals.
    // EXCEPTION: never steal focus from another Navy-managed tab — when a click opens a
    // target=_blank tab, Chrome focuses it and onCreated is about to adopt it; yanking
    // activation back here caused the "new tab immediately bounces to the previous tab" bug.
    try {
      const currentTab = await chrome.tabs.get(tabId);
      if (!currentTab.active) {
        let activeIsNavyTab = false;
        try {
          const [act] = await chrome.tabs.query({ active: true, windowId: currentTab.windowId });
          activeIsNavyTab = !!act && act.id !== tabId &&
            ((STATE.tabGroupId && act.groupId === STATE.tabGroupId) ||
             (STATE.programmaticTabs && STATE.programmaticTabs.has(act.id)));
        } catch (_) {}
        if (!activeIsNavyTab) {
          await chrome.tabs.update(tabId, { active: true });
          // Give the compositor and requestAnimationFrame a tiny moment to flush
          await new Promise(r => setTimeout(r, 50));
        }
      }
    } catch (_) {}

    const [a11yRes, visibleTextRes, parsedElements] = await Promise.all([
      getFullAXTreeWithOOPIFs(tabId),
      (async () => {
        try {
          const [{ result }] = await withTimeout(
            chrome.scripting.executeScript({ target: { tabId }, func: extractVisibleText }),
            5000,
            "extractVisibleText"
          );
          return (result || "").slice(0, 12000);
        } catch (_) {
          return "";
        }
      })(),
      // Reuse the previous interactive element map when the DOM is provably unchanged;
      // otherwise pay for a fresh scan. (The screenshot below is always re-captured.)
      canReuseElementMap ? Promise.resolve(STATE.lastElementMapArray) : getInteractiveElements(tabId)
    ]);

    a11yText = a11yRes.text;
    a11yFailed = a11yRes.failed;
    visibleText = visibleTextRes;
    elementMap = parsedElements;

    // Augment element map with canvas text elements captured by the MAIN-world hook.
    // The hook intercepts CanvasRenderingContext2D.fillText/strokeText calls and
    // stores each drawn text string with its viewport position. We query it here
    // and inject the results as virtual SOM entries so the LLM can click canvas
    // text by label rather than by visual coordinate estimation.
    //
    // We also walk same-origin child iframes so that canvas-based widgets embedded
    // in frames are included. Each iframe's getBoundingClientRect() offset is added
    // to all coordinates so that returned positions are always in the main-frame
    // viewport space. Cross-origin iframes throw on contentWindow access and are
    // skipped silently — those canvases are not detectable without CDP frame eval.
    // Only when we did a FRESH element scan — a reused map already carries its canvas-text
    // entries, and re-augmenting would append duplicates with ever-incrementing ids.
    if (!canReuseElementMap) try {
      const hookResult = await sendCDP(tabId, "Runtime.evaluate", {
        expression: `(function collectCanvas(win, dx, dy) {
  var out = [];
  try {
    if (win.__navy_canvas_elements) {
      var entries = win.__navy_canvas_elements();
      if (Array.isArray(entries)) {
        for (var i = 0; i < entries.length; i++) {
          var cd = entries[i];
          var hasTexts = cd.texts && cd.texts.length;
          var hasImages = cd.images && cd.images.length;
          if (!hasTexts && !hasImages) continue;
          var adjusted = [];
          for (var j = 0; hasTexts && j < cd.texts.length; j++) {
            var t = cd.texts[j];
            adjusted.push({ text: t.text, x: t.x + dx, y: t.y + dy, w: t.w, h: t.h });
          }
          var adjustedImgs = [];
          for (var q = 0; hasImages && q < cd.images.length; q++) {
            var im = cd.images[q];
            adjustedImgs.push({ x: im.x + dx, y: im.y + dy, w: im.w, h: im.h });
          }
          out.push({ texts: adjusted, images: adjustedImgs });
        }
      }
    }
  } catch(_) {}
  try {
    var frames = win.document.querySelectorAll('iframe');
    for (var k = 0; k < frames.length; k++) {
      try {
        var iw = frames[k].contentWindow;
        if (!iw) continue;
        var r = frames[k].getBoundingClientRect();
        var sub = collectCanvas(iw, dx + r.left, dy + r.top);
        for (var m = 0; m < sub.length; m++) out.push(sub[m]);
      } catch(_) {}
    }
  } catch(_) {}
  return out;
})(window, 0, 0)`,
        returnByValue: true,
      });
      const canvasData = hookResult?.result?.value;
      if (Array.isArray(canvasData) && canvasData.length > 0) {
        // Assign IDs above the max existing DOM element ID to avoid collisions.
        let nextId = elementMap.reduce((m, e) => Math.max(m, e.id || 0), 0) + 1;
        const sprites = [];
        for (const cd of canvasData) {
          for (const t of (cd.texts || [])) {
            elementMap.push({
              id: nextId++,
              tag: "canvas-text",
              label: t.text,
              x: t.x,
              y: t.y,
              w: Math.max(t.w, 12),
              h: Math.max(t.h, 12),
              isCanvasText: true,
            });
          }
          for (const im of (cd.images || [])) sprites.push(im);
        }
        // Sprite rects from drawImage calls — buttons/pieces/cards drawn from
        // sprite sheets. Largest first; capped so sprite-heavy games can't
        // flood the map. Text stays uncapped — it is semantically richer.
        sprites.sort((a, b) => (b.w * b.h) - (a.w * a.h));
        for (const im of sprites.slice(0, 24)) {
          // Skip sprites that duplicate a text entry's position (icon behind label)
          const dup = elementMap.some(e => e.isCanvasText &&
            Math.abs(e.x - im.x) < Math.max(8, im.w / 2) && Math.abs(e.y - im.y) < Math.max(8, im.h / 2));
          if (dup) continue;
          elementMap.push({
            id: nextId++,
            tag: "canvas-sprite",
            label: `sprite ${im.w}×${im.h}`,
            x: im.x,
            y: im.y,
            w: Math.max(im.w, 12),
            h: Math.max(im.h, 12),
            isCanvasSprite: true,
          });
        }
      }
    } catch (_) {}

    let rawDataUrl = null;
    try {
      // safeCaptureScreenshot re-queries viewport size internally right before
      // the capture — use its returned w/h for all downstream operations so
      // the element overlay, zoom crops, and screenshotScale are all consistent
      // with the actual screenshot dimensions rather than the earlier measurement.
      const shot = await withTimeout(safeCaptureScreenshot(tabId, 90), 5000, "captureScreenshot");
      rawDataUrl = shot.dataUrl;
      // Refresh logicalW/H from the authoritative values returned by the capture.
      const snapW = shot.w;
      const snapH = shot.h;                         // CSS viewport height — for cache key
      let captureH = shot.captureH ?? snapH;      // actual captured height (may extend beyond viewport)

      // Locate the largest canvas ONCE — used by visual segmentation here and the
      // full-canvas crop below.
      let largestCanvas = null;
      try {
        const [ci] = await chrome.scripting.executeScript({ target: { tabId }, func: _getLargestCanvasPage });
        largestCanvas = ci?.result || null;
      } catch (_) {}

      // Visual segmentation — Set-of-Marks for pixels. Runs on EVERY capture when a
      // large canvas is present (canvas pixels change without DOM signals, so anchors
      // must be re-derived from the fresh screenshot even when the element map was
      // reused). Previous visual anchors are stripped first: they describe the OLD frame.
      elementMap = elementMap.filter(e => !e.isVisual);
      if (largestCanvas && rawDataUrl) {
        // Skip when the canvas area is already densely covered by real DOM controls
        // (chart libraries with HTML overlays) — som_ids exist there; visual anchors
        // would only duplicate them.
        const cLeft = largestCanvas.cx - largestCanvas.w / 2;
        const cTop  = largestCanvas.cy - largestCanvas.h / 2;
        const domOverCanvas = elementMap.filter(e =>
          !e.isCanvasText && !e.isCanvasSprite &&
          e.x >= cLeft && e.x <= cLeft + largestCanvas.w &&
          e.y >= cTop  && e.y <= cTop  + largestCanvas.h).length;
        if (domOverCanvas < 12) {
          try {
            const anchors = await segmentCanvasRegions(rawDataUrl, snapW,
              { left: cLeft, top: cTop, w: largestCanvas.w, h: largestCanvas.h });
            if (anchors.length > 0) {
              // Suppress anchors that duplicate ANY existing entry (DOM overlay,
              // hook text, sprite) — those already carry richer semantics.
              const fresh = anchors.filter(a => !elementMap.some(e => {
                const ix = Math.max(0, Math.min(a.x + a.w / 2, e.x + e.w / 2) - Math.max(a.x - a.w / 2, e.x - e.w / 2));
                const iy = Math.max(0, Math.min(a.y + a.h / 2, e.y + e.h / 2) - Math.max(a.y - a.h / 2, e.y - e.h / 2));
                const inter = ix * iy;
                return inter / (a.w * a.h + e.w * e.h - inter) > 0.5;
              }));
              // Dedicated id range: visual anchors never collide with DOM (small ids),
              // shadow-DOM (2000+), or hook entries (max+1 of those).
              //
              // IDs MUST be stable across snapshots. They used to be handed out by array
              // order (id: vid++), so any repaint that changed the anchor list renumbered
              // every anchor — on a calculator, entering a digit repaints the display,
              // segmentation returns a different list, and som_id 5005 silently stops
              // meaning "7". A model that read the map one step and clicked the next hit
              // the wrong key. Key each anchor by its quantised centre instead: a button
              // that stays put keeps its id, and only genuinely new regions take a new one.
              const canvasKey = `${largestCanvas.cx}:${largestCanvas.cy}:${largestCanvas.w}:${largestCanvas.h}`;
              if (STATE.visualIdCanvasKey !== canvasKey) {
                STATE.visualIdMap = {};        // different canvas (new page/app) — start over
                STATE.visualNextId = 5000;
                STATE.visualIdCanvasKey = canvasKey;
              }
              if (!STATE.visualIdMap) { STATE.visualIdMap = {}; STATE.visualNextId = 5000; }
              // The canvas rect stays constant while its CONTENTS move, so the reset above
              // never fires on a live surface: every frame of a game or video mints ids for
              // positions that will never be seen again, and the map grows for the whole
              // session. Bound it. Stability only has to span the handful of steps between
              // the model reading a som_id and clicking it, so dropping the oldest entries
              // once the map gets large costs nothing and caps the growth.
              const VISUAL_ID_MAX = 1200;
              const vkeys = Object.keys(STATE.visualIdMap);
              if (vkeys.length > VISUAL_ID_MAX) {
                // Entries were inserted in ascending id order, so the lowest ids are oldest.
                vkeys.sort((p, q) => STATE.visualIdMap[p] - STATE.visualIdMap[q])
                     .slice(0, vkeys.length - VISUAL_ID_MAX / 2)
                     .forEach(k => { delete STATE.visualIdMap[k]; });
              }
              for (const a of fresh.slice(0, 110)) {
                const akey = `${Math.round(a.x / 8)}:${Math.round(a.y / 8)}`;
                let aid = STATE.visualIdMap[akey];
                if (aid == null) {
                  aid = Math.max(5000, STATE.visualNextId || 5000);
                  STATE.visualIdMap[akey] = aid;
                  STATE.visualNextId = aid + 1;
                }
                elementMap.push({
                  id: aid,
                  tag: "visual",
                  role: a.kind === "cell" ? "grid-cell" : "visual-region",
                  label: a.label,
                  x: a.x, y: a.y, w: a.w, h: a.h,
                  isVisual: true,
                });
              }
            }
          } catch (e) {
            console.warn("[vseg] snapshot segmentation failed:", e);
          }
        }
      }

      const resized = await resizeScreenshotToLogical(rawDataUrl);
      if (resized) {
        screenshotB64 = resized.b64;
        const imgScale = resized.scale;
        const outW = resized.outW;
        const outH = resized.outH;   // exact dimensions preserving aspect ratio

        // Ensure downstream crops use the true logical height of the image to prevent Y-squash
        captureH = snapW * (resized.actualH / resized.actualW);

        if (elementMap.length > 0 && screenshotB64) {
          const somB64 = await addSetOfMarks(
            `data:image/jpeg;base64,${screenshotB64}`, elementMap, outW, outH, imgScale
          );
          if (somB64) {
            screenshotB64 = somB64;
          }
        }
        STATE.screenshotScale = imgScale;
        STATE.lastViewportW = snapW;
        STATE.lastViewportH = snapH;   // CSS viewport (not captureH) for cache comparison
      }

      // Zoom crops for dense small-element zones so the LLM can read tiny UI
      if (rawDataUrl && elementMap.length > 0) {
        const smallEls = elementMap.filter(el => el.w < 32 || el.h < 32);
        if (smallEls.length >= 3) {
          const cx = Math.round(smallEls.reduce((s, e) => s + e.x, 0) / smallEls.length);
          const cy = Math.round(smallEls.reduce((s, e) => s + e.y, 0) / smallEls.length);
          const crop = await cropScreenshotAroundCoords(rawDataUrl, cx, cy, snapW, captureH, 400, 400);
          if (crop) zoomCrops = [{ b64: crop, cx, cy }];
        }
      }
      // Always add a full-canvas crop for OCR and VNC precision (reuses the
      // largestCanvas lookup made for visual segmentation above).
      if (rawDataUrl && largestCanvas) {
        try {
          const { cx, cy, w, h } = largestCanvas;
          const crop = await cropScreenshotAroundCoords(
            rawDataUrl, cx, cy, snapW, captureH,
            Math.min(w, snapW), Math.min(h, captureH)
          );
          if (crop) zoomCrops.push({ b64: crop, cx, cy, note: 'canvas' });
        } catch (_) {}
      }
    } catch (err) {
      console.warn("Failed to capture tab screenshot:", err);
      try {
        broadcastStatus({ event: "progress", kind: "warn", thought: `Screenshot capture failed: ${err.message || err}` });
      } catch (_) {}
    }

    STATE.lastUrl = tab.url;
    STATE.lastTitle = tab.title;
    STATE.lastScrollPos = scrollPosStr;
    // Record the latest screenshot for diagnostics only — it is never reused as a
    // snapshot image (every snapshot re-captures), so there is no stale-image path here.
    STATE.lastScreenshotB64 = screenshotB64 || null;
    STATE.lastScreenshotMime = screenshotMime;
    STATE.lastZoomCrops = zoomCrops;
    STATE.lastElementMapArray = elementMap;
    STATE.elementMapDirty = false;
  }

  // Inject zoom_canvas crop queued by the previous action (shown once, never cached)
  if (STATE.pendingCanvasZoom) {
    zoomCrops = [...zoomCrops, STATE.pendingCanvasZoom];
    STATE.pendingCanvasZoom = null;
  }

  const notification = newTabHistoryEntry;
  newTabHistoryEntry = null;

  let tabListStr = "";
  try {
    const queryInfo = STATE.tabGroupId 
      ? { groupId: STATE.tabGroupId } 
      : { windowId: tab.windowId };
    const tabs = await chrome.tabs.query(queryInfo);
    tabListStr = tabs.map((t, idx) => `${idx}: ${t.title || t.url || "blank"}${t.active ? " [active]" : ""}`).join(" | ");
  } catch (_) {}

  // Detect page special states, canvas env, form values, canvas geometry, game state — all in parallel
  const [formState, detectedSpecialPage, canvasEnv, canvasGeometry, gameState, crossOriginIframes] = await Promise.all([
    getFormState(tabId).catch(() => []),
    detectSpecialPage(tabId).catch(() => ''),
    detectCanvasEnv(tabId).catch(() => ''),
    getCanvasGeometry(tabId).catch(() => null),
    getGameState(tabId).catch(() => null),
    detectCrossOriginIframes(tabId).catch(() => []),
  ]);
  // PDF detection via URL — Chrome's PDF viewer leaves no DOM body so scripting can't detect it;
  // we check tab.url directly. Prefer existing detection if it already found something.
  let specialPage = detectedSpecialPage;
  if (!specialPage) {
    try {
      const pdfUrl = tab.url || '';
      // Match bare .pdf extension (with optional query/fragment) or Chrome's viewer extension URL
      if (/\.pdf(\?[^#]*)?(#.*)?$/i.test(pdfUrl) || pdfUrl.startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai')) {
        specialPage = 'pdf_viewer';
      }
    } catch (_) {}
  }

  const downloadNotif = pendingDownloadInfo;
  pendingDownloadInfo = null;

  // Sanitize element labels — aria-label, placeholder, title, textContent are all
  // attacker-controlled page content. Run injection pattern detection before any of
  // this reaches the LLM. This closes the bypass where element labels skip sanitizePageText.
  const labelWarnings = [];
  const sanitizedMap = elementMap.map(el => {
    let out = el;
    if (el.label) {
      const { clean, warned } = sanitizeLabel(el.label, 80);
      if (warned) { labelWarnings.push(`element_label:id=${el.id}`); out = { ...out, label: clean }; }
    }
    // group is page-controlled too (a form's aria-label/id) — sanitize before it
    // reaches the model, or a crafted container name becomes a prompt-injection vector.
    if (el.group) {
      const { clean, warned } = sanitizeLabel(el.group, 40);
      if (warned) { labelWarnings.push(`element_group:id=${el.id}`); out = { ...out, group: clean }; }
    }
    // role can come straight from a page-controlled `role` attribute — same risk.
    if (el.role) {
      const { clean, warned } = sanitizeLabel(el.role, 30);
      if (warned) { labelWarnings.push(`element_role:id=${el.id}`); out = { ...out, role: clean }; }
    }
    return out;
  });

  // Sanitize form state — field names and values are also page-controlled.
  // Additionally exclude credential-like fields (OTP, PIN, token, etc.) — not just type=password.
  const sanitizedForm = formState.map(f => {
    const { clean: cleanName, warned: warnedName } = sanitizeLabel(f.name || '', 60);
    if (warnedName) labelWarnings.push(`form_name:${cleanName}`);

    let cleanValue = f.value || '';
    if (looksLikeCredentialField(f.name, f.type, f.autocomplete)) {
      cleanValue = '[credential field — value withheld]';
    } else {
      const { clean: cv, warned: warnedVal } = sanitizeLabel(f.value || '', 100);
      if (warnedVal) labelWarnings.push(`form_value:field=${f.name}`);
      cleanValue = cv;
    }
    return { name: cleanName, type: f.type, value: cleanValue };
  });

  // Consume any pending JS dialog notification — cleared here so it surfaces exactly
  // once (on the snapshot immediately after the dialog was auto-dismissed).
  let dialogNotification = null;
  if (STATE.lastDialog && (Date.now() - STATE.lastDialog.ts) < 15000) {
    dialogNotification = STATE.lastDialog;
    STATE.lastDialog = null;
  }

  return {
    url: tab.url,
    title: tab.title,
    accessibility_tree: a11yText,
    visible_text: visibleText,
    screenshot_b64: screenshotB64,
    screenshot_mime: screenshotMime,
    zoom_crops: zoomCrops,
    a11y_failed: a11yFailed,
    viewport: [logicalW, logicalH],
    injection_warnings: labelWarnings,
    element_map: sanitizedMap,
    scroll_pos: scrollPosStr,
    form_state: sanitizedForm,
    special_page: specialPage,
    canvas_env: canvasEnv,
    canvas_geometry: canvasGeometry,
    game_state: gameState,
    download_notification: downloadNotif,
    tab_list: tabListStr ? `<TAB_LIST>${tabListStr}</TAB_LIST>` : "",
    tab_notification: notification,
    cross_origin_iframes: crossOriginIframes,
    dialog_notification: dialogNotification,  // { type, message, url } or null
  };
}

// Runs in the page context — must be self-contained (no closures).
// Pierces shadow roots and same-origin iframes so content in Web Components
// (e.g. YouTube player controls, Google Meet UI) is visible to the LLM.
function extractVisibleText() {
  const SKIP = new Set(["SCRIPT","STYLE","NOSCRIPT","HEAD","META","LINK","SVG","CANVAS"]);
  const deadline = Date.now() + 2500;
  const out = [];

  function walk(root) {
    if (Date.now() > deadline || out.length >= 1000) return;
    // Fast path: innerText covers most regular pages perfectly.
    if (root === document.body || root === document.documentElement) {
      try {
        const t = root.innerText;
        if (t && t.trim()) { out.push(t.trim()); return; }
      } catch (_) {}
    }
    // Text walker for this root
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (out.length >= 1000 || Date.now() > deadline) break;
      const p = node.parentElement;
      if (!p || SKIP.has(p.tagName)) continue;
      const st = p.style;
      if (st.display === "none" || st.visibility === "hidden") continue;
      const t = node.textContent.replace(/\s+/g, " ").trim();
      if (t.length > 1) out.push(t);
    }
    // Pierce shadow roots
    try {
      root.querySelectorAll("*").forEach(el => {
        if (el.shadowRoot && Date.now() < deadline) walk(el.shadowRoot);
      });
    } catch (_) {}
    // Same-origin iframes
    try {
      root.querySelectorAll("iframe").forEach(fr => {
        try {
          const doc = fr.contentDocument || fr.contentWindow.document;
          if (doc && doc.body) walk(doc.body);
        } catch (_) {}
      });
    } catch (_) {}
  }

  // Serialize visible HTML tables as markdown before walking body text.
  // Preserves column structure that innerText collapses into flat lines.
  try {
    document.querySelectorAll("table").forEach(function(tbl) {
      var r = tbl.getBoundingClientRect();
      if (!r.width && !r.height) return;
      var rows = Array.prototype.slice.call(tbl.querySelectorAll("tr"));
      if (rows.length < 2) return;
      var mdRows = rows.map(function(tr) {
        var cells = Array.prototype.slice.call(tr.querySelectorAll("th, td")).map(function(c) {
          return (c.innerText || "").replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|").trim().slice(0, 80);
        });
        return "| " + cells.join(" | ") + " |";
      });
      var colCount = (mdRows[0].match(/\|/g) || []).length - 1;
      if (colCount < 1) return;
      var sep = "|" + new Array(colCount).fill(" --- ").join("|") + "|";
      out.push(mdRows[0] + "\n" + sep + "\n" + mdRows.slice(1).join("\n"));
    });
  } catch (_) {}

  walk(document.body || document.documentElement);
  return out.join("\n");
}

async function getFullAXTreeWithOOPIFs(tabId) {
  try {
    const a11y = await withTimeout(sendCDP(tabId, "Accessibility.getFullAXTree", {}), 8000, "getFullAXTree");
    let allNodes = a11y.nodes || [];
    for (const sessionId of STATE.childSessions.keys()) {
      try {
        const childA11y = await withTimeout(sendSessionCDP(tabId, sessionId, "Accessibility.getFullAXTree", {}), 3000, "childA11y");
        if (childA11y && childA11y.nodes) {
          for (const node of childA11y.nodes) allNodes.push(node);
        }
      } catch (_) {}
    }
    return { text: compactA11y(allNodes), failed: false };
  } catch (e) {
    return { text: `(a11y unavailable: ${e.message || e})`, failed: true };
  }
}

function compactA11y(nodes) {
  // Build a compact ref→description map for the planner. We emit lines like:
  //   [ref:42] button "Submit"
  //   [ref:43] textbox "Email" required
  //
  // Small models drown when given 400+ nodes. We prioritize INTERACTIVE roles
  // (links, buttons, inputs, menuitems) and only fall back to others if there's
  // room left. Anonymous "generic" / "none" / "presentation" containers are
  // dropped entirely — they have no name and can't be acted on usefully.
  const INTERACTIVE = new Set([
    "link", "button", "textbox", "searchbox", "combobox", "checkbox",
    "radio", "switch", "tab", "menuitem", "option", "slider", "spinbutton",
  ]);
  const SECONDARY = new Set([
    "heading", "img", "list", "listitem", "navigation", "main", "form",
    "search", "article", "section", "dialog", "alert",
  ]);

  function describe(n) {
    const role = (n.role && n.role.value) || "";
    if (!role || role === "none" || role === "presentation" || role === "generic") {
      return null;
    }
    // backendDOMNodeId is the DOM node ID used by DOM.resolveNode / DOM.getBoxModel.
    // nodeId is the AX-tree-internal ID and cannot be used for DOM operations.
    const domRef = n.backendDOMNodeId;
    if (!domRef) return null;
    const name = (n.name && n.name.value) || "";
    const value = (n.value && n.value.value) || "";
    // Drop nameless non-interactive items — they're just noise
    if (!name && !value && !INTERACTIVE.has(role)) return null;
    const props = (n.properties || [])
      .filter(p => ["required", "disabled", "checked", "expanded", "focused"].includes(p.name))
      .map(p => p.name + (p.value && p.value.value !== true ? `=${p.value.value}` : ""))
      .join(" ");
    let line = `[ref:${domRef}] ${role}`;
    if (name) line += ` "${name.slice(0, 80)}"`;
    if (value) line += ` value="${String(value).slice(0, 40)}"`;
    if (props) line += ` ${props}`;
    return line;
  }

  const interactive = [];
  const secondary = [];

  for (const n of nodes) {
    const role = (n.role && n.role.value) || "";
    // Skip nodes explicitly hidden from assistive tech
    const isHidden = (n.properties || []).some(p => p.name === "hidden" && p.value && p.value.value === true);
    if (isHidden) continue;
    const line = describe(n);
    if (!line) continue;
    if (INTERACTIVE.has(role)) {
      interactive.push(line);
    } else if (SECONDARY.has(role)) {
      secondary.push(line);
    }
    if (interactive.length >= 200) break;
  }

  // Always show all interactive elements; pad with secondary up to a budget
  const out = [...interactive];
  for (const s of secondary) {
    if (out.length >= 260) break;
    out.push(s);
  }
  if (out.length === 0) {
    return "(no interactive elements found — try `read` or `scroll`)";
  }
  return out.join("\n");
}

// -- Execute ------------------------------------------------------------------

async function executeStep(tabId, step) {
  const action = step.action;
  const result = await executeStepInner(tabId, step);
  if (result && result.success) {
    if (action.type === "hover") {
      STATE.lastHoverTarget = action;
    }
    STATE.lastActionType = action.type;
    const FORCE_FRESH_ACTIONS = new Set(["wait", "wait_for", "refresh", "script", "screenshot", "read"]);
    if (FORCE_FRESH_ACTIONS.has(action.type)) {
      STATE.elementMapDirty = true;
    }
  } else if (result && !result.success) {
    STATE.lastActionType = null;
  }
  return result;
}

async function executeStepInner(tabId, step) {
  const action = step.action;
  if (!tabId || isNaN(Number(tabId))) {
    return { success: false, action_type: action.type, error: "Task was cancelled or debugger detached" };
  }
  tabId = Number(tabId);
  // Defense in depth: re-check URL against client allowlist for any nav.
  if (action.type === "navigate" || action.type === "new_tab") {
    if (isRestrictedUrl(action.url)) {
      return { success: false, action_type: action.type, error: "cannot navigate to internal Chrome URL (chrome://, file://, etc.)" };
    }
  }
  // Guard: reject placeholder refs that came from prompt examples
  if ((action.type === "click" || action.type === "type" || action.type === "hover") && action.ref) {
    if (!/^\d+$/.test(String(action.ref))) {
      return { success: false, action_type: action.type, error: `ref "${action.ref}" is not a valid DOM node ID. Copy the exact number from [ref:NNNN] in the accessibility tree.` };
    }
  }
  // Actions that move the mouse need an input shield so the user's real pointer
  // events don't interleave with the agent's synthetic CDP events.
  const SHIELD_ACTIONS = new Set(["click","double_click","right_click","drag","hold","hover","type","scroll","scroll_wheel"]);
  let needsShield = SHIELD_ACTIONS.has(action.type);
  if (action.type === "batch" && Array.isArray(action.actions)) {
    needsShield = action.actions.some(sub => SHIELD_ACTIONS.has(sub.type));
  }
  if (needsShield && STATE.batchDepth === 0) await showInputShield(tabId);
  try {
    switch (action.type) {
      case "click":
        return await actClick(tabId, action);
      case "type":
        return await actType(tabId, action);
      case "scroll":
        return await actScroll(tabId, action);
      case "scroll_wheel":
        return await actScrollWheel(tabId, action);
      case "navigate":
        return await actNavigate(tabId, action);
      case "new_tab":
        return await actNewTab(tabId, action);
      case "key":
        return await actKey(tabId, action);
      case "paste":
        return await actPaste(tabId, action);
      case "read":
        return await actRead(tabId);
      case "wait":
        return await actWait(tabId, action);
      case "wait_for":
        return await actWaitFor(tabId, action);
      case "hover":
        return await actHover(tabId, action);
      case "hover_then_shoot":
        return await actHoverThenShoot(tabId, action);
      case "go_back":
        return await actGoBack(tabId);
      case "go_forward":
        return await actGoForward(tabId);
      case "refresh":
        return await actRefresh(tabId);
      case "script":
        return await actScript(tabId, action);
      case "hold":
        return await actHold(tabId, action);
      case "double_click":
        return await actDoubleClick(tabId, action);
      case "right_click":
        return await actRightClick(tabId, action);
      case "drag":
        return await actDrag(tabId, action);
      case "file_upload":
        return await actFileUpload(tabId, action);
      case "switch_tab":
        return await actSwitchTab(tabId, action);
      case "select":
        return await actSelect(tabId, action);
      case "fetch":
        return await actFetch(tabId, action);
      case "screenshot":
        return await actScreenshot(tabId, action);
      case "list_tabs":
        return await actListTabs(tabId);
      case "find_text":
        return await actFindText(tabId, action);
      case "close_tab":
        return await actCloseTab(tabId, action);
      case "batch":
        return await actBatch(tabId, action);
      case "zoom_canvas":
        return await actZoomCanvas(tabId, action);
      case "scan_canvas":
        return await actScanCanvas(tabId, action);
      case "listen":
        return await actListen(tabId, action);
      case "bookmark":
        return await actBookmark(action);
      case "history_search":
        return await actHistorySearch(action);
      case "downloads_list":
        return await actDownloadsList(action);
      case "extract":
        return await actExtract(tabId, action);
      case "clipboard_read":
        return await actClipboardRead(tabId);
      case "watch_region":
        return await actWatchRegion(tabId, action);
      case "read_download":
        return await actReadDownload(tabId, action);
      case "download":
        return await actDownloadFile(action);
      case "write_file":
        return await actWriteFile(action);
      case "repeat":
        return await actRepeat(tabId, action);
      case "tool":
        return await actTool(tabId, action);
      default:
        return { success: false, action_type: action.type, error: "unsupported in extension" };
    }
  } catch (e) {
    return { success: false, action_type: action.type, error: String(e.message || e) };
  } finally {
    if (needsShield && STATE.batchDepth === 0) await hideInputShield(tabId);
  }
}

async function actBatch(tabId, action) {
  const actions = action.actions;
  if (!Array.isArray(actions) || actions.length === 0) {
    return { success: false, action_type: "batch", error: "batch action requires a non-empty 'actions' array" };
  }
  const results = [];
  STATE.batchDepth++;
  try {
    for (let i = 0; i < actions.length; i++) {
      if (i > 0) {
        await sleep(100);
      }
      const subAction = actions[i];
      // Always use STATE.attachedTabId rather than the captured tabId — a prior
      // sub-action (or the onCreated listener) may have switched the active tab.
      const currentTabId = STATE.attachedTabId || tabId;
      const result = await executeStep(currentTabId, { action: subAction });
      results.push(result);
      if (!result.success) {
        return {
          success: false,
          action_type: "batch",
          error: `Sub-action at index ${i} (${subAction.type}) failed: ${result.error || "unknown error"}`,
          results: results
        };
      }
      // After a navigation sub-action succeeds, the element map is stale — it
      // reflects the old page, not the new one. Clear it so the next sub-action
      // that calls resolveSomId is forced to do a live DOM re-scan instead of
      // hitting cached (wrong-page) coordinates.
      if (result.success && (subAction.type === "navigate" || subAction.type === "new_tab")) {
        STATE.lastElementMap = {};
      }
    }
    return {
      success: true,
      action_type: "batch",
      results: results
    };
  } finally {
    STATE.batchDepth--;
  }
}


// Compute a cheap hash of the current canvas pixels for cache invalidation.
function _getCanvasHashPage() {
  return (function(){
    var c = document.querySelector('canvas');
    if (!c) return "";
    try {
      var ctx = c.getContext('2d');
      if (!ctx) return "";
      var w = c.width, h = c.height;
      if (!w || !h) return "";
      // Sample a 6x6 grid of pixel data
      var sample = [];
      for (var y = 0; y < 6; y++) {
        for (var x = 0; x < 6; x++) {
          var px = ctx.getImageData(Math.floor(w * x / 6), Math.floor(h * y / 6), 1, 1).data;
          sample.push(px[0], px[1], px[2]);
        }
      }
      return sample.join(',');
    } catch(e) { return ""; }
  })();
}

async function getCanvasHash(tabId) {
  try {
    const { result } = await sendCDP(tabId, "Runtime.evaluate", {
      expression: `(${_getCanvasHashPage.toString()})()`,
      returnByValue: true,
    });
    return (result && result.value) || "";
  } catch (_) { return ""; }
}

// Cursors a page sets on hot regions — a purely behavioral "this spot is
// clickable" signal readable without any knowledge of what the app is.
const INTERACTIVE_CURSORS = new Set([
  "pointer", "grab", "grabbing", "cell", "crosshair", "move", "text",
  "copy", "alias", "zoom-in", "zoom-out", "context-menu",
]);

// Moves the (synthetic, CDP-trusted) pointer over each point and reads the
// computed cursor there. Canvas apps that track hot regions update the canvas
// cursor on mousemove — probing converts that behavior into interactivity data.
// Parks the pointer back at its previous position afterwards.
async function probeCanvasCursors(tabId, points, cap = 25) {
  const out = [];
  for (const p of points.slice(0, cap)) {
    try {
      await sendCDP(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y });
      await sleep(25);   // let the page's mousemove handler set the cursor
      const { result } = await sendCDP(tabId, "Runtime.evaluate", {
        expression: `(function(x,y){var el=document.elementFromPoint(x,y);if(!el)return '';try{return getComputedStyle(el).cursor||'';}catch(_){return '';}})(${Math.round(p.x)},${Math.round(p.y)})`,
        returnByValue: true,
      });
      out.push(String(result?.value || ""));
    } catch (_) { out.push(""); }
  }
  try {
    if (STATE.lastX != null && STATE.lastY != null) {
      await sendCDP(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: STATE.lastX, y: STATE.lastY });
    }
  } catch (_) {}
  return out;
}

// Scan a canvas element. Two modes:
//   AUTO (default, no `elements`): Navy derives anchors FROM THE PIXELS —
//   visual segmentation (grid cells + flat regions) plus a behavioral cursor
//   probe — and returns them as exact som_id anchors. No model estimation.
//   LEGACY (`elements` provided): the model supplies fraction estimates
//   {label, fx, fy}; kept as a correction/override path.
async function actScanCanvas(tabId, action) {
  const canvasSomId = action.som_id;
  const elements    = action.elements;
  const legacyMode  = Array.isArray(elements) && elements.length > 0;

  if (canvasSomId == null) {
    return { success: false, action_type: "scan_canvas",
             error: "scan_canvas requires som_id (the canvas element). Navy auto-detects regions from pixels; optionally pass elements:[{label,fx,fy}] to override." };
  }

  const currentHash = await getCanvasHash(tabId);
  if (legacyMode) {
    // If the canvas has not changed since the last scan, keep the cached label map
    // so the model can reuse previously verified positions. (Auto mode always
    // rescans — it is cheap and pixels can change below hash sensitivity.)
    const cachedHash = STATE.canvasHashMap[canvasSomId];
    const cachedMap = STATE.canvasLabelMap[canvasSomId];
    if (currentHash && cachedHash === currentHash && cachedMap && cachedMap.length > 0) {
      return { success: true, action_type: "scan_canvas", cached: true, count: cachedMap.length };
    }
  }

  // Resolve canvas element — may need a live re-scan if SOM is stale
  let el = STATE.lastElementMap[canvasSomId];
  if (!el) {
    try {
      const fresh = await getInteractiveElements(tabId);
      STATE.lastElementMap = {};
      for (const e of fresh) STATE.lastElementMap[e.id] = e;
      el = STATE.lastElementMap[canvasSomId];
    } catch (_) {}
  }
  if (!el) {
    return { success: false, action_type: "scan_canvas",
             error: `Canvas som_id ${canvasSomId} not found. Re-read the page to get the current canvas som_id.` };
  }
  if (!el.isCanvas) {
    return { success: false, action_type: "scan_canvas",
             error: `som_id ${canvasSomId} is not a canvas element (tag: ${el.tag || 'unknown'}).` };
  }

  const canvasLeft = el.x - el.w / 2;
  const canvasTop  = el.y - el.h / 2;

  if (legacyMode) {
    // Convert fraction estimates → absolute CSS positions
    const labeled = [];
    for (const e of elements) {
      const fx = Number(e.fx);
      const fy = Number(e.fy);
      if (isNaN(fx) || isNaN(fy) || !e.label) continue;
      labeled.push({
        label: String(e.label),
        fx, fy,
        x: Math.round(canvasLeft + fx * el.w),
        y: Math.round(canvasTop  + fy * el.h),
        canvasSomId,
      });
    }

    if (labeled.length === 0) {
      return { success: false, action_type: "scan_canvas",
               error: "No valid elements parsed. Each element needs {label, fx, fy} where fx/fy are 0.0–1.0 fractions." };
    }

    // Persist the label map — used by canvas_label clicks
    STATE.canvasLabelMap[canvasSomId] = labeled;
    STATE.canvasHashMap[canvasSomId] = currentHash;

    // Annotate a fresh screenshot and queue it as a canvas zoom crop for the next step
    try {
      const shot = await safeCaptureScreenshot(tabId, 88);
      const resized = await resizeScreenshotToLogical(shot.dataUrl);
      if (resized) {
        const imgScale = resized.scale;
        const outW = resized.outW;
        const outH = resized.outH;

        // Draw existing DOM SOM marks first, then our green canvas labels on top
        let annotatedDataUrl = `data:image/jpeg;base64,${resized.b64}`;
        const domElements = STATE.lastElementMapArray || [];
        if (domElements.length > 0) {
          const withSom = await addSetOfMarks(annotatedDataUrl, domElements, outW, outH, imgScale);
          if (withSom) annotatedDataUrl = `data:image/jpeg;base64,${withSom}`;
        }
        const withLabels = await addCanvasLabels(annotatedDataUrl, labeled, imgScale, outW, outH);
        if (withLabels) {
          const cx = Math.round(el.x);
          const cy = Math.round(el.y);
          const crop = await cropScreenshotAroundCoords(
            `data:image/jpeg;base64,${withLabels}`,
            cx, cy, shot.w, shot.h,
            Math.min(el.w + 40, shot.w), Math.min(el.h + 40, shot.h)
          );
          if (crop) STATE.pendingCanvasZoom = { b64: crop, cx, cy, note: 'canvas_scan' };
        }
      }
    } catch (_) {}

    return {
      success: true,
      action_type: "scan_canvas",
      elements_mapped: labeled.length,
      canvas_som_id: canvasSomId,
      labels: labeled.map(e => e.label),
      message: `Mapped ${labeled.length} canvas elements: [${labeled.map(e => e.label).join(", ")}]. ` +
               `Check the annotated screenshot in the next step — green labels show estimated positions. ` +
               `If any label is misplaced, call scan_canvas again with corrected fx/fy values. ` +
               `Once verified, click by label: {"type":"click","canvas_som_id":${canvasSomId},"canvas_label":"<label>"}`
    };
  }

  // ── AUTO mode: Navy derives anchors from the pixels ──────────────────────────
  // 1. Fresh capture of the current frame.
  let shot;
  try {
    shot = await withTimeout(safeCaptureScreenshot(tabId, 88), 5000, "scanCanvasCapture");
  } catch (e) {
    return { success: false, action_type: "scan_canvas", error: `screenshot failed: ${e.message || e}` };
  }

  // 2. Visual segmentation of the canvas region (grid cells + flat-region blobs).
  const anchors = await segmentCanvasRegions(shot.dataUrl, shot.w,
    { left: canvasLeft, top: canvasTop, w: el.w, h: el.h });
  if (!anchors.length) {
    return {
      success: false, action_type: "scan_canvas",
      error: "No visually distinct regions detected in this canvas (uniform or very low-contrast surface). " +
             "Use zoom_canvas to inspect it visually, then click by raw coordinates on what you can see."
    };
  }

  // Make labels unique so canvas_label clicks are unambiguous.
  const labelCounts = new Map();
  for (const a of anchors) {
    const n = (labelCounts.get(a.label) || 0) + 1;
    labelCounts.set(a.label, n);
    if (n > 1) a.label = `${a.label} #${n}`;
  }

  // 3. Behavioral interactivity probe: hover each candidate and read the computed
  // cursor. Grid cells almost always behave uniformly — sample 5 spread across
  // the grid and generalize instead of probing all of them.
  const blobAnchors = anchors.filter(a => a.kind === "region").slice(0, 20);
  const cellAnchors = anchors.filter(a => a.kind === "cell");
  const cellSamples = cellAnchors.length > 0
    ? [...new Set([cellAnchors[0], cellAnchors[Math.floor(cellAnchors.length / 4)],
                   cellAnchors[Math.floor(cellAnchors.length / 2)],
                   cellAnchors[Math.floor(3 * cellAnchors.length / 4)],
                   cellAnchors[cellAnchors.length - 1]])]
    : [];
  const probeTargets = [...blobAnchors, ...cellSamples];
  const cursors = await probeCanvasCursors(tabId, probeTargets);
  for (let i = 0; i < probeTargets.length && i < cursors.length; i++) {
    probeTargets[i].cursor = cursors[i];
    probeTargets[i].interactive = INTERACTIVE_CURSORS.has(cursors[i]);
  }
  if (cellSamples.length > 0) {
    const hotSample = cellSamples.find(c => c.interactive);
    if (cellSamples.filter(c => c.interactive).length >= Math.ceil(cellSamples.length * 0.6)) {
      for (const c of cellAnchors) {
        if (c.interactive === undefined) { c.interactive = true; c.cursor = hotSample ? hotSample.cursor : "pointer"; }
      }
    }
  }

  // 4. Persist for canvas_label clicks + refresh the hash cache.
  STATE.canvasLabelMap[canvasSomId] = anchors.map(a => ({ label: a.label, x: a.x, y: a.y, canvasSomId }));
  STATE.canvasHashMap[canvasSomId] = currentHash;

  // 5. Inject as som entries so {"type":"click","som_id":N} works immediately.
  const baseMap = (STATE.lastElementMapArray || []).filter(e => !e.isVisual);
  let vid = Math.max(5000, baseMap.reduce((m, e) => Math.max(m, e.id || 0), 0) + 1);
  const injected = [];
  for (const a of anchors.slice(0, 110)) {
    injected.push({
      id: vid++,
      tag: "visual",
      role: a.kind === "cell" ? "grid-cell" : "visual-region",
      label: a.label + (a.interactive ? ` [cursor:${a.cursor}]` : ""),
      x: a.x, y: a.y, w: a.w, h: a.h,
      isVisual: true,
    });
  }
  STATE.lastElementMapArray = [...baseMap, ...injected];
  STATE.lastElementMap = {};
  for (const e of STATE.lastElementMapArray) STATE.lastElementMap[e.id] = e;

  // 6. Annotated crop of the canvas queued for the next step's context.
  try {
    const resized = await resizeScreenshotToLogical(shot.dataUrl);
    if (resized) {
      const somB64 = await addSetOfMarks(
        `data:image/jpeg;base64,${resized.b64}`, STATE.lastElementMapArray,
        resized.outW, resized.outH, resized.scale);
      if (somB64) {
        const crop = await cropScreenshotAroundCoords(
          `data:image/jpeg;base64,${somB64}`,
          Math.round(el.x), Math.round(el.y), shot.w, shot.h,
          Math.min(el.w + 40, shot.w), Math.min(el.h + 40, shot.h));
        if (crop) STATE.pendingCanvasZoom = { b64: crop, cx: Math.round(el.x), cy: Math.round(el.y), note: "canvas_scan" };
      }
    }
  } catch (_) {}

  // 7. Compact summary — interactive anchors first, then content cells, then rest.
  const rank = (e) => e.label.includes("[cursor:") ? 0 : e.label.includes("(content)") ? 1 : 2;
  const summary = injected
    .slice()
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, 60)
    .map(e => `som_id=${e.id} ${e.label} center=(${e.x},${e.y}) size=${e.w}×${e.h}`)
    .join("\n");
  const gridInfo = cellAnchors.length > 0 ? ` Detected a ${cellAnchors.length}-cell grid.` : "";

  return {
    success: true,
    action_type: "scan_canvas",
    mode: "auto",
    anchors: injected.length,
    canvas_som_id: canvasSomId,
    message: `Detected ${injected.length} visual anchors in the canvas (amber marks on the annotated crop shown next step).${gridInfo}\n` +
             `Click them EXACTLY like DOM elements: {"type":"click","som_id":<id>} — coordinates are exact, never estimate x,y for these.\n` +
             summary
  };
}

async function actNewTab(tabId, a) {
  const tabObj = await chrome.tabs.get(tabId);

  // Reuse an existing tab when one already shows the requested URL — the model
  // often re-requests a page it already has open; duplicating bloats the tab
  // group and discards the existing tab's state (scroll, form contents, login).
  try {
    const normalizeUrl = (u) => {
      try { const x = new URL(u); return (x.origin + x.pathname).replace(/\/+$/, "").toLowerCase() + x.search; }
      catch (_) { return (u || "").replace(/\/+$/, "").toLowerCase(); }
    };
    const want = normalizeUrl(a.url);
    if (want) {
      const pool = STATE.tabGroupId
        ? await chrome.tabs.query({ groupId: STATE.tabGroupId })
        : await chrome.tabs.query({ windowId: tabObj.windowId });
      const existing = pool.find(t =>
        normalizeUrl(t.url) === want || (t.pendingUrl && normalizeUrl(t.pendingUrl) === want));
      if (existing) {
        await chrome.tabs.update(existing.id, { active: true });
        await detachDebugger().catch(() => {});
        await attachDebugger(existing.id);
        STATE.attachedTabId = existing.id;
        try {
          await sendCDP(existing.id, "Accessibility.enable", {});
        } catch (_) {
          try { await detachDebugger(); } catch (_2) {}
          await attachDebugger(existing.id);
          STATE.attachedTabId = existing.id;
        }
        await startTabBlink(existing.id);
        const fresh = await chrome.tabs.get(existing.id);
        return {
          success: true, action_type: "new_tab", url: fresh.url, title: fresh.title,
          note: "a tab with this URL was already open — switched to it instead of opening a duplicate",
        };
      }
    }
  } catch (_) { /* dedup is best-effort — fall through to creating a fresh tab */ }

  // Increment BEFORE create so onCreated sees the counter even if it fires
  // before the awaited Promise resolves (the event can beat the microtask queue).
  // The finally block ensures the counter is always decremented — even on failure —
  // so a rejected create() never permanently poisons the counter for future tabs.
  STATE.programmaticTabCreating++;
  let newTab;
  try {
    newTab = await chrome.tabs.create({ windowId: tabObj.windowId, url: a.url, active: true });
  } finally {
    STATE.programmaticTabCreating = Math.max(0, STATE.programmaticTabCreating - 1);
  }
  STATE.programmaticTabs.add(newTab.id);
  if (STATE.tabGroupId) {
    await chrome.tabs.group({ tabIds: [newTab.id], groupId: STATE.tabGroupId }).catch(() => {});
  }
  await waitForLoad(newTab.id);
  // Detach from the old tab, then attach to the new one.
  await detachDebugger().catch(() => {});
  await attachDebugger(newTab.id);
  STATE.attachedTabId = newTab.id;
  // Cross-process navigations (new origin) can silently drop the debugger
  // right after attach. Probe with Accessibility.enable — if it throws,
  // re-attach from scratch (same pattern as actNavigate).
  try {
    await sendCDP(newTab.id, "Accessibility.enable", {});
  } catch (_) {
    try { await detachDebugger(); } catch (_2) {}
    await attachDebugger(newTab.id);
    STATE.attachedTabId = newTab.id;
  }
  await waitForNetworkIdle(newTab.id, 4000, 400);
  await waitForDOMStability(newTab.id, 2000, 300);
  await startTabBlink(newTab.id);
  const tab = await chrome.tabs.get(newTab.id);
  return { success: true, action_type: "new_tab", url: tab.url, title: tab.title };
}

function guessMimeType(fileName) {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  const map = {
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
    txt: 'text/plain', csv: 'text/csv', html: 'text/html', htm: 'text/html',
    json: 'application/json', xml: 'application/xml',
    zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    mp4: 'video/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
    webm: 'video/webm', avi: 'video/avi', mov: 'video/quicktime',
  };
  return map[ext] || 'application/octet-stream';
}

async function actFileUpload(tabId, a) {
  const tabBefore = await chrome.tabs.get(tabId);
  const urlBefore = tabBefore.url;
  const fpBefore = await domFingerprint(tabId);
  let dataUrlBefore = null;
  try {
    dataUrlBefore = await captureTabForDiff(tabId, tabBefore.windowId);
  } catch (_) {}

  let backendNodeId;
  let resolvedPt = null;

  if (a.som_id != null) {
    const pt = await resolveSomId(tabId, a.som_id);
    if (!pt) return { success: false, action_type: "file_upload", error: `som_id ${a.som_id} not found` };
    resolvedPt = pt;
    try {
      const res = await sendCDP(tabId, "DOM.getNodeForLocation", { x: Math.round(pt.x), y: Math.round(pt.y) });
      backendNodeId = res.backendNodeId;
    } catch (e) {
      return { success: false, action_type: "file_upload", error: `Failed to get node: ${e.message}` };
    }
  } else if (a.ref) {
    backendNodeId = Number(a.ref);
  } else {
    return { success: false, action_type: "file_upload", error: "file_upload requires som_id or ref" };
  }

  // Validate path before handing to CDP — block reads of system/sensitive files
  const filePath = (a.path || "").trim();
  if (!filePath) {
    return { success: false, action_type: "file_upload", error: "file_upload requires a non-empty path" };
  }
  // Normalize path separators before matching to catch forward-slash Windows paths
  const normalizedPath = filePath.replace(/\//g, "\\");
  const BLOCKED_PATH = [
    // Path traversal — block any path with ../  or ..\
    /\.\.[/\\]/,
    // Unix system dirs
    /^\/etc\//i, /^\/proc\//i, /^\/sys\//i, /^\/root\//i, /^\/private\//i,
    /^\/dev\//i, /^\/boot\//i,
    // Relative paths are blocked — only absolute paths allowed
    /^[^/\\]/,
    // Unix dotfiles
    /[/\\]\.ssh[/\\]/i, /[/\\]\.gnupg[/\\]/i, /[/\\]\.aws[/\\]/i,
    // Windows system dirs (match both / and \ variants via normalizedPath below)
    /^[A-Za-z]:[/\\]Windows[/\\]/i,
    /^[A-Za-z]:[/\\]Users[/\\][^/\\]+[/\\]AppData[/\\]/i,
    // UNC paths
    /^[/\\]{2}/,
    // Sensitive files
    /\.env(\.|$)/i, /credentials/i, /id_rsa/i, /id_ed25519/i, /id_ecdsa/i,
    // Mac keychain
    /[/\\]Library[/\\]Keychains[/\\]/i,
  ];
  if (BLOCKED_PATH.some(p => p.test(filePath) || p.test(normalizedPath))) {
    return { success: false, action_type: "file_upload", error: "file_upload path blocked by security policy" };
  }

  // Strategy 1: Native CDP path — works for <input type="file"> elements
  try {
    await sendCDP(tabId, "DOM.setFileInputFiles", { files: [filePath], backendNodeId });
    await waitForDOMStability(tabId, 2000, 300);
    return verifyPageChange(tabId, urlBefore, fpBefore, dataUrlBefore, "file_upload", { success: true, action_type: "file_upload", method: "file_input" });
  } catch (e) {
    // Only fall through for "not a file input" type errors; hard-fail for other errors
    const msg = (e.message || '').toLowerCase();
    if (!msg.includes('file input') && !msg.includes('not of type') && !msg.includes('node is not')) {
      return { success: false, action_type: "file_upload", error: `CDP setFileInputFiles failed: ${e.message}` };
    }
  }

  // Strategy 2: DataTransfer drop-event injection — for div/custom drop zones.
  // If a.url is provided, fetch real file content from the service worker context
  // (which has full cross-origin network access) and inject real bytes into the File blob.
  const pt = resolvedPt || { x: 640, y: 400 };
  const fileName = (a.url
    ? decodeURIComponent(new URL(a.url).pathname.split('/').pop()) || 'file'
    : (a.path || '').replace(/\\/g, '/').split('/').pop()) || 'file';
  let mimeType = guessMimeType(fileName);
  let fileBase64 = null;

  if (a.url) {
    try {
      const resp = await fetch(a.url);
      if (resp.ok) {
        mimeType = resp.headers.get('content-type')?.split(';')[0] || mimeType;
        const buf = await resp.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = "";
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        fileBase64 = btoa(bin);
      }
    } catch (_) {}
  }

  // Build injection expression — use real bytes when available, empty blob as fallback
  const bytesExpr = fileBase64
    ? `(function(b64){var s=atob(b64),a=new Uint8Array(s.length);for(var i=0;i<s.length;i++)a[i]=s.charCodeAt(i);return a;})(${JSON.stringify(fileBase64)})`
    : `new Uint8Array(0)`;

  const injectResult = await sendCDP(tabId, "Runtime.evaluate", {
    expression: `(function(px, py, fName, fMime, fileBytes) {
      try {
        var el = document.elementFromPoint(px, py);
        if (!el) return { ok: false, err: 'no element at coords (' + px + ',' + py + ')' };
        var dt = new DataTransfer();
        dt.items.add(new File([fileBytes], fName, { type: fMime }));
        ['dragenter', 'dragover', 'drop'].forEach(function(evtName) {
          el.dispatchEvent(new DragEvent(evtName, { bubbles: true, cancelable: true, dataTransfer: dt }));
        });
        return { ok: true, tag: el.tagName };
      } catch (err) { return { ok: false, err: err.message }; }
    })(${Math.round(pt.x)}, ${Math.round(pt.y)}, ${JSON.stringify(fileName)}, ${JSON.stringify(mimeType)}, ${bytesExpr})`,
    returnByValue: true,
  });

  const val = injectResult?.result?.value;
  if (val?.ok) {
    await waitForDOMStability(tabId, 2000, 300);
    return verifyPageChange(tabId, urlBefore, fpBefore, dataUrlBefore, "file_upload", { success: true, action_type: "file_upload", method: "datatransfer_inject" });
  }

  return {
    success: false, action_type: "file_upload",
    error: `Drop zone injection failed: ${val?.err || 'unknown'}. ` +
           `If this element opens a native OS file dialog, click it first and then handle the dialog separately.`,
  };
}

async function actSwitchTab(tabId, a) {
  // Use the actual window of the currently attached tab — WINDOW_ID_CURRENT is
  // unreliable in service worker context.
  const currentTab = await chrome.tabs.get(tabId).catch(() => null);
  const windowId = currentTab ? currentTab.windowId : chrome.windows.WINDOW_ID_CURRENT;
  const queryInfo = STATE.tabGroupId 
    ? { groupId: STATE.tabGroupId } 
    : { windowId };
  const tabs = await chrome.tabs.query(queryInfo);

  let targetTab = null;

  // Match by partial URL, partial title, or index — whichever the LLM provided.
  if (a.tab_url) {
    const q = a.tab_url.toLowerCase();
    targetTab = tabs.find(t => t.url && t.url.toLowerCase().includes(q));
  }
  if (!targetTab && a.tab_title) {
    const q = a.tab_title.toLowerCase();
    targetTab = tabs.find(t => t.title && t.title.toLowerCase().includes(q));
  }
  if (!targetTab && a.tab_index != null) {
    if (a.tab_index < 0 || a.tab_index >= tabs.length) {
      return { success: false, action_type: "switch_tab", error: `Tab index ${a.tab_index} out of range (0-${tabs.length - 1})` };
    }
    targetTab = tabs[a.tab_index];
  }
  if (!targetTab) {
    const available = tabs.map((t, i) => `${i}: ${t.title || t.url}`).join(", ");
    return { success: false, action_type: "switch_tab", error: `No matching tab found. Available: ${available}` };
  }

  await chrome.tabs.update(targetTab.id, { active: true });
  await detachDebugger().catch(() => {});
  await attachDebugger(targetTab.id);
  STATE.attachedTabId = targetTab.id;
  try {
    await sendCDP(targetTab.id, "Accessibility.enable", {});
  } catch (_) {
    try { await detachDebugger(); } catch (_2) {}
    await attachDebugger(targetTab.id);
    STATE.attachedTabId = targetTab.id;
  }
  await waitForDOMStability(targetTab.id, 2000, 300);
  return { success: true, action_type: "switch_tab", url: targetTab.url, title: targetTab.title };
}

// Select a <select> dropdown option by visible text or value attribute.
// Works on any <select> element — resolves via som_id, ref, or x,y.
async function actSelect(tabId, a) {
  const tabBefore = await chrome.tabs.get(tabId);
  const urlBefore = tabBefore.url;
  const fpBefore = await domFingerprint(tabId);
  let dataUrlBefore = null;
  try {
    dataUrlBefore = await captureTabForDiff(tabId, tabBefore.windowId);
  } catch (_) {}
  let objectId, sessionId = null;

  if (a.som_id != null) {
    const pt = await resolveSomId(tabId, a.som_id);
    if (!pt) return { success: false, action_type: "select", error: `som_id ${a.som_id} not found` };
    try {
      const res = await sendCDP(tabId, "DOM.getNodeForLocation", { x: Math.round(pt.x), y: Math.round(pt.y) });
      const obj = await sendCDP(tabId, "DOM.resolveNode", { backendNodeId: res.backendNodeId });
      objectId = obj.object.objectId;
    } catch (e) {
      return { success: false, action_type: "select", error: `Failed to resolve som_id ${a.som_id}: ${e.message}` };
    }
  } else if (a.ref) {
    try {
      const res = await resolveNodeAnywhere(tabId, Number(a.ref));
      objectId = res.object.objectId;
      sessionId = res.sessionId;
    } catch (e) {
      return { success: false, action_type: "select", error: `Stale ref ${a.ref}: ${e.message}` };
    }
  } else {
    return { success: false, action_type: "select", error: "select requires som_id or ref" };
  }

  const selectValue = a.value != null ? String(a.value) : null;
  const selectText  = a.text  != null ? String(a.text)  : null;

  const result = await sendRoutedCDP(tabId, sessionId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function(val, txt) {
      var el = this;
      if (el.tagName.toLowerCase() !== 'select') {
        // Try to find the nearest select element
        var sel = el.closest('select') || el.querySelector('select');
        if (!sel) return { ok: false, err: 'not a select element: ' + el.tagName };
        el = sel;
      }
      var opts = Array.from(el.options);
      var opt = null;
      if (val !== null) opt = opts.find(function(o){ return o.value === val; });
      if (!opt && txt !== null) opt = opts.find(function(o){ return o.text.trim() === txt; });
      if (!opt && txt !== null) {
        // Only accept partial match when it is unambiguous (exactly one hit)
        var partials = opts.filter(function(o){ return o.text.trim().toLowerCase().includes(txt.toLowerCase()); });
        if (partials.length === 1) opt = partials[0];
        else if (partials.length > 1) return { ok: false, err: 'ambiguous: "' + txt + '" matches ' + partials.length + ' options — use exact text' };
      }
      if (!opt) return { ok: false, err: 'option not found: value=' + val + ' text=' + txt };
      el.value = opt.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      return { ok: true, selected: opt.text.trim() };
    }`,
    arguments: [
      { value: selectValue },
      { value: selectText  },
    ],
    returnByValue: true,
  });

  const val = result?.result?.value;
  if (!val?.ok) {
    return { success: false, action_type: "select", error: val?.err || "unknown error in select" };
  }

  await waitForDOMStability(tabId, 1500, 200);

  // Re-read the element after JS has had a chance to run to confirm the value wasn't reset.
  let confirmedValue = null;
  try {
    if (a.som_id != null) {
      const pt = await resolveSomId(tabId, a.som_id);
      if (pt) {
        const [recheck] = await chrome.scripting.executeScript({
          target: { tabId },
          func: function(x, y) {
            var el = document.elementFromPoint(x, y);
            if (!el) return null;
            var sel = el.tagName === 'SELECT' ? el : (el.closest('select') || el.querySelector('select'));
            if (!sel) return null;
            return Array.from(sel.selectedOptions).map(function(o) { return o.text.trim(); }).join(', ') || null;
          },
          args: [Math.round(pt.x), Math.round(pt.y)],
        });
        confirmedValue = recheck?.result ?? null;
      }
    }
  } catch (_) {}

  const base = { success: true, action_type: "select", selected: val.selected, confirmed_value: confirmedValue };
  return verifyPageChange(tabId, urlBefore, fpBefore, dataUrlBefore, "select", base);
}

// Make an HTTP request from the page context (inherits cookies/session).
// Useful for calling page APIs, submitting JSON, reading REST endpoints, etc.
async function actFetch(tabId, a) {
  const method  = (a.method || "GET").toUpperCase();
  const url     = a.url;
  const headers = a.headers || {};
  const body    = a.body    != null ? (typeof a.body === "string" ? a.body : JSON.stringify(a.body)) : null;

  if (!url) return { success: false, action_type: "fetch", error: "fetch requires a url" };

  // Cross-origin fetch safety is now enforced by evaluateAction in security.js before this
  // function is reached. No LLM-controlled field can bypass the policy gate.

  const { result } = await sendCDP(tabId, "Runtime.evaluate", {
    expression: `(async function() {
      try {
        var controller = new AbortController();
        var timeoutId = setTimeout(() => controller.abort(), 15000);
        var opts = { method: ${JSON.stringify(method)}, headers: ${JSON.stringify(headers)}, credentials: "omit", signal: controller.signal };
        ${body ? `opts.body = ${JSON.stringify(body)};` : ""}
        var resp = await fetch(${JSON.stringify(url)}, opts);
        var text = await resp.text();
        clearTimeout(timeoutId);
        var json = null;
        try { json = JSON.parse(text); } catch(_) {}
        return { ok: resp.ok, status: resp.status, body: text.slice(0, 8000), json: json };
      } catch(err) { return { ok: false, status: 0, body: "", error: err.message || String(err) }; }
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });

  const val = result?.value;
  if (!val) return { success: false, action_type: "fetch", error: "fetch evaluation failed" };
  if (val.error) return { success: false, action_type: "fetch", error: val.error };

  return {
    success: true, action_type: "fetch",
    status: val.status, ok: val.ok,
    body: val.body,
    json: val.json,
  };
}

// Find an element on the page by its visible text content.
// Returns the som_id of the matching element so subsequent actions can use it.
async function actFindText(tabId, a) {
  if (!a.text) return { success: false, action_type: "find_text", error: "find_text requires a text field" };
  const exact = a.exact !== false;

  const { result } = await sendCDP(tabId, "Runtime.evaluate", {
    expression: `(function(needle, exact) {
      var all = document.querySelectorAll('a,button,[role="button"],[role="link"],label,li,[role="option"],h1,h2,h3,h4,td,th,span,p,div');
      needle = exact ? needle : needle.toLowerCase();
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.offsetParent === null) continue;
        var t = (el.innerText || el.textContent || '').trim();
        if (!t) continue;
        var match = exact ? (t === needle || t.includes(needle)) : t.toLowerCase().includes(needle);
        if (match) {
          var r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            return { found: true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), text: t.slice(0,80), tag: el.tagName.toLowerCase() };
          }
        }
      }
      return { found: false };
    })(${JSON.stringify(a.text)}, ${JSON.stringify(exact)})`,
    returnByValue: true,
  });

  const val = result?.value;
  if (!val?.found) {
    return { success: false, action_type: "find_text", error: `Text "${a.text}" not found on page` };
  }

  // Find the matching som_id from the element map if available
  let somId = null;
  if (STATE.lastElementMap) {
    const THRESH = 20;
    for (const [id, el] of STATE.lastElementMap.entries()) {
      if (Math.abs(el.x - val.x) < THRESH && Math.abs(el.y - val.y) < THRESH) {
        somId = id; break;
      }
    }
  }

  return { success: true, action_type: "find_text", x: val.x, y: val.y, text: val.text, tag: val.tag, som_id: somId };
}

// Close the current tab (or a specific tab by index).
async function actCloseTab(tabId, a) {
  const currentTab = await chrome.tabs.get(tabId).catch(() => null);
  const windowId = currentTab ? currentTab.windowId : chrome.windows.WINDOW_ID_CURRENT;
  const queryInfo = STATE.tabGroupId 
    ? { groupId: STATE.tabGroupId } 
    : { windowId };
  const tabs = await chrome.tabs.query(queryInfo);
  let targetId = tabId;

  if (a && a.tab_index != null) {
    if (a.tab_index < 0 || a.tab_index >= tabs.length) {
      return { success: false, action_type: "close_tab", error: `Tab index ${a.tab_index} out of range` };
    }
    targetId = tabs[a.tab_index].id;
  }

  // If closing the active tab, detach the debugger first
  if (targetId === tabId) {
    await detachDebugger().catch(() => {});
  }

  STATE.programmaticTabRemove = true;
  try {
    await chrome.tabs.remove(targetId);
  } finally {
    STATE.programmaticTabRemove = false;
  }

  // If we closed our own tab and other tabs exist, re-attach to the new active tab
  if (targetId === tabId && tabs.length > 1) {
    const activeQuery = STATE.tabGroupId
      ? { active: true, groupId: STATE.tabGroupId }
      : { active: true, currentWindow: true };
    const [newActive] = await chrome.tabs.query(activeQuery);
    if (newActive) {
      await attachDebugger(newActive.id);
      STATE.attachedTabId = newActive.id;
    }
  }

  return { success: true, action_type: "close_tab", closed_tab_id: targetId };
}

// -- Pre-click crosshair (position verification) ------------------------------
// A persistent red crosshair injected at (x, y) so the LLM can verify the
// click target before the click fires.  No animation — stays until removed.

async function showCrosshair(tabId, x, y) {
  if (!tabId || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const expr = `(function(x,y){
    var e=document.getElementById('__lba_xhair');if(e)e.remove();
    var d=document.createElement('div');d.id='__lba_xhair';
    d.style.cssText='position:fixed;left:'+(x-20)+'px;top:'+(y-20)+'px;width:40px;height:40px;pointer-events:none;z-index:2147483647;';
    var ns='http://www.w3.org/2000/svg';
    var svg=document.createElementNS(ns,'svg');
    svg.setAttribute('viewBox','-20 -20 40 40');
    svg.setAttribute('width','40');svg.setAttribute('height','40');
    svg.style.cssText='overflow:visible;filter:drop-shadow(0 0 3px #fff) drop-shadow(0 0 1px #fff);';
    var mkc=function(r,fill,sw){var c=document.createElementNS(ns,'circle');c.setAttribute('cx','0');c.setAttribute('cy','0');c.setAttribute('r',r);c.setAttribute('fill',fill);if(sw){c.setAttribute('stroke','#06b6d4');c.setAttribute('stroke-width',sw);}return c;};
    var mkl=function(x1,y1,x2,y2){var l=document.createElementNS(ns,'line');l.setAttribute('x1',x1);l.setAttribute('y1',y1);l.setAttribute('x2',x2);l.setAttribute('y2',y2);l.setAttribute('stroke','#06b6d4');l.setAttribute('stroke-width','2');return l;};
    svg.appendChild(mkc(12,'none','2.5'));
    svg.appendChild(mkc(2.5,'#06b6d4'));
    svg.appendChild(mkl(-18,0,-14,0));svg.appendChild(mkl(14,0,18,0));
    svg.appendChild(mkl(0,-18,0,-14));svg.appendChild(mkl(0,14,0,18));
    d.appendChild(svg);
    document.documentElement.appendChild(d);
  })(${x},${y})`;
  try { await sendCDP(tabId, "Runtime.evaluate", { expression: expr }); } catch (_) {}
}

async function removeCrosshair(tabId) {
  const expr = `(function(){var e=document.getElementById('__lba_xhair');if(e)e.remove();})()`;
  try { await sendCDP(tabId, "Runtime.evaluate", { expression: expr }); } catch (_) {}
}

// -- Tab title blinking -------------------------------------------------------

async function startTabBlink(tabId) {
  const expr = `(function(){
    if(window.__lba_blink)clearInterval(window.__lba_blink);
    window.__lba_orig=document.title;
    var s=false;
    window.__lba_blink=setInterval(function(){
      s=!s;
      document.title=s?'⟳ Agent':window.__lba_orig;
    },800);
    
    var border = document.getElementById('__lba_border');
    if (border) border.remove();
    var d = document.createElement('div');
    d.id = '__lba_border';
    d.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;border:4px solid #06b6d4;box-shadow:inset 0 0 15px rgba(6,182,212,0.5);pointer-events:none;z-index:2147483646;box-sizing:border-box;animation:lba-pulse-border 2s infinite ease-in-out;';
    var sty = document.getElementById('__lba_border_style');
    if (!sty) {
      sty = document.createElement('style');
      sty.id = '__lba_border_style';
      document.head.appendChild(sty);
    }
    sty.textContent = '@keyframes lba-pulse-border{0%{opacity:0.3;box-shadow:inset 0 0 10px rgba(6,182,212,0.3);}50%{opacity:0.9;box-shadow:inset 0 0 20px rgba(6,182,212,0.7), 0 0 4px rgba(6,182,212,0.3);}100%{opacity:0.3;box-shadow:inset 0 0 10px rgba(6,182,212,0.3);}}';
    document.documentElement.appendChild(d);
  })()`;
  try { await sendCDP(tabId, "Runtime.evaluate", { expression: expr }); } catch (_) {}
}

async function stopTabBlink(tabId) {
  if (tabId == null) return;
  const expr = `(function(){
    if(window.__lba_blink){clearInterval(window.__lba_blink);window.__lba_blink=null;}
    if(window.__lba_orig!==undefined){document.title=window.__lba_orig;delete window.__lba_orig;}
    var border = document.getElementById('__lba_border');
    if (border) border.remove();
  })()`;
  try { await sendCDP(tabId, "Runtime.evaluate", { expression: expr }); } catch (_) {}
}

// Inject / update the agent cursor at (x, y).
// First appearance: instant (no animation). Subsequent calls: smooth 180ms ease-out.
// Options:
//   label — short text in the badge next to the cursor
//   color — cyan #06b6d4 for actions, orange #f97316 for hover
async function showAgentCursor(tabId, x, y, { label = null, color = "#06b6d4" } = {}) {
  if (!tabId || !Number.isFinite(x) || !Number.isFinite(y)) return;
  // The model only sees the DOWNSCALED screenshot. A fixed-size cursor shrinks to
  // near-invisible when the page is downscaled for the LLM, defeating its purpose
  // as a click-verification marker. Scale it inversely to the downscale factor so
  // its APPARENT size in the model's view stays constant. Anchored at the tip
  // (transform-origin 0 0) so scaling never moves the hotspot. Capped so a tiny
  // scale can't produce an absurd native cursor.
  const scaleMul = Math.max(1, Math.min(3, 1 / (STATE.screenshotScale || 1)));
  const expr = `(function(x,y,label,color,s){
    var d = document.getElementById('__lba_cur');
    if (!d) {
      d = document.createElement('div');
      d.id = '__lba_cur';
      d.style.cssText = 'position:fixed;left:'+x+'px;top:'+y+'px;pointer-events:none;z-index:2147483647;';
      var ns = 'http://www.w3.org/2000/svg';
      var svg = document.createElementNS(ns,'svg');
      svg.setAttribute('width','20'); svg.setAttribute('height','26');
      svg.style.cssText = 'position:absolute;left:0;top:0;overflow:visible;transform-origin:0 0;transform:scale('+s+');filter:drop-shadow(0 0 1.5px #000) drop-shadow(0 0 1px #000);';
      var path = document.createElementNS(ns,'path');
      path.setAttribute('d','M0,0 L0,20 L6,14 L9,22 L11.5,21 L8.5,13 L16,13 Z');
      path.setAttribute('fill',color); path.setAttribute('stroke','#0a111a');
      path.setAttribute('stroke-width','0.8'); path.setAttribute('stroke-linejoin','round');
      svg.appendChild(path);
      var tip = document.createElementNS(ns,'circle');
      tip.setAttribute('cx','1.5'); tip.setAttribute('cy','1.5'); tip.setAttribute('r','2');
      tip.setAttribute('fill','#fff'); tip.setAttribute('opacity','0.9');
      svg.appendChild(tip);
      d.appendChild(svg);
      document.documentElement.appendChild(d);
      d.offsetHeight; // force reflow before enabling transitions
      d.style.transition = 'left 0.18s ease-out, top 0.18s ease-out';
    } else {
      // Smoothly move existing cursor to new position and refresh size/color
      d.style.left = x + 'px'; d.style.top = y + 'px';
      var path = d.querySelector('path'); if (path) path.setAttribute('fill', color);
      var svg = d.querySelector('svg'); if (svg) svg.style.transform = 'scale('+s+')';
    }
  })(${Math.round(x)},${Math.round(y)},${JSON.stringify(label)},${JSON.stringify(color)},${scaleMul})`;
  try { await sendCDP(tabId, "Runtime.evaluate", { expression: expr }); } catch (_) {}
}



// Move the cursor to the planned target and capture a high-res annotated crop
// so the LLM can verify the cursor is on the correct element before clicking.
async function actHoverThenShoot(tabId, a) {
  const { w: vpW, h: vpH } = await getViewportSize(tabId);
  let x = a.x, y = a.y;
  if (a.som_id != null) {
    const pt = await resolveSomId(tabId, a.som_id);
    if (pt) { x = pt.x; y = pt.y; }
  } else if (a.ref) {
    try {
      const { model } = await getBoxModelAnywhere(tabId, Number(a.ref));
      const [x1, y1, x2, , , y3] = model.content;
      x = (x1 + x2) / 2; y = (y1 + y3) / 2;
    } catch (_) {}
  } else if (a.relative_to_som_id != null) {
    const pt = await resolveContainerOffset(tabId, a.relative_to_som_id, a.x, a.y, "hover");
    if (!pt.error) { x = pt.x; y = pt.y; }
  }
  if (x == null || y == null) {
    return { success: false, action_type: "hover_then_shoot", error: "No coordinates or target provided" };
  }

  await glidePointer(tabId, x, y, { label: (a.reasoning || "").slice(0, 30), color: "#f97316" });
  await sleep(350); // let hover effects / tooltips render

  const cropW = 320, cropH = 320;
  let shotB64 = null;
  try {
    const dataUrl = await safeCaptureVisibleTab((await chrome.tabs.get(tabId)).windowId, { format: "jpeg", quality: 85 });
    shotB64 = await cropScreenshotAroundCoords(dataUrl, x, y, vpW, vpH, cropW, cropH);
  } catch (_) {}

  if (shotB64) {
    try {
      const annotated = await annotateScreenshot(shotB64, "image/jpeg", {
        crosshairX: x - Math.max(0, Math.min(vpW - cropW, x - cropW/2)),
        crosshairY: y - Math.max(0, Math.min(vpH - cropH, y - cropH/2)),
        viewportW: cropW,
        viewportH: cropH,
        label: "cursor position",
      });
      if (annotated) shotB64 = annotated;
    } catch (_) {}
  }

  return {
    success: true, action_type: "hover_then_shoot",
    x, y,
    verify_screenshot: shotB64,
    verify_offset_x: Math.max(0, Math.min(vpW - cropW, x - cropW/2)),
    verify_offset_y: Math.max(0, Math.min(vpH - cropH, y - cropH/2)),
  };
}

async function glidePointer(tabId, targetX, targetY, options = {}) {
  const startX = STATE.lastX !== null && STATE.lastX !== undefined ? STATE.lastX : 400;
  const startY = STATE.lastY !== null && STATE.lastY !== undefined ? STATE.lastY : 300;

  const distance = Math.hypot(targetX - startX, targetY - startY);
  if (distance < 5) {
    await sendCDP(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(targetX), y: Math.round(targetY), button: "none", buttons: 0 }).catch(() => {});
    await showAgentCursor(tabId, targetX, targetY, options).catch(() => {});
    STATE.lastX = targetX;
    STATE.lastY = targetY;
    return;
  }

  const steps = Math.max(4, Math.min(10, Math.round(distance / 40)));
  const stepTime = 10;

  const disableExpr = `(function(){
    var d = document.getElementById('__lba_cur');
    if (d) d.style.transition = 'none';
  })()`;
  try { await sendCDP(tabId, "Runtime.evaluate", { expression: disableExpr }); } catch (_) {}

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const easeT = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const cx = startX + (targetX - startX) * easeT;
    const cy = startY + (targetY - startY) * easeT;
    const rx = Math.round(cx);
    const ry = Math.round(cy);

    await sendCDP(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: rx, y: ry, button: "none", buttons: 0 }).catch(() => {});
    await showAgentCursor(tabId, rx, ry, options).catch(() => {});
    await sleep(stepTime);
  }

  const enableExpr = `(function(){
    var d = document.getElementById('__lba_cur');
    if (d) d.style.transition = 'left 0.18s ease-out, top 0.18s ease-out';
  })()`;
  try { await sendCDP(tabId, "Runtime.evaluate", { expression: enableExpr }); } catch (_) {}

  const tx = Math.round(targetX);
  const ty = Math.round(targetY);
  await sendCDP(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: tx, y: ty, button: "none", buttons: 0 }).catch(() => {});
  await showAgentCursor(tabId, tx, ty, options).catch(() => {});

  STATE.lastX = tx;
  STATE.lastY = ty;
}

// Animate the cursor along the drag path — runs concurrently with synthDrag CDP events.
// Uses a linear CSS transition matching the drag duration so the cursor visually tracks the move.
async function animateCursorDrag(tabId, sx, sy, dx, dy, durationMs) {
  const expr = `(function(sx,sy,dx,dy,dur){
    var d = document.getElementById('__lba_cur'); if (!d) return;
    d.style.transition = 'none';
    d.style.left = sx+'px'; d.style.top = sy+'px';
    d.offsetHeight;
    d.style.transition = 'left '+dur+'ms linear, top '+dur+'ms linear';
    d.style.left = dx+'px'; d.style.top = dy+'px';
    setTimeout(function(){
      var d2 = document.getElementById('__lba_cur');
      if (d2 === d) d.style.transition = 'left 0.18s ease-out, top 0.18s ease-out';
    }, dur + 60);
  })(${Math.round(sx)},${Math.round(sy)},${Math.round(dx)},${Math.round(dy)},${durationMs})`;
  try { await sendCDP(tabId, "Runtime.evaluate", { expression: expr }); } catch (_) {}
}

// Show a fullscreen pointer-absorbing overlay so the user's mouse can't interfere
// with the agent's action. The cursor element sits above it (z-index 2147483647 > 2147483646).
async function showInputShield(tabId) {
  const expr = `(function(){
    if (document.getElementById('__lba_shield')) return;
    var d = document.createElement('div');
    d.id = '__lba_shield';
    d.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;'
      +'z-index:2147483646;pointer-events:none;cursor:wait;';
    var b = document.createElement('div');
    b.style.cssText = 'position:absolute;top:10px;left:50%;transform:translateX(-50%);'
      +'background:rgba(6,182,212,0.93);color:#fff;font:bold 12px/1 monospace;'
      +'padding:5px 18px;border-radius:20px;box-shadow:0 2px 10px rgba(0,0,0,0.45);'
      +'white-space:nowrap;pointer-events:none;user-select:none;';
    b.textContent = '⬡ Navy is working…';
    d.appendChild(b);
    document.documentElement.appendChild(d);
  })()`;
  try { await sendCDP(tabId, "Runtime.evaluate", { expression: expr }); } catch (_) {}
}

async function hideInputShield(tabId) {
  const expr = `(function(){var d=document.getElementById('__lba_shield');if(d)d.remove();})()`;
  try { await sendCDP(tabId, "Runtime.evaluate", { expression: expr }); } catch (_) {}
}

async function performHoverBefore(tabId, h) {
  if (!h) return;
  let coords;
  if (h.som_id != null) {
    coords = await resolveSomId(tabId, h.som_id);
  } else if (h.relative_to_som_id != null) {
    coords = await resolveContainerOffset(tabId, h.relative_to_som_id, h.x, h.y, "hover");
  } else {
    coords = await resolveCoords(tabId, h.ref, h.x, h.y, "hover");
  }
  if (!coords || coords.error) {
    console.warn("[agent] hover_before coordinate resolution failed:", coords?.error || "unknown");
    return;
  }
  const x = Math.round(coords.x);
  const y = Math.round(coords.y);

  let hoverLabel = null;
  try {
    const lblRes = await sendCDP(tabId, "Runtime.evaluate", {
      expression: `(function(x,y){
        var el=document.elementFromPoint(x,y);
        if(!el)return null;
        return (el.getAttribute('aria-label')||el.getAttribute('title')||el.getAttribute('alt')||el.textContent||'').trim().slice(0,32)||el.tagName.toLowerCase();
      })(${x},${y})`,
      returnByValue: true,
    });
    if (lblRes && lblRes.result && lblRes.result.value) hoverLabel = lblRes.result.value;
  } catch (_) {}

  await glidePointer(tabId, x, y, { label: hoverLabel, color: "#f97316" });

  try {
    await sendCDP(tabId, "Runtime.evaluate", {
      expression: `(function(x,y){
        var el = document.elementFromPoint(x,y);
        if (!el) return;
        var opts = { bubbles:true, cancelable:true, clientX:x, clientY:y, screenX:x, screenY:y };
        var pOpts = Object.assign({ pointerId:1, pointerType:'mouse', isPrimary:true }, opts);
        el.dispatchEvent(new PointerEvent('pointerover',  Object.assign({bubbles:true},  pOpts)));
        el.dispatchEvent(new PointerEvent('pointerenter', Object.assign({bubbles:false}, pOpts)));
        el.dispatchEvent(new MouseEvent('mouseover',  Object.assign({bubbles:true},  opts)));
        el.dispatchEvent(new MouseEvent('mouseenter', Object.assign({bubbles:false}, opts)));
      })(${x},${y})`,
    });
  } catch (_) {}

  const waitMs = typeof h.wait_ms === "number" ? Math.max(h.wait_ms, 50) : 300;
  await sleep(waitMs);
}

async function actClick(tabId, a) {
  const tabBefore = await chrome.tabs.get(tabId);
  const urlBefore = tabBefore.url;
  const fpBefore = await domFingerprint(tabId);
  let dataUrlBefore = null;
  try {
    dataUrlBefore = await captureTabForDiff(tabId, tabBefore.windowId);
  } catch (_) {}

  if (a.hover_before) {
    await performHoverBefore(tabId, a.hover_before);
  } else if (STATE.lastActionType === "hover" && STATE.lastHoverTarget && STATE.batchDepth === 0) {
    console.log("[agent] Reactively re-triggering previous hover to restore transient element visibility:", STATE.lastHoverTarget);
    await performHoverBefore(tabId, STATE.lastHoverTarget);
  }

  let x, y;

  // --- Priority 0: canvas_label — AI-generated canvas SOM from scan_canvas.
  // The model scanned the canvas visually and stored label→position mappings.
  // This path is as reliable as som_id: no visual estimation at click time.
  if (a.canvas_label != null && a.canvas_som_id != null) {
    const map = STATE.canvasLabelMap[a.canvas_som_id];
    if (!map || map.length === 0) {
      return { success: false, action_type: "click",
               error: `Canvas ${a.canvas_som_id} has not been scanned. Call scan_canvas first to map its elements.` };
    }
    const entry = map.find(e => e.label === String(a.canvas_label));
    if (!entry) {
      return { success: false, action_type: "click",
               error: `Label "${a.canvas_label}" not found in canvas ${a.canvas_som_id} scan. ` +
                      `Available labels: [${map.map(e => e.label).join(", ")}]. ` +
                      `Call scan_canvas again if the canvas changed.` };
    }
    x = entry.x;
    y = entry.y;

  // --- Priority 1: som_id — exact centre from the cached element map.
  // No verification needed; coordinates are computed from getBoundingClientRect,
  // not estimated by the LLM from a screenshot.
  } else if (a.som_id != null) {
    // resolveSomId auto-rescans the live DOM on cache miss (handles SPA re-renders)
    const pt = await resolveSomId(tabId, a.som_id);
    if (pt) {
      x = pt.x; y = pt.y;
    } else {
      if (a.x != null && a.y != null) { x = a.x; y = a.y; }
      else return { success: false, action_type: "click",
                    error: `som_id ${a.som_id} not found in element map — page may have changed. Re-read the snapshot.` };
    }
  // --- Priority 2: DOM ref — resolve to exact DOM centre via CDP
  } else if (a.ref) {
    let object, model;
    try {
      ({ object, model } = await getBoxModelAnywhere(tabId, Number(a.ref)));
    } catch (e) {
      return { success: false, action_type: "click", error: `ref ${a.ref} is stale or not found — re-read the accessibility tree to get fresh refs.` };
    }
    const [x1, y1, x2, , , y3] = model.content;
    x = (x1 + x2) / 2;
    y = (y1 + y3) / 2;
  // --- Priority 3: container-relative offset — page coords auto-converted to viewport
  } else if (a.relative_to_som_id != null) {
    const pt = await resolveContainerOffset(tabId, a.relative_to_som_id, a.x, a.y, "click");
    if (pt.error) return { success: false, ...pt };
    x = pt.x;
    y = pt.y;
  // --- Priority 4: raw (x,y) — user-estimated coords, needs verification
  } else {
    const coords = await resolveCoords(tabId, null, a.x, a.y, "click");
    if (coords.error) return { success: false, ...coords };
    x = coords.x;
    y = coords.y;

    // Snap to the exact center of whatever element sits at these coords.
    // Improves accuracy when the LLM estimates coordinates from a screenshot
    // (e.g., dynamic targets not in the SoM map, aim games, moving elements).
    // Also detects canvas targets so the crop-verify step can be skipped for them.
    let isCanvasClick = false;
    try {
      const snapResult = await sendCDP(tabId, "Runtime.evaluate", {
        expression: `(function(cx,cy){
          // Descend through same-origin iframes: elementFromPoint on the top document
          // returns the <iframe> element, not the content inside it. Without piercing,
          // a canvas embedded in a frame (very common: the whole app is an iframed
          // canvas) is never recognized as a canvas click, so the canvas fast-path is
          // skipped and the generic crop-verify runs instead. ox/oy accumulate the
          // iframe offset so inner-document coords map back to top-viewport space.
          var ox = 0, oy = 0, el = document.elementFromPoint(cx, cy), guard = 0;
          while (el && el.tagName === 'IFRAME' && guard++ < 5) {
            var ir = el.getBoundingClientRect(), idoc = null;
            try { idoc = el.contentDocument; } catch (e) { idoc = null; } // cross-origin → stop
            if (!idoc) break;
            ox += ir.left; oy += ir.top;
            var inner = idoc.elementFromPoint(cx - ox, cy - oy);
            if (!inner) break;
            el = inner;
          }
          if (!el || el.tagName === 'HTML' || el.tagName === 'BODY') return null;
          if (el.tagName === 'CANVAS') return { isCanvas: true };
          // Still an IFRAME after the descent = we could NOT enter it (cross-origin).
          // Its interior is pixels to us, exactly like a canvas, so treat it as one.
          // Two things go wrong otherwise, and together they make every cross-origin
          // embed (games, players, payment/captcha widgets, maps, docs) unclickable:
          //   1. The centre-snap below would drag EVERY click inside the frame to the
          //      frame's own centre — one dead spot for the whole embed.
          //   2. isCanvas stays false, so the click is routed through the pre-click LLM
          //      crop-verify — the very path the comment below says mis-estimates pixel
          //      surfaces by 50-80px, and which can drop the click outright.
          // Verified: a bare CDP click at the same coordinate DOES drive the frame, so
          // the dispatch was never the problem — this classification was.
          if (el.tagName === 'IFRAME') return { isCanvas: true };
          var r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) return null;
          // r is relative to el's own document; add the accumulated iframe offset to
          // return top-viewport coords the CDP click can use directly.
          var ecx = r.left + ox + r.width  / 2;
          var ecy = r.top  + oy + r.height / 2;
          var dist = Math.hypot(ecx - cx, ecy - cy);
          if (dist > 60) return null;
          return { x: ecx, y: ecy };
        })(${Math.round(x)},${Math.round(y)})`,
        returnByValue: true,
      });
      if (snapResult && snapResult.result && snapResult.result.value) {
        if (snapResult.result.value.isCanvas) {
          isCanvasClick = true;
        } else {
          x = snapResult.result.value.x;
          y = snapResult.result.value.y;
        }
      }
    } catch (_) {}

    // Always move the cursor to the estimated position before any action or
    // verification — the user must see the pointer arrive at the target.
    await glidePointer(tabId, x, y);

    // Pre-click verification: show crosshair, screenshot, let LLM confirm.
    // Skipped for som_id and ref clicks (already exact) and canvas clicks
    // (canvas has no DOM snap target; the LLM verifier sees a static canvas render
    // and consistently mis-estimates button centers, adding 50-80px of drift.
    // Canvas apps use the hover-verify protocol instead, which is reliable).
    if (!a.confirmed && !isCanvasClick) {
      await showCrosshair(tabId, x, y);
      await sleep(60);
      const verifyTab = await chrome.tabs.get(tabId);
      // BUG FIX: chrome.tabs.Tab has NO width/height (those are on windows), so the
      // old `verifyTab.width || 1280` always used 1280×800. cropScreenshotAroundCoords
      // derives DPR as bitmap.width/logicalW, so a wrong logicalW mis-centers the crop
      // AND breaks the crop-px→logical-px offset mapping — the pre-click verifier then
      // judged a crop that was NOT centered on the target and "corrected" clicks to the
      // wrong place. Use the real CSS viewport so centering and offset math both hold.
      const { w: vpW, h: vpH } = await getViewportSize(tabId);
      let verifyShotB64 = null;
      let verifyOffsetX = x - 175;
      let verifyOffsetY = y - 175;
      try {
        const dataUrl = await safeCaptureVisibleTab(
          verifyTab.windowId, { format: "jpeg", quality: 85 }
        );
        // Crop a 420x420 square centered around the click target coordinates (x, y).
        // Larger + higher quality makes tiny controls readable to the verifier.
        const cropW = 420, cropH = 420;
        verifyShotB64 = await cropScreenshotAroundCoords(
          dataUrl, x, y, vpW, vpH, cropW, cropH
        );
        // Annotate the crop with a cyan crosshair so the verifier sees exactly
        // where the click is planned, reducing off-by-dozens coordinate drift.
        if (verifyShotB64) {
          try {
            const annotated = await annotateScreenshot(verifyShotB64, "image/jpeg", {
              crosshairX: x - Math.max(0, Math.min(vpW - cropW, x - cropW/2)),
              crosshairY: y - Math.max(0, Math.min(vpH - cropH, y - cropH/2)),
              viewportW: cropW,
              viewportH: cropH,
              label: (a.reasoning || "").slice(0, 40),
            });
            if (annotated) verifyShotB64 = annotated;
          } catch (_) {}
        }
        verifyOffsetX = Math.max(0, Math.min(vpW - 350, x - 175));
        verifyOffsetY = Math.max(0, Math.min(vpH - 350, y - 175));
      } catch (_) {}
      await removeCrosshair(tabId);

      if (verifyShotB64) {
        // Don't broadcast screenshot_ready here — the crop is sent to the LLM
        // directly via verify_screenshot and showing it in the panel chat would
        // render a distorted thin strip (32×20 thumbnail of a 350×350 crop).
        return { success: false, action_type: "click", verify_screenshot: verifyShotB64, verify_offset_x: verifyOffsetX, verify_offset_y: verifyOffsetY, verify_crop_w: cropW, verify_crop_h: cropH, x, y };
      }
    }
  }

  await glidePointer(tabId, x, y);
  await sleep(120);
  // Playwright-style: wait up to 2s for the element to be visible, non-disabled,
  // and receiving pointer events before firing the click.
  await waitForClickable(tabId, x, y, 2000);
  // Target-response check: did the element WE clicked actually react? Captured
  // around the click so a page change elsewhere can't masquerade as this target
  // responding (the loose "something changed = success" trap).
  const targetSigBefore = await captureTargetSignature(tabId, x, y);
  // Pixel surfaces (canvas/WebGL/VNC) have no DOM signature — fall back to a
  // localized pixel signature so canvas clicks get verified too instead of
  // permanently landing in the "ambiguous" tier.
  let pixelSigBefore = null;
  if (targetSigBefore === null) {
    pixelSigBefore = await capturePixelSignature(tabId, x, y);
  }
  await synthClick(tabId, x, y);
  await waitForDOMStability(tabId, 3500, 350);
  let targetChecked = false, targetResponded = null;
  if (targetSigBefore !== null) {
    targetChecked = true;
    const targetSigAfter = await captureTargetSignature(tabId, x, y);
    // A null after-signature means the spot is no longer a plain element (navigated,
    // re-rendered) — that IS a response. Otherwise compare the signatures.
    targetResponded = targetSigAfter === null ? true : targetSigAfter !== targetSigBefore;
  } else if (pixelSigBefore) {
    // Canvas apps repaint asynchronously — give the response frame time to land.
    await sleep(350);
    const pixelSigAfter = await capturePixelSignature(tabId, x, y);
    if (pixelSigAfter) {
      targetChecked = true;
      targetResponded = pixelSigDiffFraction(pixelSigBefore, pixelSigAfter) > 0.05;
    }
  }
  // target_kind tells the agent HOW the response was judged. "pixel" = a canvas/WebGL
  // surface, verified by the pixels under the cursor. That distinction matters: a canvas
  // button's own pixels are usually STATIC (the feedback shows up in a display, a score,
  // a board square somewhere else), so "the target didn't react" is NOT evidence of a
  // mis-click there — and must not be reported as one.
  return verifyPageChange(tabId, urlBefore, fpBefore, dataUrlBefore, "click",
    { success: true, action_type: "click", target_checked: targetChecked, target_responded: targetResponded,
      target_kind: targetSigBefore === null ? "pixel" : "dom" });
}

// When a ref is stale (page re-rendered between snapshot and execution),
// fall back to finding the best matching input by CSS selectors.
async function focusInputFallback(tabId) {
  // Only focus if there is EXACTLY ONE visible text input on the page.
  // If zero or multiple inputs are found, return false so the caller surfaces an explicit error
  // instead of silently typing into the wrong field.
  const expr = `(function() {
    const candidates = [
      ...document.querySelectorAll(
        'input[type="search"]:not([disabled]),[role="searchbox"]:not([disabled]),' +
        'input[name="search"]:not([disabled]),input[placeholder]:not([disabled]),' +
        'textarea:not([disabled]),input[type="text"]:not([disabled])'
      )
    ].filter(e => e.offsetParent !== null);
    if (candidates.length !== 1) return false;
    candidates[0].focus();
    candidates[0].select();
    return true;
  })()`;
  const { result } = await sendCDP(tabId, "Runtime.evaluate", { expression: expr, returnByValue: true });
  return result.value === true;
}

async function actType(tabId, a) {
  const tabBefore = await chrome.tabs.get(tabId);
  const urlBefore = tabBefore.url;
  const fpBefore = await domFingerprint(tabId);
  let dataUrlBefore = null;
  try {
    dataUrlBefore = await captureTabForDiff(tabId, tabBefore.windowId);
  } catch (_) {}

  if (a.hover_before) {
    await performHoverBefore(tabId, a.hover_before);
  } else if (STATE.lastActionType === "hover" && STATE.lastHoverTarget && STATE.batchDepth === 0) {
    console.log("[agent] Reactively re-triggering previous hover to restore transient element visibility:", STATE.lastHoverTarget);
    await performHoverBefore(tabId, STATE.lastHoverTarget);
  }

  let cursorX = null, cursorY = null;
  if (a.ref) {
    let object, sessionId;
    try {
      try {
        const { object: obj, model, sessionId: sessId } = await getBoxModelAnywhere(tabId, Number(a.ref));
        object = obj; sessionId = sessId;
        const [x1, y1, x2, , , y3] = model.content;
        cursorX = (x1 + x2) / 2;
        cursorY = (y1 + y3) / 2;
      } catch (_) {
        const res = await resolveNodeAnywhere(tabId, Number(a.ref));
        object = res.object; sessionId = res.sessionId;
      }
      await sendRoutedCDP(tabId, sessionId, "DOM.focus", { objectId: object.objectId });
      await sendCDP(tabId, "Input.dispatchKeyEvent", {
        type: "rawKeyDown", windowsVirtualKeyCode: 65, key: "a",
        modifiers: 2, // Ctrl
      });
      await sendCDP(tabId, "Input.dispatchKeyEvent", {
        type: "keyUp", windowsVirtualKeyCode: 65, key: "a", modifiers: 2,
      });
    } catch (e) {
      // Before giving up, check if there is a large canvas (VNC/game page).
      // If so, the ref was wrong but we can still type via canvas key events below.
      const hasCanvas = await (async () => {
        try {
          const [ci] = await chrome.scripting.executeScript({ target: { tabId }, func: _getLargestCanvasPage });
          return !!(ci?.result);
        } catch (_) { return false; }
      })();
      if (!hasCanvas) {
        const ok = await focusInputFallback(tabId);
        if (!ok) {
          return { success: false, action_type: "type", error: `ref ${a.ref} stale — page has no visible input field. If this is a reading/content page with no text boxes, use 'read' to extract the content, then emit done with what you found.` };
        }
      }
      await sendCDP(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 65, key: "a", modifiers: 2 });
      await sendCDP(tabId, "Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 65, key: "a", modifiers: 2 });
    }
  } else if (a.som_id != null || a.relative_to_som_id != null || (a.x != null && a.y != null)) {
    // som_id / container-offset / raw-coord targeting. Without this, NOTHING focused the
    // target and every keystroke below went to document.activeElement (usually <body>) —
    // the text silently vanished. `key` already routed these through ensureElementFocused;
    // `type` did not. Same helper, same behaviour (selector focus, click-to-focus fallback).
    if (a.som_id != null) {
      const pt = await resolveSomId(tabId, a.som_id);
      if (pt) { cursorX = pt.x; cursorY = pt.y; }
    } else if (a.relative_to_som_id != null) {
      const pt = await resolveContainerOffset(tabId, a.relative_to_som_id, a.x, a.y, "type");
      if (!pt.error) { cursorX = pt.x; cursorY = pt.y; }
    } else {
      const pt = await resolveCoords(tabId, null, a.x, a.y, "type");
      if (!pt.error) { cursorX = pt.x; cursorY = pt.y; }
    }
    await ensureElementFocused(tabId, a.som_id, null, cursorX, cursorY, a.relative_to_som_id);
    // Select any existing content so the new text REPLACES it (mirrors the ref path).
    await sendCDP(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 65, key: "a", modifiers: 2 });
    await sendCDP(tabId, "Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 65, key: "a", modifiers: 2 });
  }
  if (cursorX !== null && cursorY !== null) {
    await glidePointer(tabId, cursorX, cursorY);
  }

  // Date/time inputs don't accept insertText or char events — the browser renders
  // a native picker widget. Use direct .value assignment instead.
  let usedDirectAssign = false;
  try {
    const { result: typeCheck } = await sendCDP(tabId, "Runtime.evaluate", {
      expression: `(function(){
        var el = document.activeElement;
        if (!el || el.tagName !== 'INPUT') return '';
        return el.type ? el.type.toLowerCase() : '';
      })()`,
      returnByValue: true,
    });
    const inputType = typeCheck?.value || "";
    if (["date","datetime-local","time","month","week"].includes(inputType)) {
      await sendCDP(tabId, "Runtime.evaluate", {
        expression: `(function(v){
          var el = document.activeElement;
          if (!el) return;
          var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
          if (setter && setter.set) setter.set.call(el, v);
          else el.value = v;
          el.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));
          el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        })(${JSON.stringify(a.text)})`,
      });
      usedDirectAssign = true;
    }
  } catch (_) {}

  // Rich text editor detection — contenteditable, Quill, CodeMirror 6/5, Monaco
  // These elements don't respond correctly to Input.insertText / char events.
  if (!usedDirectAssign) {
    try {
      const { result: richCheck } = await sendCDP(tabId, "Runtime.evaluate", {
        expression: `(function(){
          var el = document.activeElement;
          if (!el) return '';
          if (el.isContentEditable) return 'contenteditable';
          if (el.classList.contains('cm-content')) return 'codemirror6';
          if (el.classList.contains('CodeMirror-code')) return 'codemirror5';
          if (el.classList.contains('view-line') && el.closest('.monaco-editor')) return 'monaco';
          if (el.classList.contains('ql-editor')) return 'quill';
          return '';
        })()`,
        returnByValue: true,
      });
      const richType = richCheck?.value || '';
      if (richType === 'contenteditable' || richType === 'quill') {
        await sendCDP(tabId, "Runtime.evaluate", {
          expression: `(function(txt){
            var el = document.activeElement;
            if (!el) return;
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, txt);
            el.dispatchEvent(new Event('input', { bubbles: true }));
          })(${JSON.stringify(a.text)})`,
        });
        usedDirectAssign = true;
      } else if (richType === 'codemirror6') {
        await sendCDP(tabId, "Runtime.evaluate", {
          expression: `(function(txt){
            var el = document.activeElement;
            var view = el && el.cmView && el.cmView.editorView;
            if (view && view.dispatch) {
              view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: txt } });
            } else {
              document.execCommand('selectAll', false, null);
              document.execCommand('insertText', false, txt);
            }
          })(${JSON.stringify(a.text)})`,
        });
        usedDirectAssign = true;
      } else if (richType === 'codemirror5') {
        await sendCDP(tabId, "Runtime.evaluate", {
          expression: `(function(txt){
            var wrap = document.activeElement.closest('.CodeMirror');
            var cm = wrap && wrap.CodeMirror;
            if (cm) { cm.setValue(txt); } else {
              document.execCommand('selectAll', false, null);
              document.execCommand('insertText', false, txt);
            }
          })(${JSON.stringify(a.text)})`,
        });
        usedDirectAssign = true;
      } else if (richType === 'monaco') {
        await sendCDP(tabId, "Runtime.evaluate", {
          expression: `(function(txt){
            var models = (typeof monaco !== 'undefined') && monaco.editor && monaco.editor.getModels();
            if (models && models.length) { models[0].setValue(txt); } else {
              document.execCommand('selectAll', false, null);
              document.execCommand('insertText', false, txt);
            }
          })(${JSON.stringify(a.text)})`,
        });
        usedDirectAssign = true;
      }
    } catch (_) {}
  }

  // Canvas elements (games, VNC) need real key events — insertText bypasses canvas
  // keyboard handlers. Dispatch keyDown + char + keyUp for each character instead.
  // Detection looks for any large canvas, not just the active element, because
  // VNC canvases are often not the active element until explicitly focused.
  if (!usedDirectAssign) {
    try {
      const { result: canvasCheck } = await sendCDP(tabId, "Runtime.evaluate", {
        expression: `(function(){
          var el = document.activeElement;
          // If a real text input or editable element is already focused, use normal path.
          if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return '';
          // Look for a large canvas (VNC, game, terminal). Focus it so key events land there.
          var best = null, bestArea = 0;
          document.querySelectorAll('canvas').forEach(function(c) {
            var r = c.getBoundingClientRect();
            if (r.width < 200 || r.height < 150) return;
            var area = r.width * r.height;
            if (area > bestArea) { bestArea = area; best = c; }
          });
          if (!best) return '';
          try { best.focus(); } catch (_) {}
          return 'canvas';
        })()`,
        returnByValue: true,
      });
      if (canvasCheck?.value === 'canvas') {
        const CANVAS_KEY_MAP = {
          // Letters (a-z)
          ...Object.fromEntries("abcdefghijklmnopqrstuvwxyz".split("").map(c => [c, { vk: c.charCodeAt(0) - 32, code: `Key${c.toUpperCase()}`, shift: false }])),
          // Letters (A-Z)
          ...Object.fromEntries("ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map(c => [c, { vk: c.charCodeAt(0), code: `Key${c}`, shift: true }])),
          // Digits (0-9)
          ...Object.fromEntries("0123456789".split("").map((c, i) => [c, { vk: 48 + i, code: `Digit${i}`, shift: false }])),
          // Shifted digits
          ")": { vk: 48, code: "Digit0", shift: true },
          "!": { vk: 49, code: "Digit1", shift: true },
          "@": { vk: 50, code: "Digit2", shift: true },
          "#": { vk: 51, code: "Digit3", shift: true },
          "$": { vk: 52, code: "Digit4", shift: true },
          "%": { vk: 53, code: "Digit5", shift: true },
          "^": { vk: 54, code: "Digit6", shift: true },
          "&": { vk: 55, code: "Digit7", shift: true },
          "*": { vk: 56, code: "Digit8", shift: true },
          "(": { vk: 57, code: "Digit9", shift: true },
          // Punctuation and symbols
          " ": { vk: 32, code: "Space", shift: false },
          "\n": { vk: 13, code: "Enter", shift: false },
          "\r": { vk: 13, code: "Enter", shift: false },
          "\t": { vk: 9, code: "Tab", shift: false },
          ";": { vk: 186, code: "Semicolon", shift: false },
          ":": { vk: 186, code: "Semicolon", shift: true },
          "=": { vk: 187, code: "Equal", shift: false },
          "+": { vk: 187, code: "Equal", shift: true },
          ",": { vk: 188, code: "Comma", shift: false },
          "<": { vk: 188, code: "Comma", shift: true },
          "-": { vk: 189, code: "Minus", shift: false },
          "_": { vk: 189, code: "Minus", shift: true },
          ".": { vk: 190, code: "Period", shift: false },
          ">": { vk: 190, code: "Period", shift: true },
          "/": { vk: 191, code: "Slash", shift: false },
          "?": { vk: 191, code: "Slash", shift: true },
          "`": { vk: 192, code: "Backquote", shift: false },
          "~": { vk: 192, code: "Backquote", shift: true },
          "[": { vk: 219, code: "BracketLeft", shift: false },
          "{": { vk: 219, code: "BracketLeft", shift: true },
          "\\": { vk: 220, code: "Backslash", shift: false },
          "|": { vk: 220, code: "Backslash", shift: true },
          "]": { vk: 221, code: "BracketRight", shift: false },
          "}": { vk: 221, code: "BracketRight", shift: true },
          "'": { vk: 222, code: "Quote", shift: false },
          "\"": { vk: 222, code: "Quote", shift: true }
        };

        for (const ch of a.text) {
          const info = CANVAS_KEY_MAP[ch] || { vk: ch.charCodeAt(0), code: "", shift: false };
          const mods = info.shift ? 8 : 0;

          if (info.shift) {
            await sendCDP(tabId, "Input.dispatchKeyEvent", {
              type: "rawKeyDown",
              key: "Shift",
              code: "ShiftLeft",
              windowsVirtualKeyCode: 16,
              modifiers: 8
            });
          }

          await sendCDP(tabId, "Input.dispatchKeyEvent", {
            type: "rawKeyDown",
            key: ch,
            code: info.code,
            windowsVirtualKeyCode: info.vk,
            modifiers: mods
          });

          await sendCDP(tabId, "Input.dispatchKeyEvent", {
            type: "char",
            text: ch,
            modifiers: mods
          });

          await sendCDP(tabId, "Input.dispatchKeyEvent", {
            type: "keyUp",
            key: ch,
            code: info.code,
            windowsVirtualKeyCode: info.vk,
            modifiers: mods
          });

          if (info.shift) {
            await sendCDP(tabId, "Input.dispatchKeyEvent", {
              type: "keyUp",
              key: "Shift",
              code: "ShiftLeft",
              windowsVirtualKeyCode: 16,
              modifiers: 0
            });
          }
        }
        usedDirectAssign = true;
      }
    } catch (_) {}
  }

  if (!usedDirectAssign) {
    // Guard: verify the focused element is actually editable before dispatching
    // characters. Without this, characters land on whatever element happens to
    // have focus (a canvas, a div, a button) and the action silently "succeeds"
    // with no visible effect. This is especially important when no ref was
    // provided and focusInputFallback placed focus on a heuristically chosen element.
    try {
      const { result: editableChk } = await sendCDP(tabId, "Runtime.evaluate", {
        expression: `!!(function(){var e=document.activeElement;return e&&(e.tagName==='INPUT'||e.tagName==='TEXTAREA'||e.isContentEditable);}())`,
        returnByValue: true,
      });
      if (editableChk?.value === false) {
        return {
          success: false,
          action_type: "type",
          error: "type: the focused element is not an editable field — click the target input first, then type",
        };
      }
    } catch (_) {
      // CDP unavailable — let it through and surface a natural error below
    }
    try {
      await sendCDP(tabId, "Input.insertText", { text: a.text });
    } catch (_) {
      for (const ch of a.text) {
        await sendCDP(tabId, "Input.dispatchKeyEvent", { type: "char", text: ch });
      }
    }
    // Fire React/Vue/Angular controlled-input events so frameworks detect the change.
    try {
      await sendCDP(tabId, "Runtime.evaluate", {
        expression: `(function() {
          var el = document.activeElement;
          if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && !el.isContentEditable)) return;
          var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          var nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value');
          if (nativeSetter && nativeSetter.set) nativeSetter.set.call(el, el.value);
          el.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));
          el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        })()`,
      });
    } catch (_) {}
  }
  if (a.submit) {
    await sendCDP(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 13, key: "Enter" });
    await sendCDP(tabId, "Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 13, key: "Enter" });
    await waitForDOMStability(tabId, 5000, 450);
  } else {
    await waitForDOMStability(tabId, 2000, 300);
  }
  const tab = await chrome.tabs.get(tabId);
  let suggestionsVisible = false;
  try {
    const { result } = await sendCDP(tabId, "Runtime.evaluate", {
      expression: `(function(){
        var sels=['[role="listbox"]','[role="option"]','.pac-container',
                  '[aria-expanded="true"] ul','[role="combobox"] + ul',
                  '.tt-menu:not([style*="none"])','[role="suggestion"]',
                  '.suggestions:not([style*="display: none"])'];
        return sels.some(function(s){
          var el=document.querySelector(s);
          return el && el.offsetParent!==null && el.getBoundingClientRect().height > 0;
        });
      })()`,
      returnByValue: true,
    });
    suggestionsVisible = !!(result && result.value);
  } catch (_) {}

  let valueMismatch = false;
  let actualValue = null;
  try {
    const { result } = await sendCDP(tabId, "Runtime.evaluate", {
      expression: `(function(){
        var el = document.activeElement;
        if (el && (el.tagName.toLowerCase() === 'input' || el.tagName.toLowerCase() === 'textarea' || el.isContentEditable)) {
          return el.isContentEditable ? el.textContent : el.value;
        }
        return null;
      })()`,
      returnByValue: true
    });
    if (result && result.value !== undefined && result.value !== null) {
      actualValue = result.value;
      if (actualValue !== a.text) {
        valueMismatch = true;
      }
    }
  } catch (_) {}

  const res = {
    success: true, action_type: "type",
    suggestions_visible: suggestionsVisible,
    actual_value: actualValue, value_mismatch: valueMismatch
  };
  return verifyPageChange(tabId, urlBefore, fpBefore, dataUrlBefore, "type", res);
}

// Helper: read current scroll state of the document
async function getScrollInfo(tabId) {
  try {
    const { result } = await sendCDP(tabId, "Runtime.evaluate", {
      expression: `({
        scrollY:    Math.round(window.scrollY),
        scrollX:    Math.round(window.scrollX),
        pageH:      Math.round(document.documentElement.scrollHeight),
        pageW:      Math.round(document.documentElement.scrollWidth),
        viewH:      Math.round(window.innerHeight),
        viewW:      Math.round(window.innerWidth),
      })`,
      returnByValue: true,
    });
    const v = result?.value;
    if (!v) return {};
    const pctY     = v.pageH > 0 ? Math.round((v.scrollY / v.pageH) * 100) : 0;
    const belowFold = Math.max(0, v.pageH - v.scrollY - v.viewH);
    return {
      scroll_y: v.scrollY, scroll_x: v.scrollX,
      page_height: v.pageH, viewport_height: v.viewH,
      scrolled_pct: pctY,
      px_below_fold: belowFold,
    };
  } catch (_) { return {}; }
}

async function actScroll(tabId, a) {
  const tabBefore = await chrome.tabs.get(tabId);
  const urlBefore = tabBefore.url;
  const fpBefore = await domFingerprint(tabId);
  const scrollBefore = await getScrollInfo(tabId);
  // Do NOT capture a screenshot before scroll — on VNC/canvas pages each capture
  // takes several seconds and the two-capture cost (before + inside detectVisualChange)
  // routinely exceeds the 15s action timeout. Scroll is verified by position delta, not pixels.
  const dataUrlBefore = null;

  if (a.hover_before) {
    await performHoverBefore(tabId, a.hover_before);
  } else if (STATE.lastActionType === "hover" && STATE.lastHoverTarget && STATE.batchDepth === 0) {
    console.log("[agent] Reactively re-triggering previous hover to restore transient element visibility:", STATE.lastHoverTarget);
    await performHoverBefore(tabId, STATE.lastHoverTarget);
  }

  const dir = (a.direction || "down").toLowerCase();

  // ── Mode 1: scroll a specific element into view by som_id ─────────────────
  if (a.som_id != null) {
    const pt = await resolveSomId(tabId, a.som_id);
    if (!pt) return { success: false, action_type: "scroll", error: `som_id ${a.som_id} not found` };
    await sendCDP(tabId, "Runtime.evaluate", {
      expression: `(function(x,y){
        var el = document.elementFromPoint(x, y);
        if (el) { el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" }); return true; }
        return false;
      })(${Math.round(pt.x)}, ${Math.round(pt.y)})`,
    });
    await waitForDOMStability(tabId, 1500, 250);
    const scrollInfo = await getScrollInfo(tabId);
    return verifyPageChange(tabId, urlBefore, fpBefore, dataUrlBefore, "scroll", { success: true, action_type: "scroll", ...scrollInfo });
  }

  // ── Mode 1b: absolute scroll to page top or bottom ────────────────────────
  if (dir === "top" || dir === "bottom") {
    const expr = dir === "top"
      ? `window.scrollTo({ top: 0, left: 0, behavior: "smooth" }); "ok"`
      : `window.scrollTo({ top: document.documentElement.scrollHeight, left: 0, behavior: "smooth" }); "ok"`;
    await sendCDP(tabId, "Runtime.evaluate", { expression: expr, returnByValue: true });
    await waitForDOMStability(tabId, 1500, 250);
    const scrollInfo = await getScrollInfo(tabId);
    return verifyPageChange(tabId, urlBefore, fpBefore, dataUrlBefore, "scroll", { success: true, action_type: "scroll", ...scrollInfo });
  }

  // ── Mode 2: directional scroll of document or a named container ───────────
  // amount: number of pixels, or undefined = one full viewport height
  const isHoriz = dir === "left" || dir === "right";
  const sign    = (dir === "down" || dir === "right") ? 1 : -1;

  // If selector is given, scroll that container; otherwise scroll the document
  const containerSel = a.selector ? JSON.stringify(a.selector) : null;
  const amountExpr   = typeof a.amount === "number"
    ? String(a.amount)
    : (isHoriz ? "window.innerWidth" : "window.innerHeight");

  const scrollJsExpr = containerSel
    ? `(function(){
        var el = document.querySelector(${containerSel});
        if (!el) { return "not_found"; }
        el.scrollBy({ ${isHoriz ? "left" : "top"}: ${sign} * ${amountExpr}, behavior: "smooth" });
        return "ok";
      })()`
    : `(function(){
        window.scrollBy({ ${isHoriz ? "left" : "top"}: ${sign} * ${amountExpr}, behavior: "smooth" });
        return "ok";
      })()`;

  const cx = a.x ?? 640, cy = a.y ?? 400;
  await glidePointer(tabId, cx, cy);

  // Primary: JS scrollBy (works on virtually all pages including SPAs)
  const { result: jsRes } = await sendCDP(tabId, "Runtime.evaluate", {
    expression: scrollJsExpr, returnByValue: true,
  });
  if (jsRes?.value === "not_found") {
    return { success: false, action_type: "scroll", error: `selector "${a.selector}" not found on page` };
  }

  // Secondary: also fire mouseWheel event (for sites that listen to wheel events on custom containers)
  const pxHint  = typeof a.amount === "number" ? a.amount : 400;
  const wdx = isHoriz ? sign * pxHint : 0;
  const wdy = isHoriz ? 0 : sign * pxHint;
  try {
    await sendCDP(tabId, "Input.dispatchMouseEvent", {
      type: "mouseWheel", x: cx, y: cy, deltaX: wdx, deltaY: wdy,
    });
  } catch (_) {}

  await waitForDOMStability(tabId, 1500, 250);
  const scrollInfo = await getScrollInfo(tabId);
  const scrollChanged = (scrollInfo.scroll_y !== scrollBefore.scroll_y) || (scrollInfo.scroll_x !== scrollBefore.scroll_x);
  
  return verifyPageChange(tabId, urlBefore, fpBefore, dataUrlBefore, "scroll", { 
    success: true, 
    action_type: "scroll", 
    page_changed: scrollChanged,
    ...scrollInfo 
  });
}

async function actScrollWheel(tabId, a) {
  const tabBefore = await chrome.tabs.get(tabId);
  const urlBefore = tabBefore.url;
  const fpBefore = await domFingerprint(tabId);
  let dataUrlBefore = null;
  try {
    dataUrlBefore = await captureTabForDiff(tabId, tabBefore.windowId);
  } catch (_) {}

  let pt = { x: a.x || 0, y: a.y || 0 };
  if (a.som_id != null) {
    const resPt = await resolveSomId(tabId, a.som_id);
    if (!resPt || resPt.error) {
      return { success: false, action_type: "scroll_wheel", error: resPt?.error || `som_id ${a.som_id} not found` };
    }
    pt = resPt;
  } else if (a.relative_to_som_id != null) {
    const resPt = await resolveContainerOffset(tabId, a.relative_to_som_id, a.x, a.y, "scroll_wheel");
    if (resPt && !resPt.error) {
      pt = resPt;
    }
  } else if (a.ref) {
    const resPt = await resolveCoords(tabId, a.ref, a.x, a.y, "scroll_wheel");
    if (resPt && !resPt.error) {
      pt = resPt;
    }
  }

  const deltaX = a.delta_x || 0;
  const deltaY = a.delta_y || 0;

  console.log(`[agent] Dispatching scroll_wheel to (${pt.x}, ${pt.y}) with deltaX=${deltaX}, deltaY=${deltaY}`);
  
  await glidePointer(tabId, pt.x, pt.y);
  await sleep(50);

  await sendCDP(tabId, "Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: pt.x,
    y: pt.y,
    deltaX: deltaX,
    deltaY: deltaY,
    modifiers: 0
  });

  await waitForDOMStability(tabId, 1500, 150);

  return verifyPageChange(tabId, urlBefore, fpBefore, dataUrlBefore, "scroll_wheel", { success: true, action_type: "scroll_wheel" });
}

async function actNavigate(tabId, a) {
  await chrome.tabs.update(tabId, { url: a.url });
  await waitForLoad(tabId);
  // Cross-process navigations (new origin) silently detach the debugger.
  // Retry re-attach up to 3 times with backoff before giving up.
  let attached = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await sendCDP(tabId, "Accessibility.enable", {});
      attached = true;
      break;
    } catch (_) {
      try { await detachDebugger(); } catch (_2) {}
      try {
        await attachDebugger(tabId);
        STATE.attachedTabId = tabId;
        attached = true;
        break;
      } catch (e) {
        console.warn(`[agent] debugger re-attach attempt ${attempt + 1} failed:`, e);
        if (attempt < 2) await sleep(400 * (attempt + 1));
      }
    }
  }
  if (!attached) {
    return { success: false, action_type: "navigate", error: "debugger detached after cross-origin navigation and could not re-attach. Try navigate again or use new_tab." };
  }
  STATE.elementMapDirty = true;
  // After a cross-origin reattach, inFlightRequests still holds IDs from the
  // previous page — they'll never complete. Clear them so waitForNetworkIdle
  // doesn't return immediately on an empty-but-stale set. Then give the newly
  // enabled Network domain a short window (200ms) to observe initial requests
  // before we start polling for idle.
  STATE.inFlightRequests.clear();
  await sleep(200);
  await waitForNetworkIdle(tabId, 4000, 400);
  await waitForDOMStability(tabId, 2000, 300);
  await startTabBlink(tabId);
  const tab = await chrome.tabs.get(tabId);
  return { success: true, action_type: "navigate", url: tab.url, title: tab.title };
}

async function actPaste(tabId, a) {
  const tabBefore = await chrome.tabs.get(tabId);
  const urlBefore = tabBefore.url;
  const fpBefore  = await domFingerprint(tabId);

  // Click the target element if a som_id is given
  if (a.som_id != null) {
    const pt = await resolveSomId(tabId, a.som_id);
    if (pt) {
      await glidePointer(tabId, pt.x, pt.y);
      await synthClick(tabId, pt.x, pt.y);
      await sleep(80);
    }
  }

  if (a.text) {
    // Text supplied — insert directly via CDP (most reliable cross-origin path, bypasses clipboard permissions)
    await sendCDP(tabId, "Input.insertText", { text: a.text });
  } else {
    // No text — send Ctrl+V to paste whatever is in the system clipboard
    await sendCDP(tabId, "Input.dispatchKeyEvent", {
      type: "keyDown", modifiers: 2, key: "v", code: "KeyV", windowsVirtualKeyCode: 86,
    });
    await sleep(30);
    await sendCDP(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",   modifiers: 2, key: "v", code: "KeyV", windowsVirtualKeyCode: 86,
    });
  }

  await waitForDOMStability(tabId, 1500, 250);
  return verifyPageChange(tabId, urlBefore, fpBefore, null, "paste", { success: true, action_type: "paste" });
}

async function actKey(tabId, a) {
  const tabBefore = await chrome.tabs.get(tabId);
  const urlBefore = tabBefore.url;
  const fpBefore = await domFingerprint(tabId);
  let dataUrlBefore = null;
  try {
    dataUrlBefore = await captureTabForDiff(tabId, tabBefore.windowId);
  } catch (_) {}

  // If a target (som_id, ref, or raw x,y) is provided, focus it programmatically or via click
  if (a.som_id != null || a.ref || (a.x != null && a.y != null) || a.relative_to_som_id != null) {
    await ensureElementFocused(tabId, a.som_id, a.ref, a.x, a.y, a.relative_to_som_id);
  }

  // count: repeat the same key combo N times (clamped to 1–50)
  // Expand "Tab" with count:5 into ["Tab","Tab","Tab","Tab","Tab"]
  const repeatCount = Math.max(1, Math.min(50, parseInt(a.count || 1)));
  const rawKeys = parseKeySequence(a.key);
  const keys = [];
  if (rawKeys.length === 0) rawKeys.push("Space");
  for (let r = 0; r < repeatCount; r++) keys.push(...rawKeys);

  let lastKeyName = "";

  for (let idx = 0; idx < keys.length; idx++) {
    const singleKey = keys[idx];

    // Parse "Ctrl+Shift+A" / "Ctrl++" -> modifierBits + keyName
    let keyStr = singleKey.trim();
    let keyName = "";
    let mods = [];

    if (!keyStr) {
      keyName = "Space";
    } else {
      // Match modifiers followed by '+' at the beginning of the string
      const modRegex = /^(ctrl|control|shift|alt|meta|cmd|win)\s*\+\s*/i;
      let match;
      let remaining = keyStr;
      while ((match = remaining.match(modRegex))) {
        mods.push(match[1].toLowerCase());
        remaining = remaining.substring(match[0].length);
      }
      keyName = remaining;
      // Fallback if keyName became empty
      if (keyName === "") {
        if (keyStr.endsWith("+")) {
          keyName = "+";
        } else {
          keyName = "Space";
        }
      }
    }

    lastKeyName = keyName;

    let modifierBits = 0;
    if (mods.includes("alt"))                                     modifierBits |= 1;
    if (mods.includes("ctrl") || mods.includes("control"))       modifierBits |= 2;
    if (mods.includes("meta") || mods.includes("cmd") || mods.includes("win")) modifierBits |= 4;
    if (mods.includes("shift"))                                   modifierBits |= 8;

    // Case-insensitive key map mapping to virtual code (vk), DOM canonical name, and DOM code
    const KEY_MAP = {
      enter: { vk: 13, name: "Enter", code: "Enter" },
      return: { vk: 13, name: "Enter", code: "Enter" },
      tab: { vk: 9, name: "Tab", code: "Tab" },
      escape: { vk: 27, name: "Escape", code: "Escape" },
      esc: { vk: 27, name: "Escape", code: "Escape" },
      backspace: { vk: 8, name: "Backspace", code: "Backspace" },
      delete: { vk: 46, name: "Delete", code: "Delete" },
      insert: { vk: 45, name: "Insert", code: "Insert" },
      space: { vk: 32, name: " ", code: "Space" },
      " ": { vk: 32, name: " ", code: "Space" },
      arrowup: { vk: 38, name: "ArrowUp", code: "ArrowUp" },
      arrowdown: { vk: 40, name: "ArrowDown", code: "ArrowDown" },
      arrowleft: { vk: 37, name: "ArrowLeft", code: "ArrowLeft" },
      arrowright: { vk: 39, name: "ArrowRight", code: "ArrowRight" },
      up: { vk: 38, name: "ArrowUp", code: "ArrowUp" },
      down: { vk: 40, name: "ArrowDown", code: "ArrowDown" },
      left: { vk: 37, name: "ArrowLeft", code: "ArrowLeft" },
      right: { vk: 39, name: "ArrowRight", code: "ArrowRight" },
      pageup: { vk: 33, name: "PageUp", code: "PageUp" },
      pagedown: { vk: 34, name: "PageDown", code: "PageDown" },
      home: { vk: 36, name: "Home", code: "Home" },
      end: { vk: 35, name: "End", code: "End" },
      
      // Punctuation and symbols
      ";": { vk: 186, name: ";", code: "Semicolon" },
      ":": { vk: 186, name: ":", code: "Semicolon" },
      "semicolon": { vk: 186, name: ";", code: "Semicolon" },
      "=": { vk: 187, name: "=", code: "Equal" },
      "equal": { vk: 187, name: "=", code: "Equal" },
      "+": { vk: 187, name: "+", code: "Equal" },
      "plus": { vk: 187, name: "+", code: "Equal" },
      ",": { vk: 188, name: ",", code: "Comma" },
      "<": { vk: 188, name: "<", code: "Comma" },
      "comma": { vk: 188, name: ",", code: "Comma" },
      "-": { vk: 189, name: "-", code: "Minus" },
      "_": { vk: 189, name: "_", code: "Minus" },
      "minus": { vk: 189, name: "-", code: "Minus" },
      ".": { vk: 190, name: ".", code: "Period" },
      ">": { vk: 190, name: ">", code: "Period" },
      "period": { vk: 190, name: ".", code: "Period" },
      "/": { vk: 191, name: "/", code: "Slash" },
      "?": { vk: 191, name: "?", code: "Slash" },
      "slash": { vk: 191, name: "/", code: "Slash" },
      "`": { vk: 192, name: "`", code: "Backquote" },
      "~": { vk: 192, name: "~", code: "Backquote" },
      "backtick": { vk: 192, name: "`", code: "Backquote" },
      "[": { vk: 219, name: "[", code: "BracketLeft" },
      "{": { vk: 219, name: "{", code: "BracketLeft" },
      "\\": { vk: 220, name: "\\", code: "Backslash" },
      "|": { vk: 220, name: "|", code: "Backslash" },
      "backslash": { vk: 220, name: "\\", code: "Backslash" },
      "]": { vk: 221, name: "]", code: "BracketRight" },
      "}": { vk: 221, name: "}", code: "BracketRight" },
      "'": { vk: 222, name: "'", code: "Quote" },
      "\"": { vk: 222, name: "\"", code: "Quote" },
      "quote": { vk: 222, name: "'", code: "Quote" },

      // Shifted digits
      "!": { vk: 49, name: "!", code: "Digit1" },
      "@": { vk: 50, name: "@", code: "Digit2" },
      "#": { vk: 51, name: "#", code: "Digit3" },
      "$": { vk: 52, name: "$", code: "Digit4" },
      "%": { vk: 53, name: "%", code: "Digit5" },
      "^": { vk: 54, name: "^", code: "Digit6" },
      "&": { vk: 55, name: "&", code: "Digit7" },
      "*": { vk: 56, name: "*", code: "Digit8" },
      "(": { vk: 57, name: "(", code: "Digit9" },
      ")": { vk: 48, name: ")", code: "Digit0" },

      // Modifiers individually
      ctrl: { vk: 17, name: "Control", code: "ControlLeft" },
      control: { vk: 17, name: "Control", code: "ControlLeft" },
      alt: { vk: 18, name: "Alt", code: "AltLeft" },
      shift: { vk: 16, name: "Shift", code: "ShiftLeft" },
      meta: { vk: 91, name: "Meta", code: "MetaLeft" },
      cmd: { vk: 91, name: "Meta", code: "MetaLeft" },
      win: { vk: 91, name: "Meta", code: "MetaLeft" }
    };

    // Add F1 - F12
    for (let i = 1; i <= 12; i++) {
      KEY_MAP[`f${i}`] = { vk: 111 + i, name: `F${i}`, code: `F${i}` };
    }

    // Add A - Z
    for (let i = 65; i <= 90; i++) {
      const ch = String.fromCharCode(i).toLowerCase();
      KEY_MAP[ch] = { vk: i, name: String.fromCharCode(i), code: `Key${String.fromCharCode(i)}` };
    }

    // Add 0 - 9
    for (let i = 0; i <= 9; i++) {
      KEY_MAP[String(i)] = { vk: 48 + i, name: String(i), code: `Digit${i}` };
    }

    const loKey = keyName.toLowerCase();
    const keyInfo = KEY_MAP[loKey];
    const vkCode = keyInfo ? keyInfo.vk : keyName.charCodeAt(0);
    let cdpKeyName = keyInfo ? keyInfo.name : keyName;
    // Dynamically adjust alphabetic key case based on whether Shift is in the modifiers list.
    if (keyInfo && loKey.length === 1 && loKey >= 'a' && loKey <= 'z') {
      cdpKeyName = mods.includes("shift") ? loKey.toUpperCase() : loKey.toLowerCase();
    }
    const code = keyInfo ? keyInfo.code : undefined;

    // Fire modifier keys down first (in press order)
    const modKeys = [];
    if (modifierBits & 2) modKeys.push({ key: "Control", code: "ControlLeft", vk: 17 });
    if (modifierBits & 1) modKeys.push({ key: "Alt",     code: "AltLeft",     vk: 18 });
    if (modifierBits & 8) modKeys.push({ key: "Shift",   code: "ShiftLeft",   vk: 16 });
    if (modifierBits & 4) modKeys.push({ key: "Meta",    code: "MetaLeft",    vk: 91 });

    for (const m of modKeys) {
      await sendCDP(tabId, "Input.dispatchKeyEvent", {
        type: "rawKeyDown", windowsVirtualKeyCode: m.vk, key: m.key, code: m.code, modifiers: modifierBits,
      });
    }

    // Key down
    await sendCDP(tabId, "Input.dispatchKeyEvent", {
      type: "keyDown", windowsVirtualKeyCode: vkCode, key: cdpKeyName, code: code, modifiers: modifierBits,
    });

    // Char event for printable single characters with no ctrl/alt modifier
    const isPrintable = cdpKeyName.length === 1 && !(modifierBits & 6); // not Ctrl or Alt
    if (isPrintable) {
      const ch = (modifierBits & 8) ? cdpKeyName.toUpperCase() : cdpKeyName.toLowerCase();
      await sendCDP(tabId, "Input.dispatchKeyEvent", { type: "char", text: ch, modifiers: modifierBits });
    }

    // Key up
    await sendCDP(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp", windowsVirtualKeyCode: vkCode, key: cdpKeyName, code: code, modifiers: modifierBits,
    });

    // Release modifier keys in reverse order
    for (const m of [...modKeys].reverse()) {
      await sendCDP(tabId, "Input.dispatchKeyEvent", {
        type: "keyUp", windowsVirtualKeyCode: m.vk, key: m.key, code: m.code, modifiers: 0,
      });
    }

    if (idx < keys.length - 1) {
      await sleep(50);
    }
  }

  // Navigation/submit keys need a longer settle; everything else is fast
  const needsLongWait = ["Enter", "Return", "Tab", "Escape", "F5"].includes(lastKeyName) ||
                        (a.key || "").includes("Enter") || (a.key || "").includes("Tab");
  await waitForDOMStability(tabId, needsLongWait ? 3500 : 1000, needsLongWait ? 350 : 150);

  return verifyPageChange(tabId, urlBefore, fpBefore, dataUrlBefore, "key", { success: true, action_type: "key" });
}

function parseKeySequence(keyStr) {
  if (!keyStr) return [];
  if (keyStr === ",") return [","];
  const parts = [];
  let current = "";
  for (let i = 0; i < keyStr.length; i++) {
    const char = keyStr[i];
    if (char === ",") {
      if (current.trim()) {
        parts.push(current.trim());
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current.trim()) {
    parts.push(current.trim());
  }
  if (parts.length === 0) {
    return [keyStr];
  }
  return parts;
}

async function actRead(tabId) {
  const state = await takeSnapshot(tabId);
  return {
    success: true,
    action_type: "read",
    url: state.url,
    title: state.title,
    page_snapshot: state.accessibility_tree,
    extracted: state.visible_text,
  };
}

// Crops a zoomed view of a canvas region so the LLM can estimate coordinates precisely.
// Does NOT execute any browser action — it only captures a fresh crop and queues it
// to be shown in the NEXT snapshot's zoom_crops so the LLM can see a close-up before clicking.
async function actZoomCanvas(tabId, a) {
  try {
    const tab = await chrome.tabs.get(tabId);
    let cx = a.x || 0, cy = a.y || 0;
    // Resolve relative_to_som_id: SOM elements store CENTER (x,y), so top-left = center - size/2
    if (a.relative_to_som_id != null) {
      const el = STATE.lastElementMap[a.relative_to_som_id];
      if (el) {
        cx = (el.x - Math.round(el.w / 2)) + (a.x || 0);
        cy = (el.y - Math.round(el.h / 2)) + (a.y || 0);
      }
    }
    const shot = await safeCaptureScreenshot(tabId, 92);
    const zoomW = Math.min(a.zoom_w || 500, shot.w);
    const zoomH = Math.min(a.zoom_h || 400, shot.h);
    const crop = await cropScreenshotAroundCoords(shot.dataUrl, cx, cy, shot.w, shot.h, zoomW, zoomH);
    if (crop) STATE.pendingCanvasZoom = { b64: crop, cx, cy, note: 'zoom_region' };
    return { success: true, action_type: "zoom_canvas", page_changed: false, url: tab.url, title: tab.title };
  } catch (e) {
    return { success: false, action_type: "zoom_canvas", error: String(e.message || e) };
  }
}

// Ensure the offscreen document (for audio capture) is alive.


async function annotateScreenshot(base64Image, mimeType = "image/jpeg", options = {}) {
  await ensureOffscreenDocument();
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: "ANNOTATE_SCREENSHOT",
      base64: base64Image,
      mimeType,
      options,
    }, (res) => {
      if (chrome.runtime.lastError) return resolve(null);
      if (res && res.success && res.dataUrl) {
        const b64 = res.dataUrl.split(",")[1];
        resolve(b64 || null);
      } else {
        resolve(null);
      }
    });
  });
}

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('offscreen.html'),
      reasons: ['USER_MEDIA'],
      justification: 'Record tab audio for speech-to-text transcription',
    });
  }
}

// Captures durationMs of tab audio and returns a base64 WebM blob.
async function captureTabAudio(tabId, durationMs) {
  await ensureOffscreenDocument();

  const streamId = await new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, id => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(id);
    });
  });

  return new Promise((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error('Audio capture timed out')), durationMs + 10000);
    chrome.runtime.sendMessage(
      { target: 'offscreen', type: 'capture_audio', streamId, durationMs },
      response => {
        clearTimeout(guard);
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (response?.ok) resolve(response.audioB64);
        else reject(new Error(response?.error || 'capture failed'));
      }
    );
  });
}

// Sends audio blob to a Whisper-compatible /v1/audio/transcriptions endpoint.
// Works with OpenAI, Groq, and any compatible provider.
async function transcribeAudio(audioB64, baseUrl, apiKey) {
  const res = await fetch(`data:audio/webm;base64,${audioB64}`);
  const blob = await res.blob();

  const form = new FormData();
  form.append('file', blob, 'audio.webm');
  form.append('model', 'whisper-1');

  const base = (baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '');
  const resp = await fetch(`${base}/v1/audio/transcriptions`, {
    method: 'POST',
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    body: form,
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`STT error ${resp.status}: ${txt.slice(0, 200)}`);
  }
  const data = await resp.json();
  return (data.text || '').trim();
}

async function actListen(tabId, action) {
  const seconds = Math.max(1, Math.min(action.seconds || 5, 30));
  const durationMs = seconds * 1000;

  // Pre-check: confirm a valid base URL is configured before capturing audio.
  // transcribeAudio sends to /v1/audio/transcriptions — if baseUrl is empty it
  // would silently fail with a relative URL fetch error.
  const preCfg = await new Promise(r => chrome.storage.local.get(['baseUrl', 'apiKey'], r));
  if (!preCfg.baseUrl || !preCfg.baseUrl.startsWith("http")) {
    return {
      success: true, action_type: 'listen', page_changed: false, transcript: null,
      transcription_note: "Audio listen requires a provider with a Whisper-compatible /v1/audio/transcriptions endpoint. Configure OpenAI or Groq (or a local Whisper server) as your provider first.",
    };
  }

  let audioB64;
  try {
    audioB64 = await captureTabAudio(tabId, durationMs);
  } catch (e) {
    return { success: false, action_type: 'listen', error: `Audio capture failed: ${e.message}` };
  }

  try {
    const cfg = preCfg;
    const transcript = await transcribeAudio(audioB64, cfg.baseUrl || '', cfg.apiKey || '');
    return { success: true, action_type: 'listen', page_changed: false, transcript };
  } catch (e) {
    return {
      success: true, action_type: 'listen', page_changed: false,
      transcript: null,
      transcription_note: `Audio captured (${seconds}s) but transcription unavailable: ${e.message}. Switch to OpenAI or Groq for speech-to-text support.`,
    };
  }
}

// Wait until a CSS selector becomes visible OR specific text appears on the page.
// Polls every 500ms up to `timeout` seconds. Replaces fragile wait+read loops.
async function actWaitFor(tabId, a) {
  const maxMs = Math.min(((a.timeout || 15) * 1000), 60000);
  const selector = a.selector || null;
  const text     = a.text     || null;

  if (!selector && !text) {
    return { success: false, action_type: "wait_for", error: "wait_for requires 'selector' or 'text'" };
  }

  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const { result } = await sendCDP(tabId, "Runtime.evaluate", {
        expression: `(function(sel, txt) {
          if (sel) {
            var el = document.querySelector(sel);
            if (el) {
              var r = el.getBoundingClientRect();
              var s = window.getComputedStyle(el);
              if (r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden') {
                return { found: true, by: 'selector' };
              }
            }
          }
          if (txt) {
            var body = document.body ? (document.body.innerText || '') : '';
            if (body.includes(txt)) return { found: true, by: 'text' };
          }
          return { found: false };
        })(${JSON.stringify(selector)}, ${JSON.stringify(text)})`,
        returnByValue: true,
      });
      const val = result?.value;
      if (val?.found) {
        const tab = await chrome.tabs.get(tabId);
        return { success: true, action_type: "wait_for", found_by: val.by, url: tab.url, title: tab.title };
      }
    } catch (_) {}
    await sleep(500);
  }

  const tab = await chrome.tabs.get(tabId).catch(() => ({ url: null, title: null }));
  return {
    success: false, action_type: "wait_for",
    error: `Timeout after ${a.timeout || 15}s — '${selector || text}' did not appear. Current page: ${tab.url || "unknown"}`,
  };
}

// ---------------------------------------------------------------------------
// actExtract — structured data extraction from the current page
// Formats: "table" → [{col:val,...}], "list" → [str,...], "links" → [{text,url}],
//          "text" → plain string, "json" → parse first <pre>/script[type=json]
// ---------------------------------------------------------------------------
async function actExtract(tabId, a) {
  const fmt = (a.format || "table").toLowerCase();
  const sel = a.selector || null;

  const expr = `(function(format, selector) {
    function rootEl() {
      if (selector) {
        var el = document.querySelector(selector);
        if (!el) return null;
        return el;
      }
      return document.body;
    }
    var root = rootEl();
    if (!root) return { error: "selector not found: " + selector };

    if (format === "table") {
      var tables = selector ? [root.matches("table") ? root : root.querySelector("table")] : Array.from(document.querySelectorAll("table"));
      tables = tables.filter(Boolean);
      if (!tables.length) return { error: "no table found" };
      var tbl = tables[0];
      var rows = Array.from(tbl.querySelectorAll("tr"));
      var headers = [];
      var headerRow = rows.find(r => r.querySelectorAll("th").length > 0);
      if (headerRow) {
        headers = Array.from(headerRow.querySelectorAll("th,td")).map(c => c.innerText.trim());
      }
      var dataRows = rows.filter(r => r !== headerRow);
      var result = dataRows.map(r => {
        var cells = Array.from(r.querySelectorAll("td,th")).map(c => c.innerText.trim());
        if (headers.length) {
          var obj = {};
          headers.forEach((h,i) => { obj[h || ("col"+i)] = cells[i] || ""; });
          return obj;
        }
        return cells;
      });
      return { rows: result, headers: headers, count: result.length };
    }

    if (format === "list") {
      var items = root.querySelectorAll("li, dt, dd, .list-item, [role=listitem]");
      if (!items.length) {
        var lines = (root.innerText || "").split("\\n").map(s=>s.trim()).filter(Boolean);
        return { items: lines, count: lines.length };
      }
      var texts = Array.from(items).map(i => i.innerText.trim()).filter(Boolean);
      return { items: texts, count: texts.length };
    }

    if (format === "links") {
      var anchors = Array.from(root.querySelectorAll("a[href]"));
      var links = anchors.map(a => ({ text: a.innerText.trim(), url: a.href })).filter(l => l.url && !l.url.startsWith("javascript:"));
      return { links: links, count: links.length };
    }

    if (format === "json") {
      var pre = root.querySelector("pre") || document.querySelector("script[type='application/json']");
      if (pre) {
        try { return { data: JSON.parse(pre.textContent), parsed: true }; } catch(_) {}
        return { data: pre.textContent.substring(0, 8000), parsed: false };
      }
      return { error: "no JSON block found" };
    }

    // Default: text
    var txt = (root.innerText || root.textContent || "").substring(0, 8000);
    return { text: txt, length: txt.length };
  })(${JSON.stringify(fmt)}, ${JSON.stringify(sel)})`;

  try {
    const { result } = await sendCDP(tabId, "Runtime.evaluate", {
      expression: expr, returnByValue: true, awaitPromise: false,
    });
    const val = result?.value;
    if (!val || val.error) {
      return { success: false, action_type: "extract", error: val?.error || "extract failed" };
    }
    return { success: true, action_type: "extract", format: fmt, page_changed: false, ...val };
  } catch (e) {
    return { success: false, action_type: "extract", error: e.message };
  }
}

// ---------------------------------------------------------------------------
// actClipboardRead — reads text currently on the system clipboard
// ---------------------------------------------------------------------------
async function actClipboardRead(tabId) {
  try {
    const { result } = await sendCDP(tabId, "Runtime.evaluate", {
      expression: `navigator.clipboard.readText()`,
      returnByValue: true, awaitPromise: true,
    });
    const text = typeof result?.value === "string" ? result.value : null;
    if (text === null) {
      return { success: false, action_type: "clipboard_read", error: "clipboard empty or permission denied" };
    }
    return { success: true, action_type: "clipboard_read", text, page_changed: false };
  } catch (e) {
    return { success: false, action_type: "clipboard_read", error: e.message };
  }
}

// ---------------------------------------------------------------------------
// actWatchRegion — waits until a rectangular region of the viewport changes
// Polls every 600ms, compares pixel hash of the region across frames.
// ---------------------------------------------------------------------------
async function actWatchRegion(tabId, a) {
  const x = Math.round(a.x || 0);
  const y = Math.round(a.y || 0);
  const w = Math.round(a.w || a.width || 200);
  const h = Math.round(a.h || a.height || 100);
  const timeoutMs = Math.min((a.timeout || 15) * 1000, 60000);

  async function getRegionHash() {
    const shot = await sendCDP(tabId, "Page.captureScreenshot", {
      format: "jpeg", quality: 30,
      clip: { x, y, width: w, height: h, scale: 1 },
    });
    return shot.data ? shot.data.substring(0, 64) : "";
  }

  let baseline;
  try { baseline = await getRegionHash(); } catch (e) {
    return { success: false, action_type: "watch_region", error: `initial screenshot failed: ${e.message}` };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(600);
    try {
      const current = await getRegionHash();
      if (current !== baseline) {
        return { success: true, action_type: "watch_region", page_changed: true, region: { x, y, w, h } };
      }
    } catch (_) {}
  }
  return {
    success: false, action_type: "watch_region",
    error: `Region (${x},${y},${w},${h}) did not change within ${a.timeout || 15}s`,
  };
}

// ---------------------------------------------------------------------------
// -- File write / download helpers ---------------------------------------------

function bytesToB64(bytes) {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// Poll a download until it completes; rejects on interruption or timeout.
async function waitForDownloadComplete(downloadId, maxMs = 30000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (item) {
      if (item.state === "complete") return item;
      if (item.state === "interrupted") {
        throw new Error(`download interrupted: ${item.error || "unknown reason"}`);
      }
    }
    await sleep(200);
  }
  throw new Error("download did not complete in time (if Chrome is set to 'Ask where to save each file', a save dialog may be waiting)");
}

// Strip a model-supplied filename down to a safe basename inside Downloads/navy/.
function sanitizeWriteFilename(rawName) {
  const base = String(rawName || "").split(/[/\\]/).pop().replace(/[^\w.\- ()]/g, "_").substring(0, 120);
  if (!base || base.startsWith(".") || !/[\w]/.test(base)) return null;
  return base;
}

// actWriteFile — creates a file with generated content in Downloads/navy/.
// MV3 extensions cannot write arbitrary disk paths; chrome.downloads.download
// with a data: URL is the sanctioned write channel. The returned absolute path
// feeds directly into file_upload's native <input type="file"> strategy,
// completing the generate → write_file → file_upload loop.
async function actWriteFile(a) {
  try {
    const base = sanitizeWriteFilename(a.filename);
    if (!base) return { success: false, action_type: "write_file", error: "write_file requires a valid filename (safe characters, no paths)" };
    const raw = a.content;
    if (raw == null || raw === "") return { success: false, action_type: "write_file", error: "write_file requires non-empty content" };

    const MAX_BYTES = 2 * 1024 * 1024;
    let b64;
    if (a.encoding === "base64") {
      b64 = String(raw).replace(/\s+/g, "");
      // Enforce the size cap on base64 too (decoded ≈ 3/4 of the string) — otherwise
      // the 2MB limit is trivially bypassed by encoding, producing an oversized data URL.
      if (Math.floor(b64.length * 3 / 4) > MAX_BYTES) {
        return { success: false, action_type: "write_file", error: "content exceeds the 2MB write_file limit" };
      }
      try { atob(b64); } catch (_) {
        return { success: false, action_type: "write_file", error: "content is not valid base64" };
      }
    } else {
      const bytes = new TextEncoder().encode(String(raw));
      if (bytes.length > MAX_BYTES) {
        return { success: false, action_type: "write_file", error: "content exceeds the 2MB write_file limit" };
      }
      b64 = bytesToB64(bytes);
    }

    const mime = guessMimeType(base);
    const downloadId = await chrome.downloads.download({
      url: `data:${mime};base64,${b64}`,
      filename: `navy/${base}`,
      conflictAction: "uniquify",
      saveAs: false,
    });
    const item = await waitForDownloadComplete(downloadId, 15000);
    return {
      success: true, action_type: "write_file", page_changed: false,
      filename: item.filename, bytes: item.fileSize, mime,
      message: `File written to ${item.filename}. To upload it into a file input: ` +
               `{"type":"file_upload","som_id":<input_som_id>,"path":${JSON.stringify(item.filename)}}`,
    };
  } catch (e) {
    return { success: false, action_type: "write_file", error: String(e.message || e) };
  }
}

// actDownloadFile — downloads a file by URL via the downloads API, so the model
// doesn't have to hunt for a page button when it already knows the file URL.
async function actDownloadFile(a) {
  try {
    if (!a.url) return { success: false, action_type: "download", error: "download requires a url" };
    const options = { url: a.url, conflictAction: "uniquify", saveAs: false };
    const base = a.filename ? sanitizeWriteFilename(a.filename) : null;
    if (base) options.filename = `navy/${base}`;
    const downloadId = await chrome.downloads.download(options);
    const item = await waitForDownloadComplete(downloadId, 60000);
    return {
      success: true, action_type: "download", page_changed: false,
      filename: item.filename, mime: item.mime, bytes: item.fileSize,
      message: `Downloaded to ${item.filename}. Use read_download to read its contents.`,
    };
  } catch (e) {
    return { success: false, action_type: "download", error: String(e.message || e) };
  }
}

// actReadDownload — finds the most recent matching download and reads it
// Opens the file URL in a temporary tab, extracts text, then closes the tab.
// ---------------------------------------------------------------------------
async function actReadDownload(tabId, a) {
  const filename = a.filename || null;
  const maxChars = Math.min(a.max_chars || 8000, 32000);

  try {
    const query = { limit: 20, state: "complete", orderBy: ["-startTime"] };
    if (filename) query.filename = filename;
    const downloads = await chrome.downloads.search(query);

    if (!downloads.length) {
      return { success: false, action_type: "read_download", error: filename ? `No completed download matching '${filename}'` : "No completed downloads found" };
    }

    // Pick the most recent match — chrome.downloads returns absolute file paths
    const dl = downloads[0];
    const fileUrl = "file:///" + dl.filename.replace(/\\/g, "/").replace(/^\//, "");
    const baseName = dl.filename.split(/[/\\]/).pop();

    const isImage = /^image\//i.test(dl.mime || "") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(dl.filename);

    // Open the file in a background tab. A file:// TAB (with "Allow access to file
    // URLs") can read its own content via CDP; the service worker cannot fetch
    // file:// URLs at all — so both text and image reads go through the tab.
    STATE.programmaticTabs = STATE.programmaticTabs || new Set();
    STATE.programmaticTabCreating++;
    let newTab;
    try {
      newTab = await chrome.tabs.create({ url: fileUrl, active: false });
    } finally {
      STATE.programmaticTabCreating = Math.max(0, STATE.programmaticTabCreating - 1);
    }
    STATE.programmaticTabs.add(newTab.id);

    // Run an expression in the file tab, temporarily attaching the debugger if the
    // shared CDP session isn't connected to this side tab. Single definition used
    // by both the text and image paths.
    const evalInTab = async (expression) => {
      try {
        const { result } = await sendCDP(newTab.id, "Runtime.evaluate", { expression, returnByValue: true });
        return result?.value;
      } catch (_) {
        await chrome.debugger.attach({ tabId: newTab.id }, "1.3");
        try {
          const { result } = await sendCDP(newTab.id, "Runtime.evaluate", { expression, returnByValue: true });
          return result?.value;
        } finally {
          await chrome.debugger.detach({ tabId: newTab.id }).catch(() => {});
        }
      }
    };

    try {
      // Inside the try so a load failure still closes the temporary tab (the catch
      // below removes it) — otherwise a failed file load leaks a visible file:// tab.
      await waitForLoad(newTab.id);
      if (isImage) {
        // Draw the rendered image into a same-origin canvas and export a bounded
        // JPEG. Runs in the file:// page context, so the canvas is not tainted and
        // toDataURL succeeds. Queued into the next snapshot's image set (the same
        // one-shot channel zoom_canvas uses) so the vision model reads it directly.
        const dataUrl = await evalInTab(`(function(maxDim){
          var img = document.querySelector('img');
          if (!img || !img.naturalWidth) return null;
          var w = img.naturalWidth, h = img.naturalHeight;
          var s = Math.min(1, maxDim / Math.max(w, h));
          var cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
          var c = document.createElement('canvas'); c.width = cw; c.height = ch;
          var ctx = c.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cw, ch);
          ctx.drawImage(img, 0, 0, cw, ch);
          try { return c.toDataURL('image/jpeg', 0.85); } catch (e) { return 'ERR:' + e.message; }
        })(1400)`);
        await chrome.tabs.remove(newTab.id).catch(() => {});
        if (typeof dataUrl === "string" && dataUrl.startsWith("data:image/")) {
          const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
          STATE.pendingCanvasZoom = { b64, cx: 0, cy: 0, note: `downloaded_image:${baseName}` };
          return {
            success: true, action_type: "read_download", page_changed: false,
            filename: dl.filename, mime: dl.mime, is_image: true, text: "",
            message: `Image "${baseName}" attached — it appears in the NEXT step's screenshot set. Look at it there to answer questions about it.`,
          };
        }
        return {
          success: false, action_type: "read_download",
          error: `cannot read downloaded image "${baseName}"` +
                 (typeof dataUrl === "string" && dataUrl.startsWith("ERR:") ? ` (${dataUrl.slice(4)})` : "") +
                 `. If this is an access error, enable "Allow access to file URLs" for Navy in chrome://extensions.`,
        };
      }

      const text = (await evalInTab(
        `(document.body ? document.body.innerText : document.documentElement.textContent || "").substring(0, ${maxChars})`
      )) || "";
      await chrome.tabs.remove(newTab.id).catch(() => {});
      return {
        success: true, action_type: "read_download", page_changed: false,
        filename: dl.filename, mime: dl.mime, text,
        char_count: text.length,
      };
    } catch (e) {
      await chrome.tabs.remove(newTab.id).catch(() => {});
      return { success: false, action_type: "read_download", error: e.message };
    }
  } catch (e) {
    return { success: false, action_type: "read_download", error: e.message };
  }
}

// ---------------------------------------------------------------------------
// actRepeat — execute a list of sub-actions N times or until a text/selector
// condition is met. Stops early if any sub-action fails.
// ---------------------------------------------------------------------------
async function actRepeat(tabId, a) {
  const actions = a.actions;
  if (!Array.isArray(actions) || !actions.length) {
    return { success: false, action_type: "repeat", error: "repeat requires a non-empty 'actions' array" };
  }
  const times = Math.min(Math.max(a.times || 1, 1), 200);
  const untilText = a.until_text || null;
  const untilSelector = a.until_selector || null;

  const allResults = [];
  STATE.batchDepth++;
  try {
    for (let i = 0; i < times; i++) {
      // Check stopping condition before each iteration
      if (untilText || untilSelector) {
        try {
          const { result } = await sendCDP(STATE.attachedTabId || tabId, "Runtime.evaluate", {
            expression: `(function(sel,txt){
              if(sel){var el=document.querySelector(sel);if(el){var r=el.getBoundingClientRect();var s=window.getComputedStyle(el);if(r.width>0&&r.height>0&&s.display!=='none')return true;}}
              if(txt){return (document.body?document.body.innerText:'').includes(txt);}
              return false;
            })(${JSON.stringify(untilSelector)},${JSON.stringify(untilText)})`,
            returnByValue: true,
          });
          if (result?.value === true) {
            return { success: true, action_type: "repeat", iterations_completed: i, stopped_by: untilText || untilSelector, results: allResults };
          }
        } catch (_) {}
      }

      for (const sub of actions) {
        const currentTabId = STATE.attachedTabId || tabId;
        const result = await executeStep(currentTabId, { action: sub });
        allResults.push({ iteration: i + 1, action: sub.type, success: result.success });
        if (!result.success) {
          return { success: false, action_type: "repeat", iterations_completed: i, error: `Iteration ${i+1} failed on '${sub.type}': ${result.error}`, results: allResults };
        }
        await sleep(80);
      }
    }
  } finally {
    STATE.batchDepth = Math.max(0, STATE.batchDepth - 1);
  }

  return { success: true, action_type: "repeat", iterations_completed: times, results: allResults };
}

// ---------------------------------------------------------------------------
// actTool — MCP (Model Context Protocol) tool call
// Forwards {"type":"tool","name":"xxx","args":{...}} to the configured MCP server.
// ---------------------------------------------------------------------------
async function actTool(tabId, a) {
  const toolName = a.name;
  const toolArgs = a.args || {};
  if (!toolName) return { success: false, action_type: "tool", error: "tool requires 'name'" };

  try {
    const cfg = await new Promise(r => chrome.storage.local.get(["mcpServerUrl", "apiKey"], r));
    const mcpUrl = (cfg.mcpServerUrl || "").trim();
    if (!mcpUrl) {
      return { success: false, action_type: "tool", error: "No MCP server URL configured. Add one in Settings → MCP Server URL." };
    }
    if (!mcpUrl.startsWith("http://") && !mcpUrl.startsWith("https://")) {
      return { success: false, action_type: "tool", error: "MCP server URL must start with http:// or https://" };
    }

    const body = JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: toolName, arguments: toolArgs } });
    const headers = { "Content-Type": "application/json" };
    // SECURITY: cfg.apiKey is the LLM provider key (OpenAI/Anthropic/...). Only send
    // it as MCP auth when the server is on the user's own machine (loopback). Never
    // transmit that high-value secret to a remote/third-party MCP endpoint.
    let mcpIsLoopback = false;
    try {
      const h = new URL(mcpUrl).hostname.toLowerCase();
      mcpIsLoopback = h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
    } catch (_) {}
    if (cfg.apiKey && mcpIsLoopback) headers["Authorization"] = `Bearer ${cfg.apiKey}`;

    const resp = await fetch(`${mcpUrl.replace(/\/$/, "")}/mcp`, {
      method: "POST", headers, body, credentials: "omit",
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      return { success: false, action_type: "tool", error: `MCP server error ${resp.status}: ${txt.substring(0, 300)}` };
    }
    const data = await resp.json();
    if (data.error) {
      return { success: false, action_type: "tool", error: `Tool error: ${data.error.message || JSON.stringify(data.error)}` };
    }
    const content = data.result?.content;
    const text = Array.isArray(content)
      ? content.filter(c => c.type === "text").map(c => c.text).join("\n")
      : JSON.stringify(data.result);
    return { success: true, action_type: "tool", page_changed: false, result: text.substring(0, 4000) };
  } catch (e) {
    return { success: false, action_type: "tool", error: e.message };
  }
}

async function actWait(tabId, a) {
  const htmlLenBefore = await getDOMLength(tabId).catch(() => 0);
  await sleep(Math.min(a.seconds * 1000, 30000));
  const htmlLenAfter = await getDOMLength(tabId).catch(() => 0);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return { 
    success: true, 
    action_type: "wait", 
    url: tab ? tab.url : null, 
    title: tab ? tab.title : null, 
    page_changed: htmlLenBefore !== htmlLenAfter 
  };
}

// -- Browser chrome API actions -----------------------------------------------

async function actBookmark(action) {
  const op = action.op || "search";
  try {
    if (op === "add") {
      const node = await chrome.bookmarks.create({ title: action.title || "", url: action.url });
      return { success: true, action_type: "bookmark", op: "add", id: node.id, title: node.title, url: node.url };
    }
    if (op === "remove") {
      if (!action.id) return { success: false, action_type: "bookmark", error: "remove requires id" };
      await chrome.bookmarks.remove(action.id);
      return { success: true, action_type: "bookmark", op: "remove" };
    }
    // Default: search
    const query = action.query || "";
    const results = await chrome.bookmarks.search(query ? { query } : {});
    const items = results.slice(0, 20).map(b => ({ id: b.id, title: b.title, url: b.url }));
    return { success: true, action_type: "bookmark", op: "search", results: items };
  } catch (e) {
    return { success: false, action_type: "bookmark", error: e.message };
  }
}

async function actHistorySearch(action) {
  try {
    const text = action.query || "";
    const maxResults = Math.min(action.max_results || 20, 50);
    const startTime = action.days_back ? Date.now() - action.days_back * 86400000 : 0;
    const items = await chrome.history.search({ text, maxResults, startTime });
    const results = items.map(h => ({ title: h.title, url: h.url, visit_count: h.visitCount }));
    return { success: true, action_type: "history_search", results };
  } catch (e) {
    return { success: false, action_type: "history_search", error: e.message };
  }
}

async function actDownloadsList(action) {
  try {
    const query = {};
    if (action.query) query.filenameContains = action.query;
    if (action.limit) query.limit = Math.min(action.limit, 50);
    else query.limit = 20;
    if (action.state) query.state = action.state; // "complete" | "in_progress" | "interrupted"
    const items = await chrome.downloads.search(query);
    const results = items.map(d => ({
      id: d.id,
      filename: (d.filename || "").split(/[/\\]/).pop(),
      url: d.url,
      state: d.state,
      bytes: d.fileSize,
      mime: d.mime,
    }));
    return { success: true, action_type: "downloads_list", results };
  } catch (e) {
    return { success: false, action_type: "downloads_list", error: e.message };
  }
}


// Install a lightweight MutationObserver in the page that flags the element map as dirty.
// This invalidates the snapshot cache when the DOM mutates, even if URL/title/viewport look the same.
function _installMutationObserverPage() {
  (function(){
    if (window.__navy_mutation_observer) return;
    var marker = function() {
      try {
        window.__navy_element_map_dirty = true;
        window.__navy_last_mutation = Date.now();
      } catch(_) {}
    };
    var obs = new MutationObserver(function(mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (m.type === 'childList' && (m.addedNodes.length > 0 || m.removedNodes.length > 0)) {
          marker();
          return;
        }
        if (m.type === 'attributes' && m.attributeName !== 'style') {
          marker();
          return;
        }
      }
    });
    obs.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class','id','role','aria-label','placeholder','href','src','value'] });
    window.__navy_mutation_observer = obs;
  })();
}

async function installMutationObserver(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: _installMutationObserverPage });
  } catch (_) {}
}

// -- Debugger / CDP helpers ---------------------------------------------------

async function attachDebugger(tabId) {
  let preWin = null;
  let preH = 0;
  // Height probe is only needed the first time compensation is applied --
  // skipping it saves two executeScript round-trips on every reattach.
  if (STATE.infobarCompensationApplied === 0) {
    try {
      const tab = await chrome.tabs.get(tabId);
      preWin = await chrome.windows.get(tab.windowId);
      const res = await chrome.scripting.executeScript({ target: { tabId }, func: () => window.innerHeight });
      preH = res[0].result;
    } catch (_) {}
  }

  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve();
    });
  });

  if (preWin && preWin.state === "normal" && preH > 0 && STATE.infobarCompensationApplied === 0) {
    try {
      const res2 = await chrome.scripting.executeScript({ target: { tabId }, func: () => window.innerHeight });
      const postH = res2[0].result;
      const diff = preH - postH;
      if (diff > 0 && diff < 100) {
        await chrome.windows.update(preWin.id, { height: preWin.height + diff });
        STATE.infobarCompensationApplied = diff;
        STATE.compensatedWindowId = preWin.id;
      }
    } catch (_) {}
  }

  STATE.childSessions.clear();
  await Promise.all([
    sendCDP(tabId, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }),
    sendCDP(tabId, "DOM.enable", {}),
    sendCDP(tabId, "Accessibility.enable", {}),
    sendCDP(tabId, "Page.enable", {}),
    sendCDP(tabId, "Network.enable", {}),
  ]);
  installMutationObserver(tabId).catch(() => {});
  // Immediately show the agent cursor upon attachment (if already set)
  if (STATE.lastX !== null && STATE.lastX !== undefined) {
    showAgentCursor(tabId, STATE.lastX, STATE.lastY).catch(() => {});
  }
}

async function detachDebugger() {
  // Capture once — STATE.attachedTabId can be changed by a concurrent attach
  // (watchdog reconnect, tab switch) while the awaits below are in flight.
  const tabId = STATE.attachedTabId;
  if (tabId == null) return;
  // Remove the agent cursor from the page before detaching — otherwise it stays
  // stuck on screen permanently since CDP is no longer available after detach.
  // Bounded: a hung renderer must never wedge the detach itself.
  try {
    await withTimeout(sendCDP(tabId, "Runtime.evaluate", {
      expression: "(function(){['__lba_cur','__lba_shield'].forEach(function(id){var e=document.getElementById(id);if(e)e.remove();});})()",
    }), 1500, "cursor cleanup");
  } catch (_) {}
  await new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      // Access lastError to silence Chrome's "Unchecked runtime.lastError" warning
      // in case the debugger is already detached (e.g., tab closed)
      const _ = chrome.runtime.lastError;
      // Only clear if no concurrent attach installed a different tab meanwhile
      if (STATE.attachedTabId === tabId) STATE.attachedTabId = null;
      resolve();
    });
  });
  // Revert the infobar height compensation. Promise-form APIs only — the old
  // callback+.catch mix threw a TypeError inside the detach callback, which left
  // this promise permanently unresolved and hung every awaited detach.
  if (STATE.infobarCompensationApplied > 0 && STATE.compensatedWindowId) {
    const applied = STATE.infobarCompensationApplied;
    const winId = STATE.compensatedWindowId;
    STATE.infobarCompensationApplied = 0;
    STATE.compensatedWindowId = null;
    try {
      const win = await chrome.windows.get(winId);
      if (win && win.state === "normal") {
        await chrome.windows.update(winId, { height: win.height - applied });
      }
    } catch (_) {}
  }
}

function sendCDP(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(result);
    });
  });
}

let sessionMessageId = 1;
const pendingSessionMessages = new Map();

function sendSessionCDP(tabId, sessionId, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = sessionMessageId++;
    pendingSessionMessages.set(id, { resolve, reject, sessionId });
    const message = JSON.stringify({ id, method, params });
    sendCDP(tabId, "Target.sendMessageToTarget", { message, sessionId }).catch(reject);
  });
}

async function resolveNodeAnywhere(tabId, backendNodeId) {
  try {
    const res = await sendCDP(tabId, "DOM.resolveNode", { backendNodeId });
    return { object: res.object, sessionId: null };
  } catch (e) {
    for (const [sessionId, targetId] of STATE.childSessions.entries()) {
      try {
        const res = await sendSessionCDP(tabId, sessionId, "DOM.resolveNode", { backendNodeId });
        return { object: res.object, sessionId, targetId };
      } catch (_) {}
    }
    throw e;
  }
}

function sendRoutedCDP(tabId, sessionId, method, params) {
  if (sessionId) return sendSessionCDP(tabId, sessionId, method, params);
  return sendCDP(tabId, method, params);
}

async function getBoxModelAnywhere(tabId, backendNodeId) {
  const { object, sessionId, targetId } = await resolveNodeAnywhere(tabId, backendNodeId);
  const { model } = await sendRoutedCDP(tabId, sessionId, "DOM.getBoxModel", { objectId: object.objectId });
  if (sessionId) {
    try {
      const owner = await sendCDP(tabId, "DOM.getFrameOwner", { frameId: targetId });
      const box = await sendCDP(tabId, "DOM.getBoxModel", { backendNodeId: owner.backendNodeId });
      const dx = box.model.content[0], dy = box.model.content[1];
      model.content[0] += dx; model.content[2] += dx; model.content[4] += dx; model.content[6] += dx;
      model.content[1] += dy; model.content[3] += dy; model.content[5] += dy; model.content[7] += dy;
    } catch (_) {}
  }
  return { object, model, sessionId, targetId };
}

async function synthClick(tabId, x, y) {
  const ix = Math.round(x);
  const iy = Math.round(y);
  // Pure CDP — Chrome 116+ auto-generates PointerEvents from mouse events.
  // JS injection was removed because it double-fired events, breaking apps
  // that use setPointerCapture (they saw two pointerdowns and got confused).
  await sendCDP(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: ix, y: iy, button: "none", buttons: 0 });
  await sleep(30);
  await sendCDP(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: ix, y: iy, button: "left", buttons: 1, clickCount: 1 });
  await sleep(30);
  await sendCDP(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: ix, y: iy, button: "left", buttons: 0, clickCount: 1 });
}

async function synthDoubleClick(tabId, x, y) {
  const ix = Math.round(x);
  const iy = Math.round(y);
  // Move to coordinates first to trigger mouseover/mouseenter/pointerover
  await sendCDP(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved", x: ix, y: iy, button: "none", buttons: 0,
  });
  await sleep(50);
  // First click
  await sendCDP(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x: ix, y: iy, button: "left", buttons: 1, clickCount: 1,
  });
  await sendCDP(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x: ix, y: iy, button: "left", buttons: 0, clickCount: 1,
  });
  await sleep(60);
  // Second click (clickCount:2 triggers dblclick event)
  await sendCDP(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x: ix, y: iy, button: "left", buttons: 1, clickCount: 2,
  });
  await sendCDP(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x: ix, y: iy, button: "left", buttons: 0, clickCount: 2,
  });
}

async function synthRightClick(tabId, x, y) {
  const ix = Math.round(x);
  const iy = Math.round(y);
  await sendCDP(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: ix, y: iy, button: "none", buttons: 0 });
  await sleep(30);
  await sendCDP(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: ix, y: iy, button: "right", buttons: 2, clickCount: 1 });
  await sleep(30);
  await sendCDP(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: ix, y: iy, button: "right", buttons: 0, clickCount: 1 });
}

// -- Multi-strategy drag system -----------------------------------------------
// Web apps use 3 different drag APIs. We detect which one the page uses and try
// strategies in order of likelihood until one produces a DOM change.
//
// Strategy 1: HTML5 DragEvent (dragstart/dragover/drop with DataTransfer)
//             Used by: Trello, Jira, Google Drive, react-beautiful-dnd, sortablejs
// Strategy 2: Pointer Events (pointerdown/pointermove/pointerup with setPointerCapture)
//             Used by: Chessground/lichess, Figma, dnd-kit, modern game boards
// Strategy 3: CDP mouse events (mousePressed/mouseMoved/mouseReleased)
//             Used by: jQuery UI Draggable, custom mouse-based implementations
//
// Each strategy checks for DOM changes after execution. If no change is detected,
// it cleans up state (Escape key to cancel any half-started drag) before trying
// the next strategy.

/**
 * Detect which drag API the source element uses.
 * Returns { draggable, hasPointerListeners, hasDragListeners, hasMouseListeners, tagName }
 */
async function detectDragAPI(tabId, x, y) {
  try {
    const { result } = await sendCDP(tabId, "Runtime.evaluate", {
      expression: `(function(x, y) {
        var el = document.elementFromPoint(x, y);
        if (!el) return { found: false };
        // Walk up to find the actual draggable element
        var drag = el.closest('[draggable="true"]');
        var result = {
          found: true,
          tag: el.tagName,
          draggable: !!drag,
          // Check for pointer/mouse/drag event listeners via getEventListeners (if available)
          // Fall back to attribute-based detection
          hasDragListeners: !!drag || el.hasAttribute('ondragstart') || !!el.closest('[ondragstart]'),
          hasPointerListeners: el.hasAttribute('onpointerdown') || !!el.closest('[onpointerdown]'),
          hasMouseListeners: el.hasAttribute('onmousedown') || !!el.closest('[onmousedown]'),
          isCanvas: el.tagName === 'CANVAS' || el.tagName === 'canvas',
          // Check for common framework data attributes
          hasDndKit: !!el.closest('[data-dnd-draggable]') || !!el.closest('[role="button"][tabindex]'),
          hasReactDnd: !!el.closest('[data-rbd-draggable-id]') || !!el.closest('[data-react-beautiful-dnd-draggable]'),
          hasSortable: !!el.closest('[data-sortable]') || !!el.closest('.sortable-drag') || !!el.closest('.ui-sortable-handle'),
          // CSS touch-action: none is a strong signal for pointer-based drag
          touchAction: window.getComputedStyle(el).touchAction || '',
          cursor: window.getComputedStyle(el).cursor || '',
        };
        return result;
      })(${Math.round(x)}, ${Math.round(y)})`,
      returnByValue: true,
    });
    return result?.value || { found: false };
  } catch (_) {
    return { found: false };
  }
}

/**
 * Strategy 1: HTML5 DragEvent injection via JavaScript.
 * Dispatches dragstart → dragenter → dragover → drop → dragend with DataTransfer.
 * Works for elements with draggable="true" and HTML5 DnD API listeners.
 */
async function synthDragHTML5(tabId, sx, sy, dx, dy) {
  const { result } = await sendCDP(tabId, "Runtime.evaluate", {
    expression: `(function(sx, sy, dx, dy) {
      try {
        var srcEl = document.elementFromPoint(sx, sy);
        var dstEl = document.elementFromPoint(dx, dy);
        if (!srcEl || !dstEl) return { ok: false, err: 'no element at coordinates' };
        if (srcEl.tagName === 'IFRAME') return { ok: false, err: 'cross-origin iframe detected' };

        // Find the actual draggable ancestor
        var dragEl = srcEl.closest('[draggable="true"]') || srcEl;

        // Create a DataTransfer with text data
        var dt = new DataTransfer();
        dt.effectAllowed = 'all';
        try { dt.setData('text/plain', dragEl.textContent || ''); } catch(e) {}

        // Helper to create and dispatch a DragEvent
        function fire(el, type, cx, cy, transfer) {
          var evt = new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: cx,
            clientY: cy,
            screenX: cx,
            screenY: cy,
            buttons: 1
          });
          Object.defineProperty(evt, 'dataTransfer', {
            value: transfer,
            writable: false,
            enumerable: true,
            configurable: true
          });
          return el.dispatchEvent(evt);
        }

        // Full HTML5 DnD sequence
        fire(dragEl, 'dragstart', sx, sy, dt);

        // Intermediate moves to simulate realistic drag path
        var steps = 5;
        for (var i = 1; i <= steps; i++) {
          var ix = Math.round(sx + (dx - sx) * i / steps);
          var iy = Math.round(sy + (dy - sy) * i / steps);
          var midEl = document.elementFromPoint(ix, iy) || dstEl;
          fire(midEl, 'dragover', ix, iy, dt);
        }

        // Final enter + over + drop at destination
        fire(dstEl, 'dragenter', dx, dy, dt);
        fire(dstEl, 'dragover', dx, dy, dt);
        fire(dstEl, 'drop', dx, dy, dt);
        fire(dragEl, 'dragend', dx, dy, dt);

        return { ok: true, method: 'html5_dnd' };
      } catch(e) {
        return { ok: false, err: e.message };
      }
    })(${Math.round(sx)}, ${Math.round(sy)}, ${Math.round(dx)}, ${Math.round(dy)})`,
    returnByValue: true,
  });
  return result?.value?.ok || false;
}

/**
 * Strategy 2: Pointer Events via JavaScript injection with manual setPointerCapture.
 * Dispatches pointerdown → pointermove (with capture) → pointerup.
 * Works for frameworks like Chessground, dnd-kit that use pointer events.
 */
async function synthDragPointer(tabId, sx, sy, dx, dy) {
  const { result } = await sendCDP(tabId, "Runtime.evaluate", {
    expression: `(function(sx, sy, dx, dy) {
      try {
        var srcEl = document.elementFromPoint(sx, sy);
        if (!srcEl) return { ok: false, err: 'no source element' };
        if (srcEl.tagName === 'IFRAME') return { ok: false, err: 'cross-origin iframe detected' };

        // Helper to create and dispatch PointerEvent
        function firePtr(el, type, cx, cy, buttons, pressure) {
          var evt = new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: cx,
            clientY: cy,
            screenX: cx,
            screenY: cy,
            button: buttons > 0 ? 0 : -1,
            buttons: buttons,
            pointerId: 1,
            pointerType: 'mouse',
            isPrimary: true,
            pressure: pressure || 0,
            width: 1,
            height: 1,
          });
          return el.dispatchEvent(evt);
        }

        // Also fire corresponding mouse events for frameworks that listen to both
        function fireMouse(el, type, cx, cy, buttons) {
          var evt = new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: cx,
            clientY: cy,
            screenX: cx,
            screenY: cy,
            button: buttons > 0 ? 0 : -1,
            buttons: buttons,
          });
          el.dispatchEvent(evt);
        }

        // 1. Approach: pointerover + pointerenter + mouseover + mouseenter
        firePtr(srcEl, 'pointerover', sx, sy, 0, 0);
        firePtr(srcEl, 'pointerenter', sx, sy, 0, 0);
        fireMouse(srcEl, 'mouseover', sx, sy, 0);
        fireMouse(srcEl, 'mouseenter', sx, sy, 0);

        // 2. Press: pointerdown + mousedown
        firePtr(srcEl, 'pointerdown', sx, sy, 1, 0.5);
        fireMouse(srcEl, 'mousedown', sx, sy, 1);

        // 3. Set pointer capture on the source element (critical for pointer-based drag)
        try { srcEl.setPointerCapture(1); } catch(e) { /* some elements don't support it */ }

        // 4. Small jitter to cross drag threshold
        var ox = dx !== sx ? (dx > sx ? 4 : -4) : 0;
        var oy = dy !== sy ? (dy > sy ? 4 : -4) : 4;
        firePtr(srcEl, 'pointermove', sx + ox, sy + oy, 1, 0.5);
        fireMouse(srcEl, 'mousemove', sx + ox, sy + oy, 1);

        // 5. Interpolated path — dynamically query if pointer capture is active
        var steps = 15;
        var lastEl = srcEl;
        for (var i = 1; i <= steps; i++) {
          var ix = Math.round(sx + (dx - sx) * i / steps);
          var iy = Math.round(sy + (dy - sy) * i / steps);
          var currEl = document.elementFromPoint(ix, iy) || lastEl;
          var hasCapture = false;
          try { hasCapture = typeof srcEl.hasPointerCapture === 'function' && srcEl.hasPointerCapture(1); } catch(e){}
          var target = hasCapture ? srcEl : currEl;
          firePtr(target, 'pointermove', ix, iy, 1, 0.5);
          fireMouse(target, 'mousemove', ix, iy, 1);
          lastEl = currEl;
        }

        // 6. Final position
        firePtr(srcEl, 'pointermove', dx, dy, 1, 0.5);
        fireMouse(srcEl, 'mousemove', dx, dy, 1);

        // 7. Release pointer capture and fire up events
        try { srcEl.releasePointerCapture(1); } catch(e) {}
        firePtr(srcEl, 'pointerup', dx, dy, 0, 0);
        fireMouse(srcEl, 'mouseup', dx, dy, 0);

        // 8. Also fire events on the destination element (for drop-target frameworks)
        var dstEl = document.elementFromPoint(dx, dy);
        if (dstEl && dstEl !== srcEl) {
          firePtr(dstEl, 'pointerover', dx, dy, 0, 0);
          firePtr(dstEl, 'pointerenter', dx, dy, 0, 0);
          fireMouse(dstEl, 'mouseover', dx, dy, 0);
          fireMouse(dstEl, 'mouseenter', dx, dy, 0);
          // Some frameworks trigger drop on click at destination
          firePtr(dstEl, 'pointerdown', dx, dy, 1, 0.5);
          firePtr(dstEl, 'pointerup', dx, dy, 0, 0);
          fireMouse(dstEl, 'mousedown', dx, dy, 1);
          fireMouse(dstEl, 'mouseup', dx, dy, 0);
        }

        return { ok: true, method: 'pointer_capture' };
      } catch(e) {
        return { ok: false, err: e.message };
      }
    })(${Math.round(sx)}, ${Math.round(sy)}, ${Math.round(dx)}, ${Math.round(dy)})`,
    returnByValue: true,
    awaitPromise: false,
  });
  return result?.value?.ok || false;
}

/**
 * Strategy 3: CDP mouse events (the original approach).
 * Chrome 116+ auto-generates PointerEvents from these.
 * Works for apps using raw mouse event listeners.
 */
async function synthDragCDP(tabId, sx, sy, dx, dy) {
  const isx = Math.round(sx);
  const isy = Math.round(sy);
  const idx = Math.round(dx);
  const idy = Math.round(dy);

  // 1. Approach source
  await sendCDP(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: isx, y: isy, button: "none", buttons: 0 });
  await sleep(60);

  // 2. Press
  await sendCDP(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: isx, y: isy, button: "left", buttons: 1, clickCount: 1 });
  await sleep(100);

  // 3. Jitter to cross drag threshold
  const ox = idx !== isx ? (idx > isx ? 4 : -4) : 0;
  const oy = idy !== isy ? (idy > isy ? 4 : -4) : 4;
  await sendCDP(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: isx + ox, y: isy + oy, button: "none", buttons: 1 });
  await sleep(50);

  // 4. Smooth interpolated path
  const steps = 20;
  for (let i = 1; i <= steps; i++) {
    const ix = Math.round(isx + (idx - isx) * i / steps);
    const iy = Math.round(isy + (idy - isy) * i / steps);
    await sendCDP(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: ix, y: iy, button: "none", buttons: 1 });
    await sleep(16);
  }
  await sleep(80);

  // 5. Settle at destination
  await sendCDP(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: idx, y: idy, button: "none", buttons: 1 });
  await sleep(100);

  // 6. Release
  await sendCDP(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: idx, y: idy, button: "left", buttons: 0, clickCount: 1 });
}

/**
 * Reset local pointer state of the element by firing pointercancel and releasing capture.
 * Called between strategy attempts to avoid corrupting global selection state with Escape.
 */
async function resetPointerState(tabId, x, y) {
  try {
    await sendCDP(tabId, "Runtime.evaluate", {
      expression: `(function(x, y) {
        var el = document.elementFromPoint(x, y);
        if (el) {
          el.dispatchEvent(new PointerEvent('pointercancel', {
            bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true
          }));
          try { el.releasePointerCapture(1); } catch(e) {}
        }
      })(${Math.round(x)}, ${Math.round(y)})`,
    });
    await sleep(50);
  } catch (_) {}
}

/**
 * Cancel any half-started drag state globally by pressing Escape and resetting pointer state.
 * Called before click-to-move fallback to reset global UI state.
 */
async function cancelDragState(tabId, x, y) {
  try {
    // Press Escape to cancel any HTML5 drag or framework drag in progress
    await sendCDP(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await sendCDP(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await resetPointerState(tabId, x, y);
    await sleep(100);
  } catch (_) {}
}

/**
 * Multi-strategy drag orchestrator.
 * Detects the page's drag API and tries strategies in order:
 * 1. If element has draggable="true" or DnD data attrs → HTML5 DragEvent first
 * 2. If pointer-based signals (touch-action:none, canvas, game-like) → Pointer Events first
 * 3. CDP mouse events as general fallback
 * Returns { moved: boolean, method: string }
 */
async function synthDrag(tabId, sx, sy, dx, dy) {
  const api = await detectDragAPI(tabId, sx, sy);

  // Determine strategy order based on detection
  let strategies;
  if (api.draggable || api.hasDragListeners || api.hasReactDnd || api.hasSortable) {
    // HTML5 DnD signals detected → try HTML5 first
    strategies = [
      { name: "html5_dnd", fn: () => synthDragHTML5(tabId, sx, sy, dx, dy) },
      { name: "cdp_mouse", fn: () => synthDragCDP(tabId, sx, sy, dx, dy) },
      { name: "pointer_capture", fn: () => synthDragPointer(tabId, sx, sy, dx, dy) },
    ];
  } else if (api.isCanvas || api.touchAction === "none" || api.hasDndKit ||
             api.hasPointerListeners || (api.cursor === "grab" || api.cursor === "pointer")) {
    // Pointer-based signals → try pointer events first, then CDP
    strategies = [
      { name: "cdp_mouse", fn: () => synthDragCDP(tabId, sx, sy, dx, dy) },
      { name: "pointer_capture", fn: () => synthDragPointer(tabId, sx, sy, dx, dy) },
      { name: "html5_dnd", fn: () => synthDragHTML5(tabId, sx, sy, dx, dy) },
    ];
  } else {
    // No clear signal — try CDP first (cheapest), then others
    strategies = [
      { name: "cdp_mouse", fn: () => synthDragCDP(tabId, sx, sy, dx, dy) },
      { name: "html5_dnd", fn: () => synthDragHTML5(tabId, sx, sy, dx, dy) },
      { name: "pointer_capture", fn: () => synthDragPointer(tabId, sx, sy, dx, dy) },
    ];
  }

  const fpBefore = await domFingerprint(tabId);
  let dataUrlBefore = null;
  try {
    const tabBefore = await chrome.tabs.get(tabId);
    dataUrlBefore = await captureTabForDiff(tabId, tabBefore.windowId);
  } catch (_) {}

  for (let i = 0; i < strategies.length; i++) {
    const strategy = strategies[i];
    console.log(`[drag] trying strategy ${i + 1}/${strategies.length}: ${strategy.name}`);

    try {
      await strategy.fn();
    } catch (e) {
      console.warn(`[drag] strategy ${strategy.name} threw:`, e);
      await resetPointerState(tabId, sx, sy);
      continue;
    }

    // Check if something changed
    await waitForDOMStability(tabId, 1500, 300);
    const fpAfter = await domFingerprint(tabId);
    const diff = diffFingerprints(fpBefore, fpAfter);
    let visualChanged = false;
    if (dataUrlBefore) {
      try {
        const tabAfter = await chrome.tabs.get(tabId);
        visualChanged = await detectVisualChange(tabId, tabAfter.windowId, dataUrlBefore);
      } catch (_) {}
    }

    if (diff.anyChange || visualChanged) {
      console.log(`[drag] strategy ${strategy.name} produced change (DOM: ${diff.anyChange}, Visual: ${visualChanged}): ${diff.summary}`);
      return { moved: true, method: strategy.name };
    }

    // Canvas / video / iframe elements (games, VM screens, WebGL) render at high
    // FPS entirely on the GPU — they never modify the DOM and may animate too fast
    // for a screenshot diff to catch.  CDP mouse events ARE delivered correctly at
    // the OS level, so after the cdp_mouse strategy we trust it worked.
    const isCanvasLike = api.isCanvas ||
      (api.tag && ["CANVAS", "VIDEO", "IFRAME", "EMBED", "OBJECT"].includes(api.tag.toUpperCase()));
    if (isCanvasLike && strategy.name === "cdp_mouse") {
      console.log(`[drag] canvas/game element — trusting CDP mouse drag without DOM/visual confirmation`);
      return { moved: true, method: "cdp_mouse" };
    }

    // No change — clean up and try next strategy
    if (i < strategies.length - 1) {
      console.log(`[drag] strategy ${strategy.name} produced no change, cleaning up and trying next`);
      await resetPointerState(tabId, sx, sy);
      await sleep(150);
    }
  }

  console.log("[drag] all strategies exhausted with no DOM change");
  return { moved: false, method: "none" };
}

// -- Resolve a page-relative offset inside a container element ----------------
// Used when the agent supplies to_relative_to_som_id / from_relative_to_som_id /
// relative_to_som_id so the LLM never has to do coordinate arithmetic itself.
// The container's top-left in viewport pixels = center - half dimensions,
// which matches getBoundingClientRect().left / .top exactly.
async function resolveContainerOffset(tabId, containerSomId, offsetX, offsetY, actionType) {
  let el = STATE.lastElementMap[containerSomId];
  if (!el) {
    try {
      const fresh = await getInteractiveElements(tabId);
      if (fresh.length) {
        STATE.lastElementMap = {};
        for (const e of fresh) STATE.lastElementMap[e.id] = e;
        el = STATE.lastElementMap[containerSomId];
      }
    } catch (_) {}
  }
  if (!el) return { error: `relative_to_som_id ${containerSomId} not found — the SOM was re-scanned and IDs changed. Re-read the page to get the current canvas som_id, then retry.`, action_type: actionType };
  const left = el.x - el.w / 2;
  const top  = el.y - el.h / 2;
  let ox = Number(offsetX);
  let oy = Number(offsetY);
  if (el.isCanvas) {
    // Canvas offsets come from the LLM's visual estimate of the screenshot image.
    // Screenshots are downscaled (screenshotScale = outW / cssW), so visual pixel
    // offsets are in screenshot space — convert back to CSS space the same way
    // resolveCoords does for raw x,y inputs.
    const sc = STATE.screenshotScale || 1.0;
    ox = ox / sc;
    oy = oy / sc;
    // Bounds check: if the CSS offset still exceeds the canvas CSS dimensions, the LLM
    // most likely used the canvas buffer pixel size (canvas.width / canvas.height) directly
    // instead of estimating from the screenshot. Return a clear error with the correct formula.
    if (ox > el.w * 1.1 || oy > el.h * 1.1 || ox < -el.w * 0.1 || oy < -el.h * 0.1) {
      return {
        error: `Canvas offset (${Math.round(ox)}, ${Math.round(oy)}) is outside the canvas CSS bounds (${el.w}×${el.h} px). ` +
               `Do not use the canvas buffer/pixel dimensions as coordinates. ` +
               `Use visual fraction-based offsets: offset_x=round(fx×${el.w}), offset_y=round(fy×${el.h}) ` +
               `where fx,fy are 0.0–1.0 fractions of the canvas area as seen in the screenshot.`,
        action_type: actionType
      };
    }
  }
  return { x: left + ox, y: top + oy };
}

// -- Point inspection: what element is at viewport coordinates (x, y)? --------
// Used before and after drag to verify the right element was grabbed/dropped.
// Returns a compact descriptor, or null if no meaningful element is at that point.
async function inspectPoint(tabId, x, y) {
  try {
    const { result } = await sendCDP(tabId, "Runtime.evaluate", {
      expression: `(function(x,y){
        var el = document.elementFromPoint(x,y);
        if (!el || el === document.documentElement || el === document.body) return null;
        var r = el.getBoundingClientRect();
        var text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g,' ').substring(0,60);
        return {
          tag:   el.tagName,
          id:    el.id || '',
          cls:   (el.className||'').trim().split(/\\s+/).slice(0,3).join(' '),
          text:  text,
          role:  el.getAttribute('role') || '',
          label: el.getAttribute('aria-label') || el.getAttribute('title') || '',
          cx: Math.round(r.left + r.width/2),
          cy: Math.round(r.top  + r.height/2)
        };
      })(${Math.round(x)},${Math.round(y)})`,
      returnByValue: true,
    });
    return result?.value ?? null;
  } catch (_) { return null; }
}

// Compact human-readable fingerprint for an inspectPoint result.
function elementDesc(info) {
  if (!info) return '(empty)';
  const id   = info.id    ? '#' + info.id                         : '';
  const cls  = info.cls   ? '.' + info.cls.split(' ')[0]          : '';
  const role = info.role  ? `[${info.role}]`                      : '';
  const lbl  = info.label ? ` "${info.label.substring(0,30)}"`    : '';
  const txt  = (!info.label && info.text) ? ` "${info.text.substring(0,30)}"` : '';
  return `${info.tag}${id}${cls}${role}${lbl}${txt}`;
}

// Compare before/after point snapshots to produce a verification summary.
// Fully general — no assumptions about what kind of element or page this is.
function buildDragVerification(srcBefore, dstBefore, srcAfter, dstAfter) {
  const parts = [];
  let verified = false;

  if (!srcBefore) {
    parts.push(`⚠ source (${elementDesc(srcBefore)}) — no element found before drag; coordinates may be off`);
  } else {
    parts.push(`src: ${elementDesc(srcBefore)}`);
  }

  const dstChanged = elementDesc(dstBefore) !== elementDesc(dstAfter);
  const srcChanged = elementDesc(srcBefore) !== elementDesc(srcAfter);

  if (dstChanged) {
    verified = true;
    parts.push(`dest: ${elementDesc(dstBefore)} → ${elementDesc(dstAfter)}`);
  } else {
    parts.push(`dest unchanged: ${elementDesc(dstAfter)}`);
  }

  if (srcChanged) {
    verified = true;
    parts.push(`src after: ${elementDesc(srcAfter)}`);
  }

  return { drag_verified: verified, verification_note: parts.join(' | ') };
}

async function querySelectorCoords(tabId, selector) {
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel) => {
        try {
          const parts = sel.split(/\s*>>>\s*/);
          let current = document;
          let offsetLeft = 0;
          let offsetTop = 0;
          for (let i = 0; i < parts.length; i++) {
            if (!current) return null;
            const part = parts[i].trim();
            if (!part) continue;
            if (i === parts.length - 1) {
              const el = current.querySelector(part);
              if (el) {
                const r = el.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) {
                  return {
                    x: Math.round(r.left + r.width / 2 + offsetLeft),
                    y: Math.round(r.top + r.height / 2 + offsetTop)
                  };
                }
              }
            } else {
              const host = current.querySelector(part);
              if (host && host.shadowRoot) {
                current = host.shadowRoot;
              } else if (host && (host.tagName === 'IFRAME' || host.contentDocument)) {
                try {
                  const r = host.getBoundingClientRect();
                  offsetLeft += r.left;
                  offsetTop += r.top;
                  current = host.contentDocument || host.contentWindow.document;
                } catch (_) {
                  return null;
                }
              } else {
                return null;
              }
            }
          }
        } catch (_) {}
        return null;
      },
      args: [selector]
    });
    if (result && result[0] && result[0].result) {
      return result[0].result;
    }
  } catch (e) {
    console.warn("[querySelectorCoords] Query failed:", e);
  }
  return null;
}

// Fast single-element coordinate refresh via stored CSS selector.
// Re-reads the element's live getBoundingClientRect and scrolls it into view if
// it has drifted outside the visible area (scroll, SPA micro-update, animation).
// Returns {x,y} in CSS viewport pixels, or null if the element is gone from DOM.
// Much cheaper than a full 1.8s getInteractiveElements rescan (~10ms round-trip).
async function _liveCoordForEl(tabId, el) {
  if (!el || !el.selector) return null;
  try {
    const { result } = await sendCDP(tabId, "Runtime.evaluate", {
      expression: `(function(sel) {
        try {
          var parts = sel.split(/\\s*>>>\\s*/);
          var doc = document;
          var offsetLeft = 0, offsetTop = 0;
          for (var i = 0; i < parts.length - 1; i++) {
            var host = doc.querySelector(parts[i].trim());
            if (!host) return null;
            if (host.shadowRoot) { doc = host.shadowRoot; continue; }
            if (host.contentDocument) {
              var fr = host.getBoundingClientRect();
              offsetLeft += fr.left; offsetTop += fr.top;
              doc = host.contentDocument || host.contentWindow.document;
            } else return null;
          }
          var target = doc.querySelector(parts[parts.length - 1].trim());
          if (!target) return null;
          var r = target.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) return null;
          var cx = r.left + r.width  / 2 + offsetLeft;
          var cy = r.top  + r.height / 2 + offsetTop;
          var vw = window.innerWidth, vh = window.innerHeight;
          if (cx < 0 || cy < 0 || cx > vw || cy > vh) {
            target.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
            r = target.getBoundingClientRect();
            cx = r.left + r.width  / 2 + offsetLeft;
            cy = r.top  + r.height / 2 + offsetTop;
          }
          return { x: Math.round(cx), y: Math.round(cy) };
        } catch(_) { return null; }
      })(${JSON.stringify(el.selector)})`,
      returnByValue: true,
    });
    const val = result?.value;
    if (val && typeof val.x === 'number' && typeof val.y === 'number') return val;
  } catch (_) {}
  return null;
}

async function resolveSomId(tabId, somId) {
  if (somId == null) return null;

  const cachedEl = STATE.lastElementMap[somId];

  // Fast path: cache is clean and element is known.
  if (cachedEl && !STATE.elementMapDirty) {
    if (STATE.batchDepth > 0 || !cachedEl.selector) {
      // Batch: use cached coords for consistency — the batch was planned against a
      // single snapshot; mixing live+cached coords within one batch causes drift.
      // Elements without selectors (canvas-text, CDP shadow-DOM entries) always
      // use cached coords since they have no DOM node to query.
      return { x: cachedEl.x, y: cachedEl.y };
    }
    // Non-batch: refresh the live viewport position using the stored CSS selector.
    // This handles scroll drift, SPA micro-updates, and external DOM mutations that
    // happened between the snapshot and this click, without a full 1.8s rescan.
    // Also scrolls the element into view if it slid outside the visible area.
    const livePt = await _liveCoordForEl(tabId, cachedEl);
    if (livePt) return livePt;
    // Element gone from DOM — fall through to full rescan + auto-heal
  }

  // During batch execution with dirty cache: skip the rescan for the same reason
  // as the batch fast-path above.
  if (STATE.batchDepth > 0 && cachedEl) {
    return { x: cachedEl.x, y: cachedEl.y };
  }

  const cachedSelector = cachedEl ? cachedEl.selector : null;

  // Cache miss or dirty page: live re-scan for fresh coordinates.
  try {
    const fresh = await getInteractiveElements(tabId);
    if (fresh.length) {
      STATE.lastElementMap = {};
      for (const e of fresh) STATE.lastElementMap[e.id] = e;
      STATE.lastElementMapArray = fresh;
      STATE.elementMapDirty = false;
    }
  } catch (err) {
    console.warn("[resolveSomId] Live re-scan failed, falling back to cache:", err);
  }

  const el = STATE.lastElementMap[somId];
  if (el) return { x: el.x, y: el.y };

  // Fallback to auto-healing via CSS selector if available
  if (cachedSelector) {
    console.log(`[resolveSomId] SomId ${somId} not found after rescan. Attempting auto-healing: ${cachedSelector}`);
    const healedPt = await querySelectorCoords(tabId, cachedSelector);
    if (healedPt) {
      console.log(`[resolveSomId] Auto-healing SUCCEEDED: ${cachedSelector} -> (${healedPt.x}, ${healedPt.y})`);
      return healedPt;
    }
  }

  // Pixel-anchored entries (canvas-text, sprites, visual regions) have no DOM
  // selector, so a rescan — which rebuilds the map from DOM only — drops them.
  // Their coordinates come from pixels, which DOM mutations don't move: the last
  // known position is still the best available. Click it rather than failing.
  if (cachedEl && !cachedEl.selector) {
    console.log(`[resolveSomId] SomId ${somId} is pixel-anchored (${cachedEl.tag}); using last known coords after rescan.`);
    return { x: cachedEl.x, y: cachedEl.y };
  }

  return null;
}

async function ensureElementFocused(tabId, somId, ref, x, y, relativeToSomId) {
  let focusedProgrammatically = false;
  
  if (somId != null) {
    const el = STATE.lastElementMap[somId];
    if (el && el.selector) {
      try {
        const { result } = await sendCDP(tabId, "Runtime.evaluate", {
          expression: `(function(){
            function querySelectorIframe(selector) {
              var parts = selector.split(" >>> ");
              var doc = document;
              for (var i = 0; i < parts.length; i++) {
                var el = doc.querySelector(parts[i]);
                if (!el) return null;
                if (i < parts.length - 1) {
                  if (el.tagName === 'IFRAME') {
                    doc = el.contentDocument || el.contentWindow.document;
                  } else if (el.shadowRoot) {
                    doc = el.shadowRoot;
                  } else {
                    return null;
                  }
                } else {
                  return el;
                }
              }
              return null;
            }
            var target = querySelectorIframe(${JSON.stringify(el.selector)});
            if (!target) return { status: 'not_found' };
            if (document.activeElement === target) return { status: 'already_focused' };
            try {
              target.focus();
              return { status: document.activeElement === target ? 'focused' : 'failed' };
            } catch (_) {
              return { status: 'error' };
            }
          })()`,
          returnByValue: true
        });
        if (result && result.value) {
          const status = result.value.status;
          if (status === 'already_focused' || status === 'focused') {
            console.log(`[agent] Programmatic focus succeeded for som_id ${somId} (status: ${status})`);
            focusedProgrammatically = true;
          }
        }
      } catch (e) {
        console.warn("[agent] Programmatic focus via selector failed:", e);
      }
    }
  } else if (ref) {
    try {
      const { object, sessionId } = await resolveNodeAnywhere(tabId, Number(ref));
      if (object && object.objectId) {
        const { result: checkActive } = await sendRoutedCDP(tabId, sessionId, "Runtime.callFunctionOn", {
          objectId: object.objectId,
          functionDeclaration: "function() { return document.activeElement === this; }",
          returnByValue: true
        });
        if (checkActive && checkActive.value === true) {
          console.log(`[agent] Element with ref ${ref} is already focused.`);
          focusedProgrammatically = true;
        } else {
          await sendRoutedCDP(tabId, sessionId, "DOM.focus", { objectId: object.objectId });
          console.log(`[agent] Programmatic focus succeeded via DOM.focus for ref ${ref}`);
          focusedProgrammatically = true;
        }
      }
    } catch (e) {
      console.warn("[agent] Programmatic focus via ref failed:", e);
    }
  }

  if (!focusedProgrammatically) {
    let focusPt = null;
    if (somId != null) {
      focusPt = await resolveSomId(tabId, somId);
    } else if (relativeToSomId != null) {
      focusPt = await resolveContainerOffset(tabId, relativeToSomId, x, y, "focus");
    } else {
      focusPt = await resolveCoords(tabId, ref, x, y, "focus");
    }
    if (focusPt && !focusPt.error) {
      console.log(`[agent] Clicking to focus target at: (${focusPt.x}, ${focusPt.y})`);
      await glidePointer(tabId, focusPt.x, focusPt.y);
      await sleep(120);
      await synthClick(tabId, focusPt.x, focusPt.y);
      await sleep(100);
    }
  }
}

// -- Resolve a ref or fallback to raw (x, y) coords ---------------------------
async function resolveCoords(tabId, ref, x, y, actionType) {
  if (ref) {
    let object, model;
    try {
      ({ object, model } = await getBoxModelAnywhere(tabId, Number(ref)));
    } catch (e) {
      return { error: `ref ${ref} is stale or not found — page may have re-rendered. Re-read the accessibility tree.`, action_type: actionType };
    }
    const [x1, y1, x2, , , y3] = model.content;
    const rx = (x1 + x2) / 2;
    const ry = (y1 + y3) / 2;
    if (isNaN(rx) || isNaN(ry)) {
      return { error: "Failed to resolve box model coordinates", action_type: actionType };
    }
    return { x: rx, y: ry };
  }
  const nx = Number(x);
  const ny = Number(y);
  if (x == null || y == null || isNaN(nx) || isNaN(ny)) {
    return { error: `Coordinates (${x}, ${y}) are missing or invalid numbers.`, action_type: actionType };
  }
  // Convert from screenshot-space (downscaled) back to CSS pixel space
  const sc = STATE.screenshotScale || 1.0;
  return { x: nx / sc, y: ny / sc };
}

async function actDoubleClick(tabId, a) {
  const tabBefore = await chrome.tabs.get(tabId);
  const urlBefore = tabBefore.url;
  const fpBefore = await domFingerprint(tabId);
  let dataUrlBefore = null;
  try {
    dataUrlBefore = await captureTabForDiff(tabId, tabBefore.windowId);
  } catch (_) {}

  if (a.hover_before) {
    await performHoverBefore(tabId, a.hover_before);
  } else if (STATE.lastActionType === "hover" && STATE.lastHoverTarget && STATE.batchDepth === 0) {
    console.log("[agent] Reactively re-triggering previous hover to restore transient element visibility:", STATE.lastHoverTarget);
    await performHoverBefore(tabId, STATE.lastHoverTarget);
  }

  const somPt = await resolveSomId(tabId, a.som_id);
  let coords;
  if (somPt) {
    coords = somPt;
  } else if (a.relative_to_som_id != null) {
    coords = await resolveContainerOffset(tabId, a.relative_to_som_id, a.x, a.y, "double_click");
  } else {
    coords = await resolveCoords(tabId, a.ref, a.x, a.y, "double_click");
  }
  if (coords.error) return { success: false, ...coords };
  await glidePointer(tabId, coords.x, coords.y);
  await sleep(120);
  await synthDoubleClick(tabId, coords.x, coords.y);
  await waitForDOMStability(tabId, 3000, 350);
  return verifyPageChange(tabId, urlBefore, fpBefore, dataUrlBefore, "double_click", { success: true, action_type: "double_click" });
}

// Press, DWELL, release. `click` presses and releases in the same tick and `drag` runs a
// fixed ~350ms from→to gesture, so neither can express "how long the button was down" —
// and that duration is the whole input in a large class of UIs: charge-a-shot games,
// press-and-hold confirm buttons, hold-to-record, long-press context menus, hold-to-fast-
// forward. Optional to_x/to_y drag the pointer WHILE held (aim-while-charging) without
// releasing, which is different from `drag` (that one releases at the destination).
async function actHold(tabId, a) {
  const tabBefore = await chrome.tabs.get(tabId);
  const urlBefore = tabBefore.url;
  const fpBefore = await domFingerprint(tabId);
  let dataUrlBefore = null;
  try {
    dataUrlBefore = await captureTabForDiff(tabId, tabBefore.windowId);
  } catch (_) {}

  if (a.hover_before) await performHoverBefore(tabId, a.hover_before);

  const somPt = await resolveSomId(tabId, a.som_id);
  let coords;
  if (somPt) {
    coords = somPt;
  } else if (a.relative_to_som_id != null) {
    coords = await resolveContainerOffset(tabId, a.relative_to_som_id, a.x, a.y, "hold");
  } else {
    coords = await resolveCoords(tabId, a.ref, a.x, a.y, "hold");
  }
  if (coords.error) return { success: false, ...coords };

  // Clamp: below ~50ms is just a click; cap so a bad number can't wedge the agent.
  const ms = Math.max(50, Math.min(10000, Number(a.hold_ms ?? a.ms ?? 1000) || 1000));

  await glidePointer(tabId, coords.x, coords.y);
  await sleep(120);
  await sendCDP(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x: coords.x, y: coords.y, button: "left", buttons: 1, clickCount: 1,
  });

  // Optional aim-while-held: move in small steps so the page sees real mousemove
  // events with the button still down, then release wherever we ended up.
  let relX = coords.x, relY = coords.y;
  if (a.to_x != null || a.to_y != null) {
    // to_x/to_y arrive in SCREENSHOT space (what the model measured off the image) and
    // must be divided by screenshotScale to reach CSS space. `coords` is ALREADY in CSS
    // space, so an axis the model omitted must be carried over as-is — routing it back
    // through resolveCoords would scale it a second time and skew the drag sideways.
    const sc = STATE.screenshotScale || 1;
    const dstX = a.to_x != null ? Number(a.to_x) / sc : coords.x;
    const dstY = a.to_y != null ? Number(a.to_y) / sc : coords.y;
    if (isFinite(dstX) && isFinite(dstY)) {
      const STEPS = 12;
      for (let i = 1; i <= STEPS; i++) {
        const t = i / STEPS;
        await sendCDP(tabId, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: coords.x + (dstX - coords.x) * t,
          y: coords.y + (dstY - coords.y) * t,
          button: "left", buttons: 1,
        });
        await sleep(Math.max(10, ms / STEPS));
      }
      relX = dstX; relY = dstY;
    } else {
      await sleep(ms);
    }
  } else {
    await sleep(ms);
  }

  await sendCDP(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x: relX, y: relY, button: "left", buttons: 0, clickCount: 1,
  });
  await waitForDOMStability(tabId, 2000, 300);
  return verifyPageChange(tabId, urlBefore, fpBefore, dataUrlBefore, "hold", {
    success: true, action_type: "hold",
    coords_used: `hold ${ms}ms at (${Math.round(coords.x)},${Math.round(coords.y)})` +
      (relX !== coords.x || relY !== coords.y ? ` → released at (${Math.round(relX)},${Math.round(relY)})` : ""),
  });
}

async function actRightClick(tabId, a) {
  const tabBefore = await chrome.tabs.get(tabId);
  const urlBefore = tabBefore.url;
  const fpBefore = await domFingerprint(tabId);
  let dataUrlBefore = null;
  try {
    dataUrlBefore = await captureTabForDiff(tabId, tabBefore.windowId);
  } catch (_) {}

  if (a.hover_before) {
    await performHoverBefore(tabId, a.hover_before);
  } else if (STATE.lastActionType === "hover" && STATE.lastHoverTarget && STATE.batchDepth === 0) {
    console.log("[agent] Reactively re-triggering previous hover to restore transient element visibility:", STATE.lastHoverTarget);
    await performHoverBefore(tabId, STATE.lastHoverTarget);
  }

  const somPt = await resolveSomId(tabId, a.som_id);
  let coords;
  if (somPt) {
    coords = somPt;
  } else if (a.relative_to_som_id != null) {
    coords = await resolveContainerOffset(tabId, a.relative_to_som_id, a.x, a.y, "right_click");
  } else {
    coords = await resolveCoords(tabId, a.ref, a.x, a.y, "right_click");
  }
  if (coords.error) return { success: false, ...coords };
  await glidePointer(tabId, coords.x, coords.y);
  await sleep(120);
  await sendCDP(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x: coords.x, y: coords.y, button: "right", buttons: 2, clickCount: 1,
  });
  await sendCDP(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x: coords.x, y: coords.y, button: "right", buttons: 0, clickCount: 1,
  });
  await waitForDOMStability(tabId, 2000, 300);
  return verifyPageChange(tabId, urlBefore, fpBefore, dataUrlBefore, "right_click", { success: true, action_type: "right_click" });
}

async function actDrag(tabId, a) {
  const tabBefore = await chrome.tabs.get(tabId);
  const urlBefore = tabBefore.url;
  const fpBefore = await domFingerprint(tabId);
  let dataUrlBefore = null;
  try {
    dataUrlBefore = await captureTabForDiff(tabId, tabBefore.windowId);
  } catch (_) {}

  if (a.hover_before) {
    await performHoverBefore(tabId, a.hover_before);
  } else if (STATE.lastActionType === "hover" && STATE.lastHoverTarget && STATE.batchDepth === 0) {
    console.log("[agent] Reactively re-triggering previous hover to restore transient element visibility:", STATE.lastHoverTarget);
    await performHoverBefore(tabId, STATE.lastHoverTarget);
  }

  // Resolve source
  let src;
  if (a.from_som_id != null) {
    const pt = await resolveSomId(tabId, a.from_som_id);
    if (!pt) return { success: false, action_type: "drag", error: `from_som_id ${a.from_som_id} not found in element map — page may have changed` };
    src = pt;
  } else if (a.from_relative_to_som_id != null || a.relative_to_som_id != null) {
    const relSomId = a.from_relative_to_som_id ?? a.relative_to_som_id;
    src = await resolveContainerOffset(tabId, relSomId, a.from_x ?? a.x, a.from_y ?? a.y, "drag");
    if (src.error) return { success: false, ...src };
  } else {
    src = await resolveCoords(tabId, a.from_ref, a.from_x ?? a.x, a.from_y ?? a.y, "drag");
    if (src.error) return { success: false, ...src };
  }
  // Resolve destination
  let dst;
  if (a.to_som_id != null) {
    const pt = await resolveSomId(tabId, a.to_som_id);
    if (!pt) return { success: false, action_type: "drag", error: `to_som_id ${a.to_som_id} not found in element map — page may have changed` };
    dst = pt;
  } else if (a.to_relative_to_som_id != null) {
    dst = await resolveContainerOffset(tabId, a.to_relative_to_som_id, a.to_x ?? a.x, a.to_y ?? a.y, "drag");
    if (dst.error) return { success: false, ...dst };
  } else {
    dst = await resolveCoords(tabId, a.to_ref, a.to_x ?? a.x, a.to_y ?? a.y, "drag");
    if (dst.error) return { success: false, ...dst };
  }


  // --- Verify source and destination BEFORE acting ----------------------------
  // Snapshot what elements exist at both points right now, so we can compare
  // after the drag and know precisely whether and what moved.
  const [srcBefore, dstBefore] = await Promise.all([
    inspectPoint(tabId, src.x, src.y),
    inspectPoint(tabId, dst.x, dst.y),
  ]);

  const coordsUsed = `from=(${Math.round(src.x)},${Math.round(src.y)}) to=(${Math.round(dst.x)},${Math.round(dst.y)}) [viewport pixels]`;

  await glidePointer(tabId, src.x, src.y);
  // Animate cursor along the drag path concurrently with the drag events (~350ms)
  animateCursorDrag(tabId, src.x, src.y, dst.x, dst.y, 350).catch(() => {});

  // --- Multi-strategy drag (tries CDP, HTML5 DnD, Pointer Events) -----------
  const dragResult = await synthDrag(tabId, src.x, src.y, dst.x, dst.y);

  // Give CSS transition animations time to finish after the winning strategy
  await waitForDOMStability(tabId, 2000, 400);
  const tab = await chrome.tabs.get(tabId);
  const fpAfter = await domFingerprint(tabId);
  const diff = diffFingerprints(fpBefore, fpAfter);

  // --- Verify source and destination AFTER drag ----------------------
  const [srcAfter, dstAfter] = await Promise.all([
    inspectPoint(tabId, src.x, src.y),
    inspectPoint(tabId, dst.x, dst.y),
  ]);
  const { drag_verified, verification_note } = buildDragVerification(srcBefore, dstBefore, srcAfter, dstAfter);

  // If multi-strategy drag produced a change, we're done
  let visualChanged = false;
  if (dataUrlBefore) {
    visualChanged = await detectVisualChange(tabId, tab.windowId, dataUrlBefore);
  }

  if (dragResult.moved || diff.anyChange || drag_verified || visualChanged) {
    const urlChanged = tab.url !== urlBefore;
    const pageChanged = urlChanged || diff.anyChange || visualChanged;
    if (diff.anyChange || urlChanged || visualChanged) STATE.elementMapDirty = true;
    let domDiff = diff.summary;
    if (visualChanged && !diff.anyChange) {
      domDiff = "[visual content updated]";
    }
    return { success: true, action_type: "drag", url: tab.url, title: tab.title,
      page_changed: pageChanged, dom_diff: domDiff,
      method: dragResult.method, drag_verified, verification_note, coords_used: coordsUsed };
  }

  // --- Click-to-move fallback (last resort) ---------------------------------
  // All 3 drag strategies failed. Try click-source then click-destination.
  // First cancel any lingering drag state from the attempts.
  await cancelDragState(tabId, src.x, src.y);
  await sleep(200);

  // Check if the failed drag left the element in a "selected" state
  const fpMid = await domFingerprint(tabId);
  const diffMid = diffFingerprints(fpBefore, fpMid);
  const alreadySelected = diffMid.anyChange && diffMid.summary.includes("selection");

  // If not already selected by the drag attempts, click to select
  if (!alreadySelected) {
    await glidePointer(tabId, src.x, src.y);
    await sleep(50);
    await synthClick(tabId, src.x, src.y);
    await waitForDOMStability(tabId, 1500, 200);
  }
  await sleep(300);
  // Click destination to move
  await glidePointer(tabId, dst.x, dst.y);
  await sleep(50);
  await synthClick(tabId, dst.x, dst.y);
  await waitForDOMStability(tabId, 3000, 600);

  const tab2 = await chrome.tabs.get(tabId);
  const fpAfter2 = await domFingerprint(tabId);
  const diff2 = diffFingerprints(fpBefore, fpAfter2);
  // Re-verify after click-to-move
  const [srcAfter2, dstAfter2] = await Promise.all([
    inspectPoint(tabId, src.x, src.y),
    inspectPoint(tabId, dst.x, dst.y),
  ]);
  const v2 = buildDragVerification(srcBefore, dstBefore, srcAfter2, dstAfter2);

  let visualChanged2 = false;
  if (dataUrlBefore) {
    visualChanged2 = await detectVisualChange(tabId, tab2.windowId, dataUrlBefore);
  }

  const clickMoveWorked = (tab2.url !== urlBefore) || diff2.anyChange || v2.drag_verified || visualChanged2;
  if (diff2.anyChange || tab2.url !== urlBefore || visualChanged2) STATE.elementMapDirty = true;

  let domDiff2 = diff2.summary;
  if (visualChanged2 && !diff2.anyChange) {
    domDiff2 = "[visual content updated]";
  } else if (!clickMoveWorked) {
    domDiff2 = "no movement detected after all drag strategies and click-to-move";
  }

  return {
    success: clickMoveWorked,
    action_type: "drag",
    url: tab2.url,
    title: tab2.title,
    page_changed: clickMoveWorked,
    dom_diff: domDiff2,
    method: clickMoveWorked ? "click_to_move" : "none",
    drag_verified: v2.drag_verified,
    verification_note: v2.verification_note,
    coords_used: coordsUsed,
    error: clickMoveWorked ? undefined : "all drag strategies failed (CDP mouse, HTML5 DragEvent, Pointer Events, click-to-move) — the element may not support drag or the coordinates may be wrong",
  };
}

function waitForLoad(tabId, timeout = 15000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      chrome.tabs.get(tabId, (tab) => {
        // The tab can be closed/replaced mid-load: chrome.tabs.get then sets
        // lastError and passes tab=undefined. Reading tab.status would THROW inside
        // this callback — leaving the promise forever unresolved and hanging every
        // caller (navigate, new_tab, read_download...). Resolve instead.
        if (chrome.runtime.lastError || !tab) {
          return resolve();
        }
        if (tab.status === "complete" || Date.now() - start > timeout) {
          return resolve();
        }
        setTimeout(check, 200);
      });
    };
    check();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getDOMLength(tabId) {
  try {
    const { result } = await sendCDP(tabId, "Runtime.evaluate", {
      expression: "document.documentElement.innerHTML.length",
      returnByValue: true
    });
    return result && typeof result.value === "number" ? result.value : 0;
  } catch (_) {
    return 0;
  }
}

// -- DOM Fingerprint (before/after action diffing) ----------------------------
// Captures a lightweight snapshot of observable page state: dialogs, alerts,
// form errors, expanded widgets, input values, and content volume.
// Used to detect changes that don't alter the URL or raw HTML length
// (checkbox toggles, modals, inline validation errors, accordion open/close).

async function domFingerprint(tabId) {
  try {
    const { result } = await sendCDP(tabId, "Runtime.evaluate", {
      expression: `(function() {
        try {
          var dialogs  = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')]
                          .filter(function(e){ var r=e.getBoundingClientRect(); return r.width>0&&r.height>0; });
          var alerts   = [...document.querySelectorAll('[role="alert"],[aria-live]:not([aria-live="off"])')];
          var expd     = document.querySelectorAll('[aria-expanded="true"]').length;
          var errors   = [...document.querySelectorAll(
            '[aria-invalid="true"],[class*="error"i]:not(script):not(style):not(link),' +
            '[class*="invalid"i]:not(script):not(style),[class*="field-error"i]'
          )].filter(function(e){ return e.offsetParent!==null; }).slice(0,6);
          var inputVals = [...document.querySelectorAll(
            'input:not([type="hidden"]):not([type="password"]),select,textarea'
          )].filter(function(e){ return e.offsetParent!==null; })
            .slice(0,12)
            .map(function(e){
              return (e.name||e.id||e.placeholder||'?').slice(0,20)+'='+String(e.value||'').slice(0,40);
            });
          var checks = [...document.querySelectorAll('input[type="checkbox"],input[type="radio"]')]
            .filter(function(e){ return e.offsetParent!==null; })
            .slice(0,10)
            .map(function(e){ return (e.name||e.id||'?')+':'+(e.checked?'1':'0'); });
          // Stable CSS transform/position tracking of visible positioned elements.
          // We only track elements that actually have inline transform, left, or top style
          // to prevent false positives from generic style mutations (e.g. colors, displays).
          var posElements = [...document.querySelectorAll('[style]')].filter(function(e){
            if (e.offsetParent === null) return false;
            var s = e.style;
            return !!(s.transform || s.left || s.top);
          });
          function getPath(el) {
            var path = [];
            while (el && el.nodeType === 1) {
              var name = el.nodeName.toLowerCase();
              // Include up to four class names for stable identity across sibling insertions.
              // Many modern frameworks append state classes (e.g. 'active', 'selected', 'dragging')
              // at the end of the class list, so truncating to 2 causes us to miss state changes.
              var cls = el.className && typeof el.className === 'string'
                ? el.className.trim().split(/\s+/).slice(0, 4).join('.') : '';
              if (el.id) {
                path.unshift(name + '#' + el.id);
                break;
              } else {
                var sib = el;
                var nth = 1;
                while (sib = sib.previousElementSibling) {
                  if (sib.nodeName.toLowerCase() === el.nodeName.toLowerCase()) nth++;
                }
                path.unshift(name + (cls ? '.' + cls : '') + ':nth-of-type(' + nth + ')');
              }
              el = el.parentNode;
            }
            return path.join(' > ');
          }
          // Normalize pixel values to integers to avoid sub-pixel floating-point
          // false positives (e.g. translate(87.5px) vs translate(87.50001px)).
          function normPx(s) {
            return (s || '').replace(/-?[\d.]+px/g, function(m) {
              return Math.round(parseFloat(m)) + 'px';
            });
          }
          var posStyles = posElements.slice(0, 150).map(function(e){
            var s = e.style;
            return getPath(e) + '=' + normPx(s.transform) + '|' + normPx(s.left) + '|' + normPx(s.top);
          });
          posStyles.sort();
          var styles = [...document.querySelectorAll(
            '.active,.selected,.checked,.disabled,[class*="active"i],[class*="selected"i],[class*="checked"i],[class*="disabled"i],[aria-selected="true"],[aria-checked="true"]'
          )].filter(function(e){ return e.offsetParent!==null; })
            .slice(0, 100)
            .map(getPath);
          return {
            url:          location.href,
            dialogCount:  dialogs.length,
            dialogTexts:  dialogs.slice(0,3).map(function(d){ return d.innerText.slice(0,100).replace(/\s+/g,' '); }),
            alertCount:   alerts.length,
            alertTexts:   alerts.slice(0,3).map(function(a){ return a.innerText.slice(0,100).replace(/\s+/g,' '); }),
            expandedCount: expd,
            errorCount:   errors.length,
            errorTexts:   errors.map(function(e){ return e.innerText.slice(0,80).replace(/\s+/g,' '); }),
            inputVals:    inputVals,
            checks:       checks,
            posStyles:    posStyles,
            styles:       styles,
            bodyLen:      document.body ? document.body.innerText.length : 0,
            elemCount:    document.querySelectorAll('*').length,
          };
        } catch(err) {
          return { url: location.href, bodyLen: 0, elemCount: 0, dialogCount:0, alertCount:0, expandedCount:0, errorCount:0 };
        }
      })()`,
      returnByValue: true
    });
    return result?.value ?? { url: "", bodyLen: 0, elemCount: 0, dialogCount:0, alertCount:0, expandedCount:0, errorCount:0 };
  } catch (_) {
    return { url: "", bodyLen: 0, elemCount: 0, dialogCount:0, alertCount:0, expandedCount:0, errorCount:0 };
  }
}

// Compares two domFingerprint snapshots.
// Returns { anyChange: bool, summary: string } where summary is a human-readable
// description injected into action history so the LLM knows what actually happened.
function diffFingerprints(before, after) {
  const parts = [];
  let anyChange = false;

  // Modal / dialog appeared or closed
  const bDlg = before.dialogCount || 0;
  const aDlg = after.dialogCount  || 0;
  if (aDlg > bDlg) {
    anyChange = true;
    const newTexts = (after.dialogTexts || []).slice(bDlg).filter(Boolean);
    parts.push(`modal appeared${newTexts.length ? ': "' + newTexts[0].slice(0,60) + '"' : ''}`);
  } else if (aDlg < bDlg) {
    anyChange = true;
    parts.push("modal closed");
  }

  // Alert / live-region appeared
  const bAlt = before.alertCount || 0;
  const aAlt = after.alertCount  || 0;
  if (aAlt > bAlt) {
    anyChange = true;
    const newTexts = (after.alertTexts || []).slice(bAlt).filter(Boolean);
    parts.push(`notification appeared${newTexts.length ? ': "' + newTexts[0].slice(0,60) + '"' : ''}`);
  }

  // Form errors appeared or cleared
  const bErr = before.errorCount || 0;
  const aErr = after.errorCount  || 0;
  if (aErr > bErr) {
    anyChange = true;
    const newErrs = (after.errorTexts || []).filter(function(t){ return !(before.errorTexts||[]).includes(t); });
    parts.push(`form error${newErrs.length > 1 ? 's' : ''}: "${newErrs.slice(0,2).map(function(t){ return t.slice(0,50); }).join('" / "')}"`);
  } else if (aErr < bErr) {
    anyChange = true;
    parts.push("form error cleared");
  }

  // Expanded widget count changed (accordion, dropdown)
  const bExp = before.expandedCount || 0;
  const aExp = after.expandedCount  || 0;
  if (aExp !== bExp) {
    anyChange = true;
    const delta = aExp - bExp;
    parts.push(delta > 0 ? (delta + " item(s) expanded") : ((-delta) + " item(s) collapsed"));
  }

  // Checkbox / radio state changed
  if (before.checks && after.checks) {
    const bSet = new Set(before.checks);
    const changed = (after.checks).filter(function(v){ return !bSet.has(v); });
    if (changed.length > 0) {
      anyChange = true;
      parts.push("checkbox/radio changed: " + changed.slice(0,2).join(", "));
    }
  }

  // Input value changed (typed text, select option changed)
  if (before.inputVals && after.inputVals) {
    const bSet = new Set(before.inputVals);
    const changed = (after.inputVals).filter(function(v){ return !bSet.has(v); });
    if (changed.length > 0) {
      anyChange = true;
      parts.push("input changed: " + changed.slice(0,2).join(", "));
    }
  }

  // Active/Selected state classes changed
  if (before.styles && after.styles) {
    const bSet = new Set(before.styles);
    const changed = (after.styles).filter(function(v){ return !bSet.has(v); });
    if (changed.length > 0) {
      anyChange = true;
      parts.push("selection state changed: " + changed.slice(0, 2).map(p => p.split('>').pop().trim()).join(", "));
    }
  }

  // CSS transform/position changes — catches drag-and-drop moves,
  // kanban cards, sliders, and any UI that repositions elements via style only.
  // Distinguish between elements that actually MOVED (same path, new value)
  // vs selection indicators that appeared/disappeared (new/removed paths).
  if (before.posStyles && after.posStyles) {
    const bMap = new Map();
    for (const s of before.posStyles) { const i = s.indexOf('='); if (i > 0) bMap.set(s.substring(0, i), s.substring(i + 1)); }
    const aMap = new Map();
    for (const s of after.posStyles) { const i = s.indexOf('='); if (i > 0) aMap.set(s.substring(0, i), s.substring(i + 1)); }
    let movedCount = 0, appearedCount = 0, disappearedCount = 0;
    for (const [path, aVal] of aMap) {
      if (!bMap.has(path)) appearedCount++;
      else if (bMap.get(path) !== aVal) movedCount++;
    }
    for (const path of bMap.keys()) { if (!aMap.has(path)) disappearedCount++; }
    if (movedCount > 0) {
      anyChange = true;
      parts.push(`${movedCount} element${movedCount > 1 ? 's' : ''} repositioned`);
    } else if (appearedCount > 0 || disappearedCount > 0) {
      anyChange = true;
      if (parts.length === 0) parts.push("selection state changed");
    }
  }

  // Significant body text volume change (>8% means meaningful content swap)
  const bLen = before.bodyLen || 0;
  const aLen = after.bodyLen  || 0;
  if (bLen > 100 && Math.abs(aLen - bLen) / bLen > 0.08) {
    anyChange = true;
    if (parts.length === 0) parts.push("page content updated");
  }

  // Element count jumped significantly (new section rendered)
  const bEl = before.elemCount || 0;
  const aEl = after.elemCount  || 0;
  if (Math.abs(aEl - bEl) > 8) {
    anyChange = true;
    if (parts.length === 0) {
      parts.push("DOM updated (" + (aEl > bEl ? "+" : "") + (aEl - bEl) + " elements)");
    }
  }

  return {
    anyChange,
    summary: parts.length > 0 ? " [" + parts.join("] [") + "]" : "",
  };
}

// Centralized visual and DOM change verification after page interactions
// Capture a compact signature of the DOM element at (x,y) — its identity plus the
// state that a click would plausibly toggle (selection/checked/expanded/value/size/
// child count/text). Comparing before vs after tells us whether the element WE
// clicked actually reacted, independent of unrelated changes elsewhere on the page.
// Returns null for canvas / body / empty points, where no DOM-observable target
// state exists (those are handled by the visual-diff path instead).
// Pixel signature: a 16×16 grayscale thumbnail of the ~96 CSS px around a point.
// This is the canvas equivalent of captureTargetSignature — DOM attributes don't
// exist on a pixel surface, but "did the pixels around the click point change"
// is the same target-responded question answered from the rendered image.
async function capturePixelSignature(tabId, x, y) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const dataUrl = await captureTabForDiff(tabId, tab.windowId);
    if (!dataUrl) return null;
    const bitmap = await createImageBitmap(dataUrlToBlob(dataUrl));
    const cssW = STATE.lastViewportW || bitmap.width;
    const dpr = bitmap.width / cssW;
    const S = 96;   // CSS px window around the point
    const sx = Math.max(0, Math.min(bitmap.width - 8, (x - S / 2) * dpr));
    const sy = Math.max(0, Math.min(bitmap.height - 8, (y - S / 2) * dpr));
    const sw = Math.min(S * dpr, bitmap.width - sx);
    const sh = Math.min(S * dpr, bitmap.height - sy);
    const canvas = new OffscreenCanvas(16, 16);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, 16, 16);
    bitmap.close();
    const d = ctx.getImageData(0, 0, 16, 16).data;
    const sig = new Uint8Array(256);
    for (let i = 0, p = 0; p < 256; i += 4, p++) {
      sig[p] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    }
    return sig;
  } catch (_) { return null; }
}

// Fraction of signature pixels that changed beyond JPEG noise.
function pixelSigDiffFraction(a, b) {
  if (!a || !b || a.length !== b.length) return 1;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > 24) diff++;
  }
  return diff / a.length;
}

async function captureTargetSignature(tabId, x, y) {
  try {
    const { result } = await sendCDP(tabId, "Runtime.evaluate", {
      expression: `(function(cx,cy){
        // Descend through same-origin iframes: without this, a canvas embedded in a frame
        // resolves to the <iframe> element, whose signature never changes. The click is
        // then judged a "dom" target that failed to react, and the drift guard tells the
        // model it hit the wrong element after every CORRECT canvas click. Returning null
        // (as we do for a bare CANVAS) routes it to the pixel check instead.
        var ox = 0, oy = 0, el = document.elementFromPoint(cx, cy), guard = 0;
        while (el && el.tagName === 'IFRAME' && guard++ < 5) {
          var ir = el.getBoundingClientRect(), idoc = null;
          try { idoc = el.contentDocument; } catch (e) { idoc = null; }  // cross-origin → stop
          if (!idoc) break;
          ox += ir.left; oy += ir.top;
          var inner = idoc.elementFromPoint(cx - ox, cy - oy);
          if (!inner) break;
          el = inner;
        }
        if (!el || el.tagName === 'HTML' || el.tagName === 'BODY') return null;
        if (el.tagName === 'CANVAS') return null;
        // Cross-origin iframe we could not descend into: its interior is opaque, so
        // there is no DOM signature to take and nothing to compare afterwards. Return
        // null so the caller classifies this as a PIXEL target — otherwise the drift
        // guard signs off on the frame element itself, sees it unchanged after every
        // (correct) click, and tells the model it hit the wrong thing.
        if (el.tagName === 'IFRAME') return null;
        var r = el.getBoundingClientRect();
        var a = function(n){ return el.getAttribute(n) || ''; };
        return [
          el.tagName, (el.className && el.className.toString ? el.className.toString() : ''),
          a('aria-selected'), a('aria-checked'), a('aria-expanded'), a('aria-pressed'),
          a('aria-current'), a('data-state'), ('value' in el ? String(el.value) : ''),
          // Native checkbox/radio state lives on the .checked PROPERTY, not an attribute:
          // ticking a checkbox leaves aria-checked and .value untouched, so without this
          // the signature is identical before/after and the toggle reads as "no response".
          ('checked' in el ? String(el.checked) : ''),
          el.childElementCount,
          Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height),
          (el.innerText || '').slice(0, 40)
        ].join('|');
      })(${Math.round(x)},${Math.round(y)})`,
      returnByValue: true,
    });
    return result && result.value !== undefined ? result.value : null;
  } catch (_) { return null; }
}

async function verifyPageChange(tabId, urlBefore, fpBefore, dataUrlBefore, actionType, originalResult) {
  if (!originalResult || !originalResult.success) return originalResult;

  const tab = await chrome.tabs.get(tabId);
  const fpAfter = await domFingerprint(tabId);
  const diff = diffFingerprints(fpBefore, fpAfter);
  const urlChanged = tab.url !== urlBefore;
  let visualChanged = false;
  if (dataUrlBefore) {
    // Canvas-heavy pages (VNC, WebGL, games) render click/type responses asynchronously —
    // the remote desktop may not have sent a frame back yet when DOM stability resolves
    // (which fires instantly since the canvas DOM never mutates). Wait briefly so the canvas
    // has time to paint before we capture the after-screenshot.
    try {
      const [ci] = await chrome.scripting.executeScript({ target: { tabId }, func: _getLargestCanvasPage });
      if (ci?.result) await sleep(400);
    } catch (_) {}
    visualChanged = await detectVisualChange(tabId, tab.windowId, dataUrlBefore);
  }

  // ── Ambient-motion guard ───────────────────────────────────────────────────
  // When the URL and DOM are both unchanged, the screenshot diff is the ONLY
  // evidence that the action did anything — and that is exactly the case a
  // self-animating surface fakes. A game, video, carousel, spinner or live chart
  // repaints every frame, so EVERY no-op action "changes the page". The agent's
  // no-change streak then never accumulates, its stuck detector never arms, and it
  // flails at nothing until the step budget runs out (observed: 54 steps of
  // double-clicking empty space on a Flash title screen, loop detector silent).
  //
  // Settle it by watching the page while doing NOTHING. If it keeps changing on its
  // own, the change was never attributable to us — so don't claim it was. Costs one
  // extra capture, and only in this ambiguous case.
  //
  // Require SUSTAINED motion across two idle intervals, not one. A click that TRIGGERS
  // a finite animation (menu slides open, canvas plays a one-shot transition) is still
  // moving right after the action — a single probe would call that "ambient" and throw
  // away a real result, which is the same failure in the opposite direction. A one-shot
  // animation settles by the second interval; a game/video loop does not.
  let ambientMotion = false;
  if (visualChanged && !urlChanged && !diff.anyChange) {
    try {
      const f1 = await captureTabForDiff(tabId, tab.windowId);
      await sleep(350);
      if (await detectVisualChange(tabId, tab.windowId, f1)) {
        const f2 = await captureTabForDiff(tabId, tab.windowId);
        await sleep(350);
        ambientMotion = await detectVisualChange(tabId, tab.windowId, f2);
      }
    } catch (_) {}
    if (ambientMotion) visualChanged = false;
  }

  const pageChanged = urlChanged || diff.anyChange || visualChanged || originalResult.page_changed;
  if (diff.anyChange || urlChanged || visualChanged) STATE.elementMapDirty = true;

  let domDiff = diff.summary;
  if (ambientMotion && !diff.anyChange && !urlChanged) {
    domDiff = "[this surface repaints on its own (animation/video/game) — a pixel diff " +
              "cannot show whether your action did anything. Do not read the visual change " +
              "as success: confirm from the content itself, and if it did not respond, " +
              "target something else rather than repeating.]";
  } else if (visualChanged && !diff.anyChange) {
    domDiff = "[visual content updated]";
  } else if (!domDiff && originalResult.dom_diff) {
    domDiff = originalResult.dom_diff;
  }

  return {
    ...originalResult,
    url: tab.url,
    title: tab.title,
    page_changed: pageChanged,
    ambient_motion: ambientMotion,
    dom_diff: domDiff
  };
}

// -- DOM stability wait -------------------------------------------------------
// Injects a MutationObserver into the page and resolves once the DOM has been
// quiet for `settle` ms, or after `maxMs` regardless. This replaces the
// fixed sleep() after every action — SPAs settle in 300–800 ms, not 150 ms.

// Playwright-style pre-click readiness check.
// Polls the element at (x, y) up to timeoutMs, returning as soon as the
// element is visible, non-disabled, and receiving pointer events.
// Never blocks the click if the check times out — it's best-effort.
async function waitForClickable(tabId, x, y, timeoutMs = 2000) {
  const cx = Math.round(x);
  const cy = Math.round(y);
  const deadline = Date.now() + timeoutMs;
  const POLL_MS = 60;

  const expr = `(function(cx, cy) {
    var el = document.elementFromPoint(cx, cy);
    if (!el || el === document.documentElement || el === document.body)
      return { ok: false, reason: 'no element at point' };

    // Cross-origin iframes appear as an <iframe> element at the hit point, but
    // CDP Input events land on the frame boundary — not on the content inside.
    // Return false so the caller waits/retries rather than declaring it clickable.
    if (el.tagName === 'IFRAME') {
      try { void el.contentDocument; } catch (_) {
        return { ok: false, reason: 'cross-origin iframe — content unreachable from main context' };
      }
    }

    // Disabled via attribute or aria
    if (el.disabled) return { ok: false, reason: 'disabled' };
    if (el.closest('[disabled],[aria-disabled="true"]'))
      return { ok: false, reason: 'ancestor disabled' };

    // Must have non-zero painted size
    var r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0)
      return { ok: false, reason: 'zero size' };

    // Must be visible in CSS (display, visibility, opacity)
    var cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05)
      return { ok: false, reason: 'not visible' };

    // Must receive pointer events (walk up to first non-none ancestor)
    if (cs.pointerEvents === 'none') {
      var p = el.parentElement;
      while (p && p !== document.documentElement) {
        if (window.getComputedStyle(p).pointerEvents !== 'none') break;
        p = p.parentElement;
      }
      if (!p || p === document.documentElement)
        return { ok: false, reason: 'pointer-events:none' };
    }

    return { ok: true };
  })(${cx}, ${cy})`;

  while (Date.now() < deadline) {
    try {
      const { result } = await sendCDP(tabId, "Runtime.evaluate", {
        expression: expr,
        returnByValue: true,
      });
      if (result?.value?.ok) return;
    } catch (_) {}
    await sleep(POLL_MS);
  }
  // Timed out — proceed with the click anyway (element may still respond)
}

async function waitForDOMStability(tabId, maxMs = 3000, settle = 400) {
  if (!tabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (max, set) => {
        return new Promise((resolve) => {
          let timer = setTimeout(() => {
            resolve("idle");
          }, set);
          let mutationCount = 0;

          const obs = new MutationObserver(() => {
            mutationCount++;
            if (mutationCount > 20) {
              obs.disconnect();
              clearTimeout(timer);
              resolve("mutating");
              return;
            }
            clearTimeout(timer);
            timer = setTimeout(() => {
              obs.disconnect();
              resolve("stable");
            }, set);
          });

          try {
            obs.observe(document.documentElement, {
              childList: true,
              subtree: true,
              attributes: true,
              characterData: false,
              attributeFilter: ['class', 'style', 'hidden', 'disabled', 'aria-hidden', 'aria-expanded', 'aria-selected', 'open', 'src', 'href', 'value', 'checked']
            });
          } catch (_) {
            resolve("no-doc");
            return;
          }

          setTimeout(() => {
            obs.disconnect();
            resolve("timeout");
          }, max);
        });
      },
      args: [maxMs, settle]
    });
  } catch (_) {
    await new Promise(r => setTimeout(r, settle));
  }
}

// -- Network idle via injection -----------------------------------------------
// Waits until the page document.readyState is 'complete' and no pending
// fetch/XHR is detected for `idleMs`. Used after navigate/reload.

async function waitForNetworkIdle(tabId, maxMs = 6000, idleMs = 500) {
  if (!tabId) return;
  const start = Date.now();
  return new Promise((resolve) => {
    let timer = null;

    function check() {
      if (Date.now() - start > maxMs) {
        if (timer) clearTimeout(timer);
        resolve("timeout");
        return;
      }

      if (STATE.inFlightRequests.size === 0) {
        if (!timer) {
          timer = setTimeout(() => resolve("idle"), idleMs);
        }
      } else {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      }
      setTimeout(check, 50);
    }

    check();
  });
}

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

async function actHover(tabId, a) {
  const tabBefore = await chrome.tabs.get(tabId);
  const urlBefore = tabBefore.url;
  const fpBefore = await domFingerprint(tabId);
  let dataUrlBefore = null;
  try {
    dataUrlBefore = await captureTabForDiff(tabId, tabBefore.windowId);
  } catch (_) {}

  // Resolve target
  const somPt = a.som_id != null ? await resolveSomId(tabId, a.som_id) : null;
  if (a.som_id != null && !somPt)
    return { success: false, action_type: "hover", error: `som_id ${a.som_id} not found` };
  const coords = somPt ? somPt : await resolveCoords(tabId, a.ref, a.x, a.y, "hover");
  if (coords.error) return { success: false, ...coords };
  const x = Math.round(coords.x);
  const y = Math.round(coords.y);

  // Resolve element label at hover target for the cursor badge
  let hoverLabel = null;
  try {
    const lblRes = await sendCDP(tabId, "Runtime.evaluate", {
      expression: `(function(x,y){
        var el=document.elementFromPoint(x,y);
        if(!el)return null;
        return (el.getAttribute('aria-label')||el.getAttribute('title')||el.getAttribute('alt')||el.textContent||'').trim().slice(0,32)||el.tagName.toLowerCase();
      })(${x},${y})`,
      returnByValue: true,
    });
    if (lblRes && lblRes.result && lblRes.result.value) hoverLabel = lblRes.result.value;
  } catch (_) {}

  // Orange cursor for hover — distinguishable from action clicks (cyan).
  // Stays on screen until the next action replaces it.
  await glidePointer(tabId, x, y, { label: hoverLabel, color: "#f97316" });

  // 2. JS synthetic events — needed for React/Vue/Angular components that listen to
  //    mouseover/mouseenter/pointerover instead of relying on CSS :hover alone.
  //    Fire on the exact element at (x,y) and bubble up the DOM tree.
  try {
    await sendCDP(tabId, "Runtime.evaluate", {
      expression: `(function(x,y){
        var el = document.elementFromPoint(x,y);
        if (!el) return;
        var opts = { bubbles:true, cancelable:true, clientX:x, clientY:y, screenX:x, screenY:y };
        var pOpts = Object.assign({ pointerId:1, pointerType:'mouse', isPrimary:true }, opts);
        el.dispatchEvent(new PointerEvent('pointerover',  Object.assign({bubbles:true},  pOpts)));
        el.dispatchEvent(new PointerEvent('pointerenter', Object.assign({bubbles:false}, pOpts)));
        el.dispatchEvent(new MouseEvent('mouseover',  Object.assign({bubbles:true},  opts)));
        el.dispatchEvent(new MouseEvent('mouseenter', Object.assign({bubbles:false}, opts)));
      })(${x},${y})`,
    });
  } catch (_) {}

  // Wait for hover effects: CSS transitions, JS-driven show/hide, tooltip delays.
  // Use a longer stable window so slow transitions (300-500ms) fully complete.
  const waitMs = typeof a.wait_ms === "number" ? Math.max(a.wait_ms, 50) : (STATE.batchDepth > 0 ? 300 : 1200);
  const maxWait = typeof a.wait_ms === "number" ? waitMs + 400 : (STATE.batchDepth > 0 ? 800 : 2500);
  await waitForDOMStability(tabId, maxWait, waitMs);

  const res = await verifyPageChange(tabId, urlBefore, fpBefore, dataUrlBefore, "hover", { success: true, action_type: "hover" });
  res.note = res.page_changed
    ? "Hover revealed new elements — the ELEMENT_MAP will be refreshed. Read the new elements and interact with them."
    : "Hover produced no DOM change. The element may not have a hover effect, or the effect is CSS-only (invisible to DOM scan). Try clicking directly.";
  return res;
}

async function actGoBack(tabId) {
  const tabBefore = await chrome.tabs.get(tabId);
  const urlBefore = tabBefore.url;
  const fpBefore = await domFingerprint(tabId);
  let dataUrlBefore = null;
  try {
    dataUrlBefore = await captureTabForDiff(tabId, tabBefore.windowId);
  } catch (_) {}

  await chrome.tabs.goBack(tabId).catch(() => {});
  await waitForLoad(tabId).catch(() => {});
  try {
    await sendCDP(tabId, "Accessibility.enable", {});
  } catch (_) {
    try { await detachDebugger(); } catch (_2) {}
    await attachDebugger(tabId);
    STATE.attachedTabId = tabId;
  }
  await waitForNetworkIdle(tabId, 3000, 300);
  await waitForDOMStability(tabId, 2000, 300);
  return verifyPageChange(tabId, urlBefore, fpBefore, dataUrlBefore, "go_back", { success: true, action_type: "go_back" });
}

async function actGoForward(tabId) {
  const tabBefore = await chrome.tabs.get(tabId);
  const urlBefore = tabBefore.url;
  const fpBefore = await domFingerprint(tabId);
  let dataUrlBefore = null;
  try {
    dataUrlBefore = await captureTabForDiff(tabId, tabBefore.windowId);
  } catch (_) {}

  await chrome.tabs.goForward(tabId).catch(() => {});
  await waitForLoad(tabId).catch(() => {});
  try {
    await sendCDP(tabId, "Accessibility.enable", {});
  } catch (_) {
    try { await detachDebugger(); } catch (_2) {}
    await attachDebugger(tabId);
    STATE.attachedTabId = tabId;
  }
  await waitForNetworkIdle(tabId, 3000, 300);
  await waitForDOMStability(tabId, 2000, 300);
  return verifyPageChange(tabId, urlBefore, fpBefore, dataUrlBefore, "go_forward", { success: true, action_type: "go_forward" });
}

async function actRefresh(tabId) {
  const tabBefore = await chrome.tabs.get(tabId);
  const urlBefore = tabBefore.url;
  const fpBefore = await domFingerprint(tabId);
  let dataUrlBefore = null;
  try {
    dataUrlBefore = await captureTabForDiff(tabId, tabBefore.windowId);
  } catch (_) {}

  await chrome.tabs.reload(tabId);
  await waitForLoad(tabId);
  try {
    await sendCDP(tabId, "Accessibility.enable", {});
  } catch (_) {
    try { await detachDebugger(); } catch (_2) {}
    await attachDebugger(tabId);
    STATE.attachedTabId = tabId;
  }
  await waitForNetworkIdle(tabId, 4000, 400);
  await waitForDOMStability(tabId, 2000, 300);
  return verifyPageChange(tabId, urlBefore, fpBefore, dataUrlBefore, "refresh", { success: true, action_type: "refresh" });
}

async function actScreenshot(tabId, action = {}) {
  const state = await takeSnapshot(tabId, true);
  let screenshot_b64 = state.screenshot_b64 || null;

  let cropCx = null;
  let cropCy = null;
  let cropW = 350;
  let cropH = 350;

  if (action.som_id != null) {
    const el = (state.element_map || []).find(e => e.id === Number(action.som_id));
    if (el) {
      cropCx = el.x;
      cropCy = el.y;
      cropW = el.w ? Math.max(50, Math.min(el.w * 2, 800)) : 350;
      cropH = el.h ? Math.max(50, Math.min(el.h * 2, 800)) : 350;
    }
  } else if (action.x != null && action.y != null) {
    cropCx = Number(action.x);
    cropCy = Number(action.y);
    if (action.w != null) cropW = Number(action.w);
    if (action.h != null) cropH = Number(action.h);
  }

  if (cropCx !== null && cropCy !== null && state.screenshot_b64) {
    const dataUrl = `data:${state.screenshot_mime || "image/jpeg"};base64,${state.screenshot_b64}`;
    const cropped = await cropScreenshotAroundCoords(
      dataUrl,
      cropCx,
      cropCy,
      state.viewport ? state.viewport[0] : 1280,
      state.viewport ? state.viewport[1] : 720,
      cropW,
      cropH
    );
    if (cropped) {
      screenshot_b64 = cropped;
    }
  }

  return {
    success: true,
    action_type: "screenshot",
    screenshot_b64,
    url: state.url,
    title: state.title,
  };
}

async function actListTabs(tabId) {
  // Scope to the current task's tab group or window — same logic as actSwitchTab/actCloseTab.
  // Querying {} would expose every tab in every window to the LLM.
  const currentTab = await chrome.tabs.get(tabId).catch(() => null);
  let queryInfo;
  if (STATE.tabGroupId) {
    queryInfo = { groupId: STATE.tabGroupId };
  } else {
    // WINDOW_ID_CURRENT (-2) is invalid in a service worker — resolve a real windowId.
    // Prefer the tracked Navy window, then fall back to the tab's own window.
    // Last resort: query the last-focused window so we never return an empty list.
    let windowId = STATE.navyWindowId ?? currentTab?.windowId;
    if (!windowId) {
      try {
        const w = await chrome.windows.getLastFocused({ populate: false });
        windowId = w?.id;
      } catch (_) {}
    }
    if (!windowId) return { success: true, action_type: "list_tabs", tabs: [] };
    queryInfo = { windowId };
  }
  const tabs = await chrome.tabs.query(queryInfo);
  const list = tabs.map(t => ({
    id:     t.id,
    url:    t.url || "",
    title:  t.title || "",
    active: t.active,
    pinned: t.pinned,
  }));
  return { success: true, action_type: "list_tabs", tabs: list };
}

async function actScript(tabId, a) {
  const tabBefore = await chrome.tabs.get(tabId);
  const urlBefore = tabBefore.url;
  const fpBefore = await domFingerprint(tabId);
  let dataUrlBefore = null;
  try {
    dataUrlBefore = await captureTabForDiff(tabId, tabBefore.windowId);
  } catch (_) {}

  let expression = a.code || "";
  let result, exceptionDetails;

  // Try evaluating the expression as-is first (handles raw expressions like "document.title")
  const cdpRes = await sendCDP(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    userGesture: true,
    awaitPromise: true,
  });
  result = cdpRes.result;
  exceptionDetails = cdpRes.exceptionDetails;

  // If it failed with a top-level return syntax error, it's likely a block of statements
  // that needs to be wrapped in an async IIFE.
  if (exceptionDetails && exceptionDetails.exception && exceptionDetails.exception.description && exceptionDetails.exception.description.includes("Illegal return statement")) {
    const wrappedExpression = `(async () => {\n${expression}\n})()`;
    const cdpResWrapped = await sendCDP(tabId, "Runtime.evaluate", {
      expression: wrappedExpression,
      returnByValue: true,
      userGesture: true,
      awaitPromise: true,
    });
    result = cdpResWrapped.result;
    exceptionDetails = cdpResWrapped.exceptionDetails;
  }

  if (exceptionDetails) {
    let errMsg = exceptionDetails.exception && exceptionDetails.exception.description
      ? exceptionDetails.exception.description
      : "Exception occurred during script evaluation";
    if (errMsg.includes("SecurityError") || errMsg.includes("cross-origin")) {
      errMsg += " (Note: scripts run in the top-level main frame by default. You cannot access cross-origin iframes from here.)";
    }
    return { success: false, action_type: "script", error: errMsg };
  }
  const val = result ? result.value : undefined;
  const resString = val !== undefined ? JSON.stringify(val) : "undefined";
  const MAX = 20000;
  const truncated = resString.length > MAX
    ? resString.slice(0, 14000) + `\n…[${resString.length - 16000} chars omitted]…\n` + resString.slice(-2000)
    : resString;
  await waitForDOMStability(tabId, 2000, 300);
  return verifyPageChange(tabId, urlBefore, fpBefore, dataUrlBefore, "script", { success: true, action_type: "script", result: truncated });
}

// On install, configure the side panel behavior.
// We set openPanelOnActionClick to false so we can handle clicks manually
// and automatically group the clicked tab under the Navy group.
chrome.runtime.onInstalled.addListener((details) => {
  if (chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === "function") {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: false })
      .catch((e) => console.warn("[agent] sidePanel.setPanelBehavior failed:", e));
  } else {
    console.warn("[agent] chrome.sidePanel API unavailable; open the panel manually.");
  }
  if (chrome.sidePanel && typeof chrome.sidePanel.setOptions === "function") {
    chrome.sidePanel.setOptions({
      enabled: true,
      path: "ui/panel.html"
    }).catch(() => {});
  }
  
  // Only resume tasks on service worker restart, NOT on fresh install or extension update.
  // On install/update the service worker restarts and stored task state may be stale.
  if (details.reason !== "install" && details.reason !== "update") {
    resumeTaskIfNeeded().catch(e => console.error("onInstalled resume error:", e));
  } else {
    // Clear any stale task state from a previous version
    clearActiveTaskState().catch(() => {});
    console.log(`[agent] Extension ${details.reason} detected — skipping auto-resume, cleared stale task state.`);
  }
});

// Configure side panel behavior on startup/startup-like service worker runs
if (chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === "function") {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: false })
    .catch((e) => console.warn("[agent] sidePanel.setPanelBehavior failed:", e));
}
if (chrome.sidePanel && typeof chrome.sidePanel.setOptions === "function") {
  chrome.sidePanel.setOptions({
    enabled: true,
    path: "ui/panel.html"
  }).catch(() => {});
}

// Handle toolbar icon click — only open the side panel.
// Tab grouping is handled by the onConnect listener once the panel connects,
// avoiding the "Tabs cannot be edited right now" race condition.
chrome.action.onClicked.addListener((tab) => {
  // Open side panel (must stay synchronous to preserve user gesture token)
  if (chrome.sidePanel && chrome.sidePanel.open) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch((err) => {
      console.warn("Failed to open side panel via API:", err);
    });
  }
});

chrome.runtime.onStartup.addListener(() => {
  resumeTaskIfNeeded().catch(e => console.error("onStartup resume error:", e));
});

// Top-level execution to resume whenever the service worker restarts
resumeTaskIfNeeded().catch(e => console.error("Top-level resume error:", e));
