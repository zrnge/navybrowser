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
  batchDepth: 0,                 // recursion depth of batch action execution
  panelOpening: false,           // true if the panel is currently opening
  screenshotScale: 1.0,          // scale factor applied when downscaling screenshot for LLM (outW/logicalW)
  sessionTrustedActions: new Set(), // "hostname:actionType" pairs the user has trusted for this session
  pendingCanvasZoom: null,       // one-shot zoom crop injected into next snapshot by zoom_canvas action
};

// Maps individual action types to their auto-approve bucket name (set in Settings).
const ACTION_BUCKETS = {
  read: "read", wait: "read", wait_for: "read", screenshot: "read", find_text: "read", zoom_canvas: "read", listen: "read",
  navigate: "navigate", new_tab: "navigate", go_back: "navigate", go_forward: "navigate",
  refresh: "navigate", switch_tab: "navigate", close_tab: "navigate", list_tabs: "navigate",
  click: "click", double_click: "click", right_click: "click", hover: "click",
  type: "type", select: "type", key: "type",
  scroll: "scroll",
  drag: "drag",
  script: "script", fetch: "script",
  file_upload: "file",
};

// These action types execute arbitrary code or touch local files.
// They show the "Trust this site for session" option and require session trust if not auto-approved.
const CONFIRM_ALWAYS = new Set(["script", "fetch", "file_upload"]);

function isActionAutoApproved(actionType) {
  if (!STATE.autoApproveTypes || STATE.autoApproveTypes.length === 0) return false;
  const bucket = ACTION_BUCKETS[actionType] || actionType;
  return STATE.autoApproveTypes.includes(bucket);
}

let newTabHistoryEntry = null;
let watchdogInterval = null;
let _taskGen = 0; // incremented on every start/panic; lets old finally blocks detect they've been superseded

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

  if (STATE.tabGroupId && tab.windowId === STATE.navyWindowId) {
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

  // Only attach debugger if the new tab is inside the Navy group.
  if (STATE.tabGroupId && freshTab.groupId !== STATE.tabGroupId) {
    console.log(`[agent] New tab ${tab.id} is outside the Navy group, ignoring.`);
    return;
  }

  await detachDebugger().catch(() => {});
  try {
    await attachDebugger(tab.id);
    STATE.attachedTabId = tab.id;
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
    chrome.runtime.sendMessage({ action: "closeSidePanel" }).catch(() => {});
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
        chrome.runtime.sendMessage({ action: "closeSidePanel" }).catch(() => {});
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
      chrome.runtime.sendMessage({ action: "closeSidePanel" }).catch(() => {});
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
    chrome.runtime.sendMessage({ action: "closeSidePanel" }).catch(() => {});
  }
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
  stopTabBlink(STATE.attachedTabId).catch(() => {});
  detachDebugger().catch(() => {});
  STATE.running = false;
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
      classifyAndRoute(msg.goal, ciTabId, msg.autoApprove || false).catch(err => {
        console.error("Failed in classifyAndRoute:", err);
        broadcastStatus({ event: "error", message: `Classification failed: ${err.message || err}` });
      });
      break;
    }
    case "start_task": {
      const stTabId = STATE.attachedTabId || msg.tabId;
      startTask(msg.goal, stTabId, msg.autoApprove || false).catch(err => {
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
        STATE.activeAnswerResolver.resolve(msg.payload.text);
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
    await chrome.storage.local.remove("activeTaskState");
    await resetAllSidePanels();
  } catch (e) {
    console.warn("Failed to clear active task state:", e);
  }
}

async function clearSessionConversation() {
  try {
    await chrome.storage.local.remove("navySessionConversationMessages");
  } catch (e) {
    console.warn("Failed to clear session conversation messages:", e);
  }
}

async function resumeTask(activeTaskState) {
  if (STATE.running) {
    console.warn("Cannot resume task: a task is already running.");
    return;
  }

  const myGen = ++_taskGen;
  const { userGoal, attachedTabId, autoApprove } = activeTaskState;

  STATE.goal = userGoal;
  STATE.running = true;
  STATE.cancelled = false;
  STATE.inFlightRequests.clear();
  setBadge("ON", "#1f8b4c");

  STATE.attachedTabId = attachedTabId;
  try {
    await attachDebugger(attachedTabId);
    try {
      const tabObj = await chrome.tabs.get(attachedTabId);
      STATE.navyWindowId = tabObj.windowId;
      if (tabObj.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
        STATE.tabGroupId = tabObj.groupId;
      }
    } catch (_) {}
    await startTabBlink(attachedTabId);
    startWatchdog(attachedTabId);
  } catch (e) {
    STATE.running = false;
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
    if (!STATE.attachedTabId) throw new Error("Tab was closed or task was cancelled");
    const state = await takeSnapshot(STATE.attachedTabId, forceFresh);
    STATE.lastElementMap = {};
    if (Array.isArray(state.element_map)) {
      for (const el of state.element_map) STATE.lastElementMap[el.id] = el;
    }
    if (state.screenshot_b64) {
      const mime = state.screenshot_mime || "image/jpeg";
      const dataUrl = `data:${mime};base64,${state.screenshot_b64}`;
      chrome.storage.session.set({ lastScreenshot: dataUrl }).catch(() => {});
      broadcastStatus({ event: "screenshot_ready", lastScreenshot: dataUrl });
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
    // If DOM reported no change but canvas pixels changed, the action still had effect
    if (result && !result.page_changed && preCanvasHash) {
      const postCanvasHash = await getCanvasHashes(STATE.attachedTabId);
      if (postCanvasHash && postCanvasHash !== preCanvasHash) {
        result.page_changed = true;
        result.canvas_changed = true;
      }
    }
    return result;
  };

  const agent = new Agent(llm, policy, budget, snapshotter, executor, {
    userConfirm: async (prompt, _targetUrl, mustConfirm = false) => {
      // mustConfirm=true means the policy gate explicitly requires real user input —
      // cross-origin fetches and other high-risk actions set this so auto-approve cannot bypass them.
      if (!mustConfirm && STATE.autoApprove) return true;
      const rid = Math.random().toString(36).substring(2, 14);
      broadcastStatus({ event: "confirm_request", rid, prompt });
      return new Promise((resolve) => {
        STATE.activeConfirmResolver = { rid, resolve };
      });
    },

    verifyConfirm: async (observation, verified, shouldPause, actionType) => {
      // Explicit auto-approve always wins — user opted in, so respect it for all action types
      if (STATE.autoApprove) return true;
      if (actionType && isActionAutoApproved(actionType)) return true;

      // Check session trust — user previously approved this action type for this domain
      if (CONFIRM_ALWAYS.has(actionType) && STATE.attachedTabId) {
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
  });

  STATE.activeAgent = agent;

  const sessionContext = await loadSessionContext();

  try {
    const result = await agent.run(userGoal, {
      sessionContext,
      resumeState: activeTaskState,
      attachedTabId,
      autoApprove
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
    const { activeTaskState } = await chrome.storage.local.get("activeTaskState");
    if (!activeTaskState) {
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

async function classifyAndRoute(goal, tabId, autoApprove = false) {
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

  // Load conversation messages from storage to pass to classify
  let conversationMessages = [];
  try {
    const stored = await chrome.storage.local.get("navySessionConversationMessages");
    conversationMessages = stored.navySessionConversationMessages || [];
  } catch (e) {
    console.warn("[agent] Failed to load session conversation messages for classification:", e);
  }

  try {
    const result = await llm.classify(goal, conversationMessages);

    if (result.intent === "chat") {
      // If the reply looks like a refusal, route to the agent instead of showing it.
      // The agent loop has proper refusal detection and retry logic.
      const replyLo = (result.reply || "").toLowerCase();
      const isRefusalReply = ["i cannot", "i can't", "i'm not able", "i am not able",
        "i'm unable", "i am unable", "cannot assist", "not able to assist",
        "fulfill your request", "not designed to"].some(p => replyLo.includes(p));

      if (!isRefusalReply) {
        // Save this turn to conversationMessages
        conversationMessages.push({ role: "user", content: [{ type: "text", text: `<USER_GOAL>\n${goal}\n</USER_GOAL>` }] });
        conversationMessages.push({ role: "assistant", content: [{ type: "text", text: result.reply }] });

        // Limit size
        const maxHistoryMessages = 41;
        if (conversationMessages.length > maxHistoryMessages) {
          conversationMessages.splice(0, conversationMessages.length - maxHistoryMessages);
        }

        await chrome.storage.local.set({ navySessionConversationMessages: conversationMessages });

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
  await startTask(goal, tabId, autoApprove);
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

async function startTask(goal, tabId, autoApprove = false) {
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
  setBadge("ON", "#1f8b4c");

  try {
    await attachDebugger(tabId);
    await startTabBlink(tabId);
    startWatchdog(tabId);
  } catch (e) {
    STATE.running = false;
    STATE.goal = null;
    setBadge("", "#444");
    broadcastStatus({
      event: "error",
      message: `failed to attach debugger to tab: ${e.message || e}. Try a different tab.`,
    });
    return;
  }

  broadcastStatus({ event: "started", goal, attachedTabId: STATE.attachedTabId, tabGroupId: STATE.tabGroupId });

  // Get active settings from local storage
  const settings = await chrome.storage.local.get({
    provider:         "ollama",
    baseUrl:          "http://127.0.0.1:11434/v1",
    apiKey:           "",
    anthropicKey:     "",
    model:            "minicpm-v:8b",
    temperature:      0.2,
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
    if (!STATE.attachedTabId) throw new Error("Tab was closed or task was cancelled");
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
      chrome.storage.session.set({ lastScreenshot: dataUrl }).catch(() => {});
      broadcastStatus({ event: "screenshot_ready", lastScreenshot: dataUrl });
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
    // If DOM reported no change but canvas pixels changed, the action still had effect
    if (result && !result.page_changed && preCanvasHash) {
      const postCanvasHash = await getCanvasHashes(STATE.attachedTabId);
      if (postCanvasHash && postCanvasHash !== preCanvasHash) {
        result.page_changed = true;
        result.canvas_changed = true;
      }
    }
    return result;
  };

  // Instantiate native agent
  const agent = new Agent(llm, policy, budget, snapshotter, executor, {
    userConfirm: async (prompt, _targetUrl, mustConfirm = false) => {
      // mustConfirm=true means the policy gate explicitly requires real user input —
      // cross-origin fetches and other high-risk actions set this so auto-approve cannot bypass them.
      if (!mustConfirm && STATE.autoApprove) return true;
      const rid = Math.random().toString(36).substring(2, 14);
      broadcastStatus({ event: "confirm_request", rid, prompt });
      return new Promise((resolve) => {
        STATE.activeConfirmResolver = { rid, resolve };
      });
    },

    verifyConfirm: async (observation, verified, shouldPause, actionType) => {
      // Explicit auto-approve always wins — user opted in, so respect it for all action types
      if (STATE.autoApprove) return true;
      if (actionType && isActionAutoApproved(actionType)) return true;

      // Check session trust — user previously approved this action type for this domain
      if (CONFIRM_ALWAYS.has(actionType) && STATE.attachedTabId) {
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
  });

  STATE.activeAgent = agent;

  // Load previous task context to give the agent session memory
  const sessionContext = await loadSessionContext();

  try {
    const result = await agent.run(goal, {
      sessionContext,
      attachedTabId: tabId,
      autoApprove: autoApprove
    });
    broadcastStatus({ event: "done", result });
    // Persist this task so future tasks can reference it
    await saveTaskRecord(goal, result);
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
  } finally {
    if (_taskGen !== myGen) return;
    if (watchdogInterval) {
      clearInterval(watchdogInterval);
      watchdogInterval = null;
    }
    STATE.running = false;
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

// captureVisibleTab returns an image at device pixel ratio (e.g. 1920×1200 on a
// 1.5× HiDPI display whose CSS viewport is 1280×800).  The LLM outputs x,y
// coordinates from the image it sees, and those coordinates are fed directly to
// CDP mouse events which operate in CSS pixels.  If the image is DPR-scaled the
// LLM's coordinates are 1.5× (or 2×) off — every click misses.
//
// Fix: always resize the screenshot to the logical (CSS) pixel dimensions of the
// viewport before storing or sending it anywhere.  OffscreenCanvas is available
// in Chrome service workers since Chrome 69.
// Resizes a raw device-pixel screenshot to CSS logical dimensions, then caps width at
// MAX_SCREENSHOT_W (1280px) for LLM cost reduction.  Returns { b64, scale } where
// scale = outW / logicalW — callers must divide raw LLM x,y coords by scale to get
// true CSS coordinates.
const MAX_SCREENSHOT_W = 1280;
async function resizeScreenshotToLogical(dataUrl, logicalW, logicalH) {
  try {
    const outW = logicalW > MAX_SCREENSHOT_W ? MAX_SCREENSHOT_W : logicalW;
    const outH = logicalW > MAX_SCREENSHOT_W ? Math.round(logicalH * MAX_SCREENSHOT_W / logicalW) : logicalH;
    const scale = outW / logicalW;

    const resp = await fetch(dataUrl);
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    if (bitmap.width === outW && bitmap.height === outH) {
      bitmap.close();
      const comma = dataUrl.indexOf(",");
      const b64 = comma !== -1 ? dataUrl.slice(comma + 1) : dataUrl;
      return { b64, scale };
    }
    const canvas = new OffscreenCanvas(outW, outH);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, outW, outH);
    bitmap.close();
    const resizedBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.75 });
    const buf = await resizedBlob.arrayBuffer();
    const arr = new Uint8Array(buf);
    let b64 = "";
    for (let i = 0; i < arr.length; i += 8192) {
      b64 += String.fromCharCode(...arr.subarray(i, Math.min(i + 8192, arr.length)));
    }
    return { b64: btoa(b64), scale };
  } catch (_) {
    return null;
  }
}

// Crops a high-resolution 350x350 visual square centered around logical coords (cx, cy).
// Maps the logical coords to the image's raw device pixels using the device pixel ratio (DPR).
async function cropScreenshotAroundCoords(dataUrl, cx, cy, logicalW, logicalH, cropW = 350, cropH = 350) {
  try {
    const resp = await fetch(dataUrl);
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    
    // Determine the device pixel ratio (DPR)
    const dprX = bitmap.width / logicalW;
    const dprY = bitmap.height / logicalH;
    
    // Scale center coordinates and crop dimensions to raw device pixels
    const rawCx = cx * dprX;
    const rawCy = cy * dprY;
    const rawCropW = cropW * dprX;
    const rawCropH = cropH * dprY;
    
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
async function detectVisualChange(tabId, windowId, logicalW, logicalH, dataUrlBefore) {
  if (!dataUrlBefore) return false;
  try {
    const dataUrlAfter = await safeCaptureVisibleTab(windowId, { format: "jpeg", quality: 60 });
    const [resBefore, resAfter] = await Promise.all([
      fetch(dataUrlBefore),
      fetch(dataUrlAfter)
    ]);
    const [blobBefore, blobAfter] = await Promise.all([
      resBefore.blob(),
      resAfter.blob()
    ]);
    const [bitmapBefore, bitmapAfter] = await Promise.all([
      createImageBitmap(blobBefore),
      createImageBitmap(blobAfter)
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
  var TAGS  = ["a","button","input","select","textarea","details","summary","video","audio"];
  var ROLES = ["button","link","tab","menuitem","menuitemcheckbox","menuitemradio",
               "option","checkbox","radio","switch","combobox","textbox",
               "searchbox","spinbutton","slider","treeitem","listitem",
               "gridcell","columnheader","rowheader","cell","row","tree"];
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

  function assignId(fp) {
    if (prevIds[fp]) { newIds[fp] = prevIds[fp]; return prevIds[fp]; }
    while (usedIds.has(nextId)) nextId++;
    var id = nextId++;
    usedIds.add(id);
    newIds[fp] = id;
    return id;
  }

  function formatTime(s) {
    if (isNaN(s) || s === null || s === undefined) return '0:00';
    var mins = Math.floor(s / 60);
    var secs = Math.floor(s % 60);
    return mins + ":" + (secs < 10 ? "0" : "") + secs;
  }

  function lbl(el) {
    var labelText = (el.getAttribute("aria-label") || el.getAttribute("placeholder") ||
            el.getAttribute("title") || (el.textContent||"").trim().slice(0,35) ||
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
    // Only feasible for main-document elements; iframe-offset elements are
    // already in a different coordinate space.
    if (!offsetLeft && !offsetTop) {
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
    var id = assignId(fp);

    out.push({ id: id, x: cx, y: cy,
               w: Math.round(r.width), h: Math.round(r.height), label: lbl(el), selector: getUniqueSelector(el) });
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
    try {
      root.querySelectorAll("*").forEach(function(el) {
        if (seen.has(el) || out.length >= 450 || Date.now() > deadline) return;
        var r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) return;
        var s = window.getComputedStyle(el);
        if (s.cursor === 'pointer' || s.cursor === 'grab' || s.cursor === 'grabbing' || s.cursor === 'move') {
          add(el, offsetLeft, offsetTop);
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

  // Remove near-duplicate boxes (>70% overlap — keep the smaller, more specific one)
  var toRemove = new Set();
  for (var i = 0; i < out.length; i++) {
    for (var j = i + 1; j < out.length; j++) {
      var box1 = out[i];
      var box2 = out[j];
      var l1 = box1.x - box1.w/2, r1 = box1.x + box1.w/2, t1 = box1.y - box1.h/2, b1 = box1.y + box1.h/2;
      var l2 = box2.x - box2.w/2, r2 = box2.x + box2.w/2, t2 = box2.y - box2.h/2, b2 = box2.y + box2.h/2;
      var il = Math.max(l1, l2), ir = Math.min(r1, r2), it = Math.max(t1, t2), ib = Math.min(b1, b2);
      if (ir > il && ib > it) {
        var interArea = (ir - il) * (ib - it);
        var area1 = box1.w * box1.h;
        var area2 = box2.w * box2.h;
        var unionArea = area1 + area2 - interArea;
        if (interArea / unionArea > 0.7) {
          toRemove.add(area1 <= area2 ? box2.id : box1.id);
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
    return map;
  } catch (_) { return []; }
}

function _getInteractiveElementsPageAggressive() {
  var TAGS  = ["a","button","input","select","textarea","details","summary","video","audio","div","span","p","li","h1","h2","h3","h4"];
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

  function assignId(fp) {
    if (prevIds[fp]) { newIds[fp] = prevIds[fp]; return prevIds[fp]; }
    while (usedIds.has(nextId)) nextId++;
    var id = nextId++;
    usedIds.add(id);
    newIds[fp] = id;
    return id;
  }

  function formatTime(s) {
    if (isNaN(s) || s === null || s === undefined) return '0:00';
    var mins = Math.floor(s / 60);
    var secs = Math.floor(s % 60);
    return mins + ":" + (secs < 10 ? "0" : "") + secs;
  }

  function lbl(el) {
    var labelText = (el.getAttribute("aria-label") || el.getAttribute("placeholder") ||
            el.getAttribute("title") || (el.textContent||"").trim().slice(0,35) ||
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
    if (!offsetLeft && !offsetTop) {
      try {
        var topEl = document.elementFromPoint(lcx, lcy);
        if (topEl && topEl !== el && !el.contains(topEl)) return;
      } catch(_) {}
    }
    var cx = lcx + (offsetLeft || 0);
    var cy = lcy + (offsetTop  || 0);
    var fp = makeFingerprint(el, lcx, lcy);
    var id = assignId(fp);
    out.push({ id: id, x: cx, y: cy,
               w: Math.round(r.width), h: Math.round(r.height), label: lbl(el), selector: getUniqueSelector(el) });
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
    const resp = await fetch(dataUrl);
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
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

      // Bounding box
      ctx.strokeStyle = "#FF3300";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(lx + 0.5, ly + 0.5, lw, lh);

      // Label pill — scale font with output width so labels stay readable at any resolution
      const lbl = String(el.id);
      const fontSize = Math.max(12, Math.round(outW / 100));
      ctx.font = `bold ${fontSize}px Arial`;
      const pillW = Math.max(ctx.measureText(lbl).width + 6, 18);
      const pillH = fontSize + 4;
      const px = Math.min(lx, outW - pillW);
      const py = ly > pillH ? ly - pillH : ly;
      ctx.fillStyle = "#FF3300";
      if (ctx.roundRect) {
        ctx.beginPath(); ctx.roundRect(px, py, pillW, pillH, 2); ctx.fill();
      } else {
        ctx.fillRect(px, py, pillW, pillH);
      }
      ctx.fillStyle = "#FFFFFF";
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
    if (name || value) fields.push({ name: name, type: type, value: value });
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
  // Cloudflare challenge
  if ((title.includes('just a moment') || title.includes('checking your browser')) &&
      (document.getElementById('challenge-form') || document.querySelector('[data-cf-settings]'))) return 'cloudflare_challenge';
  // reCAPTCHA / hCaptcha
  if (document.querySelector('.g-recaptcha, #recaptcha, iframe[src*="recaptcha.google"]')) return 'recaptcha';
  if (document.querySelector('iframe[src*="hcaptcha.com"]')) return 'hcaptcha';
  // 2FA / OTP — combination of keyword and input structure signals
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
  if (!document.querySelector('canvas')) return '';
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
  // Generic large canvas — likely a game or complex app
  var large = false;
  document.querySelectorAll('canvas').forEach(function(c) {
    var r = c.getBoundingClientRect();
    if (r.width > 400 && r.height > 300) large = true;
  });
  return large ? 'canvas_app' : '';
}

async function detectCanvasEnv(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: _detectCanvasEnvPage });
    return res?.result || '';
  } catch (_) { return ''; }
}

function _getLargestCanvasPage() {
  var best = null;
  document.querySelectorAll('canvas').forEach(function(c) {
    var r = c.getBoundingClientRect();
    if (r.width < 200 || r.height < 150) return;
    var area = r.width * r.height;
    if (!best || area > best.area) {
      best = { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2),
               w: Math.round(r.width), h: Math.round(r.height), area: area };
    }
  });
  return best;
}

// Returns the coordinate mapping info for the largest canvas:
// CSS dimensions, pixel buffer dimensions, DPR scale, and noVNC remote framebuffer size.
// Lets the agent compute exact CSS offsets from canvas-local or VNC coordinates.
function _getCanvasGeometryPage() {
  var best = null, bestArea = 0;
  document.querySelectorAll('canvas').forEach(function(c) {
    var a = c.offsetWidth * c.offsetHeight;
    if (a > bestArea) { bestArea = a; best = c; }
  });
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
// Page.getLayoutMetrics gives the exact inner viewport; tab.width/height is the
// outer window and includes the tab strip, URL bar, etc. — up to ~120px taller.
async function getViewportSize(tabId) {
  try {
    const { cssLayoutViewport } = await sendCDP(tabId, "Page.getLayoutMetrics");
    if (cssLayoutViewport && cssLayoutViewport.clientWidth > 0 && cssLayoutViewport.clientHeight > 0) {
      return { w: Math.round(cssLayoutViewport.clientWidth), h: Math.round(cssLayoutViewport.clientHeight) };
    }
  } catch (_) {}
  try {
    const tab = await chrome.tabs.get(Number(tabId));
    return { w: tab.width || 1280, h: tab.height || 800 };
  } catch (_) {}
  return { w: 1280, h: 800 };
}

// Race a promise against a timeout. Returns the promise result or throws on timeout.
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
  // Use Page.getLayoutMetrics for exact CSS viewport (excludes browser chrome height)
  const { w: logicalW, h: logicalH } = await getViewportSize(tabId);

  let scrollPosStr = "";
  try {
    const { result } = await sendCDP(tabId, "Runtime.evaluate", {
      expression: `(function(){
        var scrollY = Math.round(window.scrollY);
        var pageHeight = Math.round(document.documentElement.scrollHeight);
        var pct = pageHeight > 0 ? Math.round((scrollY / pageHeight) * 100) : 0;
        return {
          scroll: "scrollY=" + scrollY + " / pageHeight=" + pageHeight + " (" + pct + "% scrolled)"
        };
      })()`,
      returnByValue: true
    });
    if (result && result.value) {
      scrollPosStr = `<SCROLL_POS>${result.value.scroll}</SCROLL_POS>`;
    }
  } catch (_) {}

  const canUseCache = !forceFresh &&
                      !STATE.elementMapDirty &&
                      tab.url === STATE.lastUrl &&
                      tab.title === STATE.lastTitle &&
                      scrollPosStr === STATE.lastScrollPos &&
                      STATE.lastScreenshotB64;

  let a11yText = "";
  let a11yFailed = false;
  let visibleText = "";
  let elementMap = [];
  let screenshotB64 = null;
  let screenshotMime = "image/jpeg";
  let zoomCrops = [];

  if (canUseCache) {
    screenshotB64 = STATE.lastScreenshotB64;
    screenshotMime = STATE.lastScreenshotMime || "image/jpeg";
    zoomCrops = STATE.lastZoomCrops || [];
    elementMap = STATE.lastElementMapArray || [];
    // Still get the tree and text in parallel (fast since cached by page/browser)
    const [a11yRes, visibleTextRes] = await Promise.all([
      (async () => {
        try {
          const a11y = await withTimeout(sendCDP(tabId, "Accessibility.getFullAXTree", {}), 8000, "getFullAXTree");
          return { text: compactA11y(a11y.nodes || []), failed: false };
        } catch (e) {
          return { text: `(a11y unavailable: ${e.message || e})`, failed: true };
        }
      })(),
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
      })()
    ]);
    a11yText = a11yRes.text;
    a11yFailed = a11yRes.failed;
    visibleText = visibleTextRes;
  } else {
    const [a11yRes, visibleTextRes, parsedElements] = await Promise.all([
      (async () => {
        try {
          const a11y = await withTimeout(sendCDP(tabId, "Accessibility.getFullAXTree", {}), 8000, "getFullAXTree");
          return { text: compactA11y(a11y.nodes || []), failed: false };
        } catch (e) {
          return { text: `(a11y unavailable: ${e.message || e})`, failed: true };
        }
      })(),
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
      getInteractiveElements(tabId)
    ]);

    a11yText = a11yRes.text;
    a11yFailed = a11yRes.failed;
    visibleText = visibleTextRes;
    elementMap = parsedElements;

    let rawDataUrl = null;
    try {
      rawDataUrl = await withTimeout(
        safeCaptureVisibleTab(tab.windowId, { format: "jpeg", quality: 90 }),
        5000, "captureVisibleTab"
      );
      const resized = await resizeScreenshotToLogical(rawDataUrl, logicalW, logicalH);
      if (resized) {
        screenshotB64 = resized.b64;
        const imgScale = resized.scale;
        const outW = Math.round(logicalW * imgScale);
        const outH = Math.round(logicalH * imgScale);
        if (elementMap.length > 0 && screenshotB64) {
          const somB64 = await addSetOfMarks(
            `data:image/jpeg;base64,${screenshotB64}`, elementMap, outW, outH, imgScale
          );
          if (somB64) {
            screenshotB64 = somB64;
            // mime stays "image/jpeg" — addSetOfMarks outputs JPEG 0.78
          }
        }
        STATE.screenshotScale = imgScale;
      }

      // Zoom crops for dense small-element zones so the LLM can read tiny UI
      if (rawDataUrl && elementMap.length > 0) {
        const smallEls = elementMap.filter(el => el.w < 32 || el.h < 32);
        if (smallEls.length >= 3) {
          const cx = Math.round(smallEls.reduce((s, e) => s + e.x, 0) / smallEls.length);
          const cy = Math.round(smallEls.reduce((s, e) => s + e.y, 0) / smallEls.length);
          const crop = await cropScreenshotAroundCoords(rawDataUrl, cx, cy, logicalW, logicalH, 400, 400);
          if (crop) zoomCrops = [{ b64: crop, cx, cy }];
        }
      }
      // Always add a full-canvas crop for OCR and VNC precision.
      // Canvas text is illegible at full-page zoom; the LLM needs a dedicated close-up.
      // This is the "OCR" — the vision model reads text from this zoomed image.
      if (rawDataUrl) {
        try {
          const [ci] = await chrome.scripting.executeScript({ target: { tabId }, func: _getLargestCanvasPage });
          if (ci?.result) {
            const { cx, cy, w, h } = ci.result;
            const crop = await cropScreenshotAroundCoords(
              rawDataUrl, cx, cy, logicalW, logicalH,
              Math.min(w, logicalW), Math.min(h, logicalH)
            );
            if (crop) zoomCrops.push({ b64: crop, cx, cy, note: 'canvas' });
          }
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
    // Only update screenshot cache when capture succeeded — a null would poison future cache hits
    if (screenshotB64) {
      STATE.lastScreenshotB64 = screenshotB64;
      STATE.lastScreenshotMime = screenshotMime;
      STATE.lastZoomCrops = zoomCrops;
    }
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
  const [formState, specialPage, canvasEnv, canvasGeometry, gameState] = await Promise.all([
    getFormState(tabId).catch(() => []),
    detectSpecialPage(tabId).catch(() => ''),
    detectCanvasEnv(tabId).catch(() => ''),
    getCanvasGeometry(tabId).catch(() => null),
    getGameState(tabId).catch(() => null),
  ]);

  const downloadNotif = pendingDownloadInfo;
  pendingDownloadInfo = null;

  // Sanitize element labels — aria-label, placeholder, title, textContent are all
  // attacker-controlled page content. Run injection pattern detection before any of
  // this reaches the LLM. This closes the bypass where element labels skip sanitizePageText.
  const labelWarnings = [];
  const sanitizedMap = elementMap.map(el => {
    if (!el.label) return el;
    const { clean, warned } = sanitizeLabel(el.label, 80);
    if (warned) labelWarnings.push(`element_label:id=${el.id}`);
    return warned ? { ...el, label: clean } : el;
  });

  // Sanitize form state — field names and values are also page-controlled.
  // Additionally exclude credential-like fields (OTP, PIN, token, etc.) — not just type=password.
  const sanitizedForm = formState.map(f => {
    const { clean: cleanName, warned: warnedName } = sanitizeLabel(f.name || '', 60);
    if (warnedName) labelWarnings.push(`form_name:${cleanName}`);

    let cleanValue = f.value || '';
    if (looksLikeCredentialField(f.name, f.type)) {
      cleanValue = '[credential field — value withheld]';
    } else {
      const { clean: cv, warned: warnedVal } = sanitizeLabel(f.value || '', 100);
      if (warnedVal) labelWarnings.push(`form_value:field=${f.name}`);
      cleanValue = cv;
    }
    return { name: cleanName, type: f.type, value: cleanValue };
  });

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
    tab_notification: notification
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
  const SHIELD_ACTIONS = new Set(["click","double_click","right_click","drag","hover","type","scroll"]);
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
      case "navigate":
        return await actNavigate(tabId, action);
      case "new_tab":
        return await actNewTab(tabId, action);
      case "key":
        return await actKey(tabId, action);
      case "read":
        return await actRead(tabId);
      case "wait":
        return await actWait(tabId, action);
      case "wait_for":
        return await actWaitFor(tabId, action);
      case "hover":
        return await actHover(tabId, action);
      case "go_back":
        return await actGoBack(tabId);
      case "go_forward":
        return await actGoForward(tabId);
      case "refresh":
        return await actRefresh(tabId);
      case "script":
        return await actScript(tabId, action);
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
        return await actScreenshot(tabId);
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
      case "listen":
        return await actListen(tabId, action);
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
      const result = await executeStep(tabId, { action: subAction });
      results.push(result);
      if (!result.success) {
        return {
          success: false,
          action_type: "batch",
          error: `Sub-action at index ${i} (${subAction.type}) failed: ${result.error || "unknown error"}`,
          results: results
        };
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

async function actNewTab(tabId, a) {
  await showAgentCursor(tabId, 640, 60);
  const tabObj = await chrome.tabs.get(tabId);
  const newTab = await chrome.tabs.create({ windowId: tabObj.windowId, url: a.url, active: true });
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
    dataUrlBefore = await safeCaptureVisibleTab(tabBefore.windowId, { format: "jpeg", quality: 60 });
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
  const BLOCKED_PATH = [
    /^\/etc\//i, /^\/proc\//i, /^\/sys\//i, /^\/root\//i, /^\/private\//i,
    /[/\\]\.ssh[/\\]/i, /[/\\]\.gnupg[/\\]/i,
    /C:\\Windows\\/i, /C:\\Users\\[^/\\]+\\AppData\\/i,
    /\.env$/i, /credentials/i, /id_rsa/i, /id_ed25519/i,
  ];
  if (BLOCKED_PATH.some(p => p.test(filePath))) {
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
    dataUrlBefore = await safeCaptureVisibleTab(tabBefore.windowId, { format: "jpeg", quality: 60 });
  } catch (_) {}
  let objectId;

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
      const obj = await sendCDP(tabId, "DOM.resolveNode", { backendNodeId: Number(a.ref) });
      objectId = obj.object.objectId;
    } catch (e) {
      return { success: false, action_type: "select", error: `Stale ref ${a.ref}: ${e.message}` };
    }
  } else {
    return { success: false, action_type: "select", error: "select requires som_id or ref" };
  }

  const selectValue = a.value != null ? String(a.value) : null;
  const selectText  = a.text  != null ? String(a.text)  : null;

  const result = await sendCDP(tabId, "Runtime.callFunctionOn", {
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
        var opts = { method: ${JSON.stringify(method)}, headers: ${JSON.stringify(headers)} };
        ${body ? `opts.body = ${JSON.stringify(body)};` : ""}
        var resp = await fetch(${JSON.stringify(url)}, opts);
        var text = await resp.text();
        var json = null;
        try { json = JSON.parse(text); } catch(_) {}
        return { ok: resp.ok, status: resp.status, body: text.slice(0, 8000), json: json };
      } catch(err) { return { ok: false, status: 0, body: "", error: err.message }; }
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
  const expr = `(function(x,y,label,color){
    var d = document.getElementById('__lba_cur');
    if (!d) {
      d = document.createElement('div');
      d.id = '__lba_cur';
      d.style.cssText = 'position:fixed;left:'+x+'px;top:'+y+'px;pointer-events:none;z-index:2147483647;';
      var ns = 'http://www.w3.org/2000/svg';
      var svg = document.createElementNS(ns,'svg');
      svg.setAttribute('width','20'); svg.setAttribute('height','26');
      svg.style.cssText = 'position:absolute;left:0;top:0;overflow:visible;filter:drop-shadow(0 0 1.5px #000) drop-shadow(0 0 1px #000);';
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
      // Smoothly move existing cursor to new position
      d.style.left = x + 'px'; d.style.top = y + 'px';
      var path = d.querySelector('path'); if (path) path.setAttribute('fill', color);
    }
  })(${Math.round(x)},${Math.round(y)},${JSON.stringify(label)},${JSON.stringify(color)})`;
  try { await sendCDP(tabId, "Runtime.evaluate", { expression: expr }); } catch (_) {}
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

async function actClick(tabId, a) {
  const tabBefore = await chrome.tabs.get(tabId);
  const urlBefore = tabBefore.url;
  const fpBefore = await domFingerprint(tabId);
  let dataUrlBefore = null;
  try {
    dataUrlBefore = await safeCaptureVisibleTab(tabBefore.windowId, { format: "jpeg", quality: 60 });
  } catch (_) {}
  let x, y;

  // --- Priority 1: som_id — exact centre from the cached element map.
  // No verification needed; coordinates are computed from getBoundingClientRect,
  // not estimated by the LLM from a screenshot.
  if (a.som_id != null) {
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
      ({ object } = await sendCDP(tabId, "DOM.resolveNode", { backendNodeId: Number(a.ref) }));
      ({ model } = await sendCDP(tabId, "DOM.getBoxModel", { objectId: object.objectId }));
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
    try {
      const snapResult = await sendCDP(tabId, "Runtime.evaluate", {
        expression: `(function(cx,cy){
          var el = document.elementFromPoint(cx,cy);
          if (!el || el === document.documentElement || el === document.body) return null;
          var r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) return null;
          // Only snap if the element center is within 60px of the estimated coords
          var ecx = r.left + r.width  / 2;
          var ecy = r.top  + r.height / 2;
          var dist = Math.hypot(ecx - cx, ecy - cy);
          if (dist > 60) return null;
          return { x: ecx, y: ecy };
        })(${Math.round(x)},${Math.round(y)})`,
        returnByValue: true,
      });
      if (snapResult && snapResult.result && snapResult.result.value) {
        x = snapResult.result.value.x;
        y = snapResult.result.value.y;
      }
    } catch (_) {}

    // Pre-click verification: show crosshair, screenshot, let LLM confirm.
    // Skipped for som_id and ref clicks — those coordinates are already exact.
    if (!a.confirmed) {
      await showCrosshair(tabId, x, y);
      await sleep(60);
      const verifyTab = await chrome.tabs.get(tabId);
      let verifyShotB64 = null;
      try {
        const dataUrl = await safeCaptureVisibleTab(
          verifyTab.windowId, { format: "jpeg", quality: 60 }
        );
        // Crop a 350x350 square centered around the click target coordinates (x, y)
        verifyShotB64 = await cropScreenshotAroundCoords(
          dataUrl, x, y, verifyTab.width || 1280, verifyTab.height || 800, 350, 350
        );
      } catch (_) {}
      await removeCrosshair(tabId);

      if (verifyShotB64) {
        // Don't broadcast screenshot_ready here — the crop is sent to the LLM
        // directly via verify_screenshot and showing it in the panel chat would
        // render a distorted thin strip (32×20 thumbnail of a 350×350 crop).
        return { success: false, action_type: "click", verify_screenshot: verifyShotB64, x, y };
      }
    }
  }

  await showAgentCursor(tabId, x, y);
  await synthClick(tabId, x, y);
  await waitForDOMStability(tabId, 3500, 350);
  return verifyPageChange(tabId, urlBefore, fpBefore, dataUrlBefore, "click", { success: true, action_type: "click" });
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
    dataUrlBefore = await safeCaptureVisibleTab(tabBefore.windowId, { format: "jpeg", quality: 60 });
  } catch (_) {}
  let cursorX = null, cursorY = null;
  if (a.ref) {
    let object;
    try {
      ({ object } = await sendCDP(tabId, "DOM.resolveNode", { backendNodeId: Number(a.ref) }));
      try {
        const { model } = await sendCDP(tabId, "DOM.getBoxModel", { objectId: object.objectId });
        const [x1, y1, x2, , , y3] = model.content;
        cursorX = (x1 + x2) / 2;
        cursorY = (y1 + y3) / 2;
      } catch (_) {}
      await sendCDP(tabId, "DOM.focus", { objectId: object.objectId });
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
  }
  await showAgentCursor(tabId, cursorX ?? 400, cursorY ?? 300);

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
        for (const ch of a.text) {
          const charCode = ch.charCodeAt(0);
          // windowsVirtualKeyCode for letter keys must be the UPPERCASE code (65-90).
          // Lowercase letters (97-122) share the same VK code as their uppercase counterpart.
          const vk = (charCode >= 97 && charCode <= 122) ? charCode - 32 : charCode;
          await sendCDP(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
          await sendCDP(tabId, "Input.dispatchKeyEvent", { type: "char",    key: ch, text: ch });
          await sendCDP(tabId, "Input.dispatchKeyEvent", { type: "keyUp",   key: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
        }
        usedDirectAssign = true;
      }
    } catch (_) {}
  }

  if (!usedDirectAssign) {
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
  // Do NOT capture a screenshot before scroll — on VNC/canvas pages each capture
  // takes several seconds and the two-capture cost (before + inside detectVisualChange)
  // routinely exceeds the 15s action timeout. Scroll is verified by position delta, not pixels.
  const dataUrlBefore = null;

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
  await showAgentCursor(tabId, cx, cy);

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
  return verifyPageChange(tabId, urlBefore, fpBefore, dataUrlBefore, "scroll", { success: true, action_type: "scroll", ...scrollInfo });
}

async function actNavigate(tabId, a) {
  await showAgentCursor(tabId, 640, 60);
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
  await waitForNetworkIdle(tabId, 4000, 400);
  await waitForDOMStability(tabId, 2000, 300);
  await startTabBlink(tabId);
  const tab = await chrome.tabs.get(tabId);
  return { success: true, action_type: "navigate", url: tab.url, title: tab.title };
}

async function actKey(tabId, a) {
  const tabBefore = await chrome.tabs.get(tabId);
  const urlBefore = tabBefore.url;
  const fpBefore = await domFingerprint(tabId);
  let dataUrlBefore = null;
  try {
    dataUrlBefore = await safeCaptureVisibleTab(tabBefore.windowId, { format: "jpeg", quality: 60 });
  } catch (_) {}

  // Parse "Ctrl+Shift+A" / "Ctrl++" -> modifierBits + keyName
  // We trim first and then extract modifier prefixes at the start
  let keyStr = (a.key || "").trim();
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
  const cdpKeyName = keyInfo ? keyInfo.name : keyName;
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
    type: "rawKeyDown", windowsVirtualKeyCode: vkCode, key: cdpKeyName, code: code, modifiers: modifierBits,
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

  // Navigation/submit keys need a longer settle; everything else is fast
  const needsLongWait = ["Enter", "Return", "Tab", "Escape", "F5"].includes(keyName) ||
                        (a.key || "").includes("Enter") || (a.key || "").includes("Tab");
  await waitForDOMStability(tabId, needsLongWait ? 3500 : 1000, needsLongWait ? 350 : 150);

  return verifyPageChange(tabId, urlBefore, fpBefore, dataUrlBefore, "key", { success: true, action_type: "key" });
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
    let cx = a.x || 0, cy = a.y || 0;
    // Resolve relative_to_som_id: SOM elements store CENTER (x,y), so top-left = center - size/2
    if (a.relative_to_som_id != null) {
      const el = STATE.lastElementMap[a.relative_to_som_id];
      if (el) {
        cx = (el.x - Math.round(el.w / 2)) + (a.x || 0);
        cy = (el.y - Math.round(el.h / 2)) + (a.y || 0);
      }
    }
    const { w: logicalW, h: logicalH } = await getViewportSize(tabId);
    const zoomW = Math.min(a.zoom_w || 500, logicalW);
    const zoomH = Math.min(a.zoom_h || 400, logicalH);
    const tab = await chrome.tabs.get(tabId);
    const rawDataUrl = await safeCaptureVisibleTab(tab.windowId, { format: "jpeg", quality: 92 });
    const crop = await cropScreenshotAroundCoords(rawDataUrl, cx, cy, logicalW, logicalH, zoomW, zoomH);
    if (crop) STATE.pendingCanvasZoom = { b64: crop, cx, cy, note: 'zoom_region' };
    return { success: true, action_type: "zoom_canvas", page_changed: false, url: tab.url, title: tab.title };
  } catch (e) {
    return { success: false, action_type: "zoom_canvas", error: String(e.message || e) };
  }
}

// Ensure the offscreen document (for audio capture) is alive.
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
  const binary = atob(audioB64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: 'audio/webm' });

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

  let audioB64;
  try {
    audioB64 = await captureTabAudio(tabId, durationMs);
  } catch (e) {
    return { success: false, action_type: 'listen', error: `Audio capture failed: ${e.message}` };
  }

  try {
    const cfg = await new Promise(r => chrome.storage.local.get(['baseUrl', 'apiKey'], r));
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

// -- Debugger / CDP helpers ---------------------------------------------------

function attachDebugger(tabId) {
  const inner = new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      Promise.all([
        sendCDP(tabId, "DOM.enable", {}),
        sendCDP(tabId, "Accessibility.enable", {}),
        sendCDP(tabId, "Page.enable", {}),
        sendCDP(tabId, "Network.enable", {}),
      ]).then(() => resolve()).catch(reject);
    });
  });
  return withTimeout(inner, 10000, "attachDebugger");
}

async function detachDebugger() {
  if (STATE.attachedTabId == null) return;
  // Remove the agent cursor from the page before detaching — otherwise it stays
  // stuck on screen permanently since CDP is no longer available after detach.
  try {
    await sendCDP(STATE.attachedTabId, "Runtime.evaluate", {
      expression: "(function(){['__lba_cur','__lba_shield'].forEach(function(id){var e=document.getElementById(id);if(e)e.remove();});})()",
    });
  } catch (_) {}
  await new Promise((resolve) => {
    chrome.debugger.detach({ tabId: STATE.attachedTabId }, () => {
      // Access lastError to silence Chrome's "Unchecked runtime.lastError" warning
      // in case the debugger is already detached (e.g., tab closed)
      const _ = chrome.runtime.lastError;
      STATE.attachedTabId = null;
      resolve();
    });
  });
}

function sendCDP(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(result);
    });
  });
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
    dataUrlBefore = await safeCaptureVisibleTab(tabBefore.windowId, { format: "jpeg", quality: 60 });
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
        visualChanged = await detectVisualChange(tabId, tabAfter.windowId, tabAfter.width || 1280, tabAfter.height || 800, dataUrlBefore);
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
  if (!el) return { error: `relative_to_som_id ${containerSomId} not found in element map — re-read the page`, action_type: actionType };
  const left = el.x - el.w / 2;
  const top  = el.y - el.h / 2;
  return { x: left + Number(offsetX), y: top + Number(offsetY) };
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
          const el = document.querySelector(sel);
          if (el) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              return {
                x: Math.round(r.left + r.width / 2),
                y: Math.round(r.top + r.height / 2)
              };
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

async function resolveSomId(tabId, somId) {
  if (somId == null) return null;

  // Retrieve the selector from the cached map before we overwrite it
  const cachedEl = STATE.lastElementMap[somId];
  const cachedSelector = cachedEl ? cachedEl.selector : null;

  // Always perform a live re-scan to ensure we resolve coordinates in real-time,
  // preventing layout shifts or async renders from causing stale clicks.
  try {
    const fresh = await getInteractiveElements(tabId);
    if (fresh.length) {
      STATE.lastElementMap = {};
      for (const e of fresh) STATE.lastElementMap[e.id] = e;
    }
  } catch (err) {
    console.warn("[resolveSomId] Live re-scan failed, falling back to cache:", err);
  }

  const el = STATE.lastElementMap[somId];
  if (el) return { x: el.x, y: el.y };

  // Fallback to Auto-Healing if selector is available
  if (cachedSelector) {
    console.log(`[resolveSomId] SomId ${somId} not found in live scan. Attempting auto-healing with selector: ${cachedSelector}`);
    const healedPt = await querySelectorCoords(tabId, cachedSelector);
    if (healedPt) {
      console.log(`[resolveSomId] Selector auto-healing SUCCEEDED: ${cachedSelector} -> (${healedPt.x}, ${healedPt.y})`);
      return healedPt;
    }
  }

  return null;
}

// -- Resolve a ref or fallback to raw (x, y) coords ---------------------------
async function resolveCoords(tabId, ref, x, y, actionType) {
  if (ref) {
    let object, model;
    try {
      ({ object } = await sendCDP(tabId, "DOM.resolveNode", { backendNodeId: Number(ref) }));
      ({ model } = await sendCDP(tabId, "DOM.getBoxModel", { objectId: object.objectId }));
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
    dataUrlBefore = await safeCaptureVisibleTab(tabBefore.windowId, { format: "jpeg", quality: 60 });
  } catch (_) {}
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
  await showAgentCursor(tabId, coords.x, coords.y);
  await synthDoubleClick(tabId, coords.x, coords.y);
  await waitForDOMStability(tabId, 3000, 350);
  return verifyPageChange(tabId, urlBefore, fpBefore, dataUrlBefore, "double_click", { success: true, action_type: "double_click" });
}

async function actRightClick(tabId, a) {
  const tabBefore = await chrome.tabs.get(tabId);
  const urlBefore = tabBefore.url;
  const fpBefore = await domFingerprint(tabId);
  let dataUrlBefore = null;
  try {
    dataUrlBefore = await safeCaptureVisibleTab(tabBefore.windowId, { format: "jpeg", quality: 60 });
  } catch (_) {}
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
  await showAgentCursor(tabId, coords.x, coords.y);
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
    dataUrlBefore = await safeCaptureVisibleTab(tabBefore.windowId, { format: "jpeg", quality: 60 });
  } catch (_) {}
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

  await showAgentCursor(tabId, src.x, src.y);
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
    visualChanged = await detectVisualChange(tabId, tab.windowId, tab.width || 1280, tab.height || 800, dataUrlBefore);
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
    await showAgentCursor(tabId, src.x, src.y);
    await synthClick(tabId, src.x, src.y);
    await waitForDOMStability(tabId, 1500, 200);
  }
  await sleep(300);
  // Click destination to move
  await showAgentCursor(tabId, dst.x, dst.y);
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
    visualChanged2 = await detectVisualChange(tabId, tab2.windowId, tab2.width || 1280, tab2.height || 800, dataUrlBefore);
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
    visualChanged = await detectVisualChange(tabId, tab.windowId, tab.width || 1280, tab.height || 800, dataUrlBefore);
  }
  const pageChanged = urlChanged || diff.anyChange || visualChanged;
  if (diff.anyChange || urlChanged || visualChanged) STATE.elementMapDirty = true;

  let domDiff = diff.summary;
  if (visualChanged && !diff.anyChange) {
    domDiff = "[visual content updated]";
  } else if (!domDiff && originalResult.dom_diff) {
    domDiff = originalResult.dom_diff;
  }

  return {
    ...originalResult,
    url: tab.url,
    title: tab.title,
    page_changed: pageChanged,
    dom_diff: domDiff
  };
}

// -- DOM stability wait -------------------------------------------------------
// Injects a MutationObserver into the page and resolves once the DOM has been
// quiet for `settle` ms, or after `maxMs` regardless. This replaces the
// fixed sleep() after every action — SPAs settle in 300–800 ms, not 150 ms.

async function waitForDOMStability(tabId, maxMs = 3000, settle = 400) {
  if (!tabId) return;
  const expr = `(function(){
    return new Promise(function(res){
      var t = setTimeout(function(){ obs.disconnect(); res('idle'); }, ${settle});
      var obs = new MutationObserver(function(){
        clearTimeout(t);
        t = setTimeout(function(){ obs.disconnect(); res('stable'); }, ${settle});
      });
      try {
        // Observe structural DOM changes only. Exclude characterData (text node updates
        // from live clocks, cursor blinks, etc.) and pure style/class thrash that doesn't
        // signal a meaningful page transition. attributeFilter limits to layout-relevant attrs.
        obs.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: false,
          attributeFilter: ['class','style','hidden','disabled','aria-hidden','aria-expanded','aria-selected','open','src','href','value','checked']
        });
      } catch(_) { res('no-doc'); return; }
      setTimeout(function(){ obs.disconnect(); res('timeout'); }, ${maxMs});
    });
  })()`;
  try {
    await sendCDP(tabId, "Runtime.evaluate", {
      expression: expr,
      awaitPromise: true,
      timeout: maxMs + 600,
    });
  } catch (_) {}
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
    dataUrlBefore = await safeCaptureVisibleTab(tabBefore.windowId, { format: "jpeg", quality: 60 });
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
  await showAgentCursor(tabId, x, y, { label: hoverLabel, color: "#f97316" });

  // 1. CDP mouseMoved — triggers CSS :hover and browser-native mouse tracking
  await sendCDP(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });

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
  const waitMs = typeof a.wait_ms === "number" ? Math.max(a.wait_ms, 300) : 1200;
  await waitForDOMStability(tabId, Math.max(waitMs + 1500, 2500), waitMs);

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
    dataUrlBefore = await safeCaptureVisibleTab(tabBefore.windowId, { format: "jpeg", quality: 60 });
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
    dataUrlBefore = await safeCaptureVisibleTab(tabBefore.windowId, { format: "jpeg", quality: 60 });
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
    dataUrlBefore = await safeCaptureVisibleTab(tabBefore.windowId, { format: "jpeg", quality: 60 });
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

async function actScreenshot(tabId) {
  const state = await takeSnapshot(tabId, true);
  return {
    success: true,
    action_type: "screenshot",
    screenshot_b64: state.screenshot_b64 || null,
    url: state.url,
    title: state.title,
  };
}

async function actListTabs(tabId) {
  // Scope to the current task's tab group or window — same logic as actSwitchTab/actCloseTab.
  // Querying {} would expose every tab in every window to the LLM.
  const currentTab = await chrome.tabs.get(tabId).catch(() => null);
  const windowId = currentTab ? currentTab.windowId : chrome.windows.WINDOW_ID_CURRENT;
  const queryInfo = STATE.tabGroupId
    ? { groupId: STATE.tabGroupId }
    : { windowId };
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
    dataUrlBefore = await safeCaptureVisibleTab(tabBefore.windowId, { format: "jpeg", quality: 60 });
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
    const errMsg = exceptionDetails.exception && exceptionDetails.exception.description
      ? exceptionDetails.exception.description
      : "Exception occurred during script evaluation";
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
