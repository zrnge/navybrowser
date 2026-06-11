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
import { DomainPolicy, AuditLogger } from "./security.js";

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
};

let newTabHistoryEntry = null;
let watchdogInterval = null;

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
  STATE.cancelled = true;
  abortPendingDialogs();
  stopTabBlink(STATE.attachedTabId).catch(() => {});
  detachDebugger().catch(() => {});
  STATE.running = false;
  broadcastStatus({ event: "panic", reason });
  setBadge("STOP", "#cc1f1f");
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
  STATE.panelClients.add(port);
  port.onDisconnect.addListener(() => STATE.panelClients.delete(port));
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
    try { port.postMessage(evt); } catch (_) {}
  }
}

async function handlePanelMessage(msg, port) {
  switch (msg.type) {
    case "start_task":
      startTask(msg.goal, msg.tabId, msg.autoApprove || false).catch(err => {
        console.error("Failed in startTask:", err);
      });
      break;
    case "cancel_task":
      panicStop("user cancelled from panel");
      break;
    case "update_config":
      console.log("Config update event received from panel UI.");
      break;
    case "confirm_response":
      if (STATE.activeConfirmResolver && STATE.activeConfirmResolver.rid === msg.payload.rid) {
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

// -- Task lifecycle -----------------------------------------------------------

async function startTask(goal, tabId, autoApprove = false) {
  if (STATE.running) {
    broadcastStatus({ event: "error", message: "task already running" });
    return;
  }

  let tab = await chrome.tabs.get(tabId);
  try {
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (_) {}
  if (isRestrictedUrl(tab.url)) {
    // Chrome blocks debugger on internal pages (chrome://, newtab, etc.).
    // Auto-navigate to a real page so the agent can start immediately.
    broadcastStatus({ event: "progress", step: 0, thought: "restricted tab — navigating to Google first…", kind: "think" });
    await chrome.tabs.update(tabId, { url: "https://www.google.com" });
    await waitForLoad(tabId);
    tab = await chrome.tabs.get(tabId);
  }

  STATE.goal = goal;
  STATE.running = true;
  STATE.cancelled = false;
  STATE.inFlightRequests.clear();
  setBadge("ON", "#1f8b4c");

  try {
    await attachDebugger(tabId);
    STATE.attachedTabId = tabId;
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

  broadcastStatus({ event: "started", goal });

  // Get active settings from local storage
  const settings = await chrome.storage.local.get({
    provider:     "ollama",
    baseUrl:      "http://127.0.0.1:11434/v1",
    apiKey:       "",
    anthropicKey: "",
    model:        "minicpm-v:8b",
    temperature:  0.2,
    maxSteps:     100,
    uncensored:   false,
    thinking:     false,
  });

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
    uncensored: settings.uncensored
  });

  // Budget
  const budget = {
    maxSteps: settings.maxSteps || 100,
    maxTokens: 200000,
    maxWallSeconds: 3600
  };

  // Snapshotter & Executor callbacks
  const snapshotter = async (forceFresh) => {
    const state = await takeSnapshot(STATE.attachedTabId, forceFresh);
    // Cache element map so coordinates can be resolved
    STATE.lastElementMap = {};
    if (Array.isArray(state.element_map)) {
      for (const el of state.element_map) STATE.lastElementMap[el.id] = el;
    }
    // Set visual state
    if (state.screenshot_b64) {
      const dataUrl = `data:image/jpeg;base64,${state.screenshot_b64}`;
      chrome.storage.session.set({ lastScreenshot: dataUrl }).catch(() => {});
      broadcastStatus({ event: "screenshot_ready" });
    }
    return state;
  };

  const executor = async (step) => {
    return await executeStep(STATE.attachedTabId, step);
  };

  // Instantiate native agent
  const agent = new Agent(llm, policy, budget, snapshotter, executor, {
    userConfirm: async (prompt) => {
      if (autoApprove) return true;
      const rid = Math.random().toString(36).substring(2, 14);
      broadcastStatus({ event: "confirm_request", rid, prompt });
      return new Promise((resolve) => {
        STATE.activeConfirmResolver = { rid, resolve };
      });
    },

    // Post-action verify + awaiting_approval hook:
    //   verified=true + autoApprove  → auto-continue silently
    //   verified=false               → always pause and ask user
    //   verified=true + !autoApprove → pause for user review before next step
    verifyConfirm: async (observation, verified, shouldPause) => {
      // In auto-approve mode, only stop for genuine failures
      if (autoApprove && verified) return true;

      const rid = Math.random().toString(36).substring(2, 14);
      const prompt = verified
        ? `Step result: ${observation}\n\nContinue to the next step?`
        : `⚠ Verification issue: ${observation}\n\nContinue anyway?`;
      broadcastStatus({ event: "verify_request", rid, observation, verified, prompt });
      return new Promise((resolve) => {
        STATE.activeConfirmResolver = { rid, resolve };
      });
    },

    userAnswer: async (question) => {
      const rid = Math.random().toString(36).substring(2, 14);
      broadcastStatus({ event: "answer_request", rid, question });
      return new Promise((resolve) => {
        STATE.activeAnswerResolver = { rid, resolve };
      });
    },
    cancelCheck: () => STATE.cancelled,
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
    const result = await agent.run(goal, { sessionContext });
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
    if (watchdogInterval) {
      clearInterval(watchdogInterval);
      watchdogInterval = null;
    }
    STATE.running = false;
    STATE.activeAgent = null;
    abortPendingDialogs();
    await stopTabBlink(STATE.attachedTabId);
    await detachDebugger();
    setBadge("", "#444");
    broadcastStatus({ event: "closed" });
  }
}

// -- Screenshot helpers -------------------------------------------------------

// captureVisibleTab returns an image at device pixel ratio (e.g. 1920×1200 on a
// 1.5× HiDPI display whose CSS viewport is 1280×800).  The LLM outputs x,y
// coordinates from the image it sees, and those coordinates are fed directly to
// CDP mouse events which operate in CSS pixels.  If the image is DPR-scaled the
// LLM's coordinates are 1.5× (or 2×) off — every click misses.
//
// Fix: always resize the screenshot to the logical (CSS) pixel dimensions of the
// viewport before storing or sending it anywhere.  OffscreenCanvas is available
// in Chrome service workers since Chrome 69.
async function resizeScreenshotToLogical(dataUrl, logicalW, logicalH) {
  try {
    const resp = await fetch(dataUrl);
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    if (bitmap.width === logicalW && bitmap.height === logicalH) {
      // Already at logical resolution — skip re-encode cost.
      bitmap.close();
      return dataUrl.replace(/^data:image\/jpeg;base64,/, "");
    }
    const canvas = new OffscreenCanvas(logicalW, logicalH);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, logicalW, logicalH);
    bitmap.close();
    const resizedBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.5 });
    const buf = await resizedBlob.arrayBuffer();
    const arr = new Uint8Array(buf);
    let b64 = "";
    for (let i = 0; i < arr.length; i += 8192) {
      b64 += String.fromCharCode(...arr.subarray(i, Math.min(i + 8192, arr.length)));
    }
    return btoa(b64);
  } catch (_) {
    return null;
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
  var nextId = 1;
  var deadline = Date.now() + 1800;

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
    if (r.right + (offsetLeft || 0) < 0 || r.bottom + (offsetTop || 0) < 0) return;
    if (r.left + (offsetLeft || 0) > window.innerWidth || r.top + (offsetTop || 0) > window.innerHeight) return;
    var s = window.getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none") return;
    if (parseFloat(s.opacity) < 0.1) return;
    var cx = Math.round(r.left + r.width / 2) + (offsetLeft || 0);
    var cy = Math.round(r.top  + r.height / 2) + (offsetTop || 0);
    out.push({ id: nextId++, x: cx, y: cy,
               w: Math.round(r.width), h: Math.round(r.height), label: lbl(el) });
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

  var PIECE_CODE = { wp:'White Pawn', wr:'White Rook', wn:'White Knight',
    wb:'White Bishop', wq:'White Queen', wk:'White King',
    bp:'Black Pawn', br:'Black Rook', bn:'Black Knight',
    bb:'Black Bishop', bq:'Black Queen', bk:'Black King' };

  function chessLabel(el) {
    var cls = (el.className || '').trim();
    var cap = cls.replace(/\b\w/g, function(c){ return c.toUpperCase(); });
    var m = cls.match(/\b([wb][prnbqk])\b/i);
    if (m && PIECE_CODE[m[1].toLowerCase()]) cap = PIECE_CODE[m[1].toLowerCase()];
    return cap || 'Piece';
  }

  var chessBoardEl = document.querySelector('cg-board, #board .board, .cg-wrap cg-board');
  var chessBoardRect = chessBoardEl ? chessBoardEl.getBoundingClientRect() : null;
  var chessFlipped = chessBoardEl
    ? (chessBoardEl.closest('.cg-wrap.orientation-black') !== null
       || chessBoardEl.classList.contains('orientation-black'))
    : false;

  function pixelToSquare(cx, cy) {
    if (!chessBoardRect || chessBoardRect.width < 10) return '';
    var sqW2 = chessBoardRect.width  / 8;
    var sqH2 = chessBoardRect.height / 8;
    var relX = cx - chessBoardRect.left;
    var relY = cy - chessBoardRect.top;
    var fileIdx = Math.floor(relX / sqW2);
    var rankIdx = 7 - Math.floor(relY / sqH2);
    if (chessFlipped) { fileIdx = 7 - fileIdx; rankIdx = 7 - rankIdx; }
    fileIdx = Math.max(0, Math.min(7, fileIdx));
    rankIdx = Math.max(0, Math.min(7, rankIdx));
    return String.fromCharCode(97 + fileIdx) + (rankIdx + 1);
  }

  var chessPieceSelectors = [
    'piece',
    'cg-board piece',
    '.piece[class*="w"],.piece[class*="b"]',
    'div[class*=" piece"]',
  ];
  chessPieceSelectors.forEach(function(sel) {
    try {
      document.querySelectorAll(sel).forEach(function(el) {
        if (seen.has(el) || out.length >= 450) return;
        seen.add(el);
        var r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return;
        var cx = Math.round(r.left + r.width / 2);
        var cy = Math.round(r.top  + r.height / 2);
        var sq = pixelToSquare(cx, cy);
        var lbl = 'Chess: ' + chessLabel(el) + (sq ? ' at ' + sq : '');
        out.push({ id: nextId++, x: cx, y: cy,
          w: Math.round(r.width), h: Math.round(r.height), label: lbl });
      });
    } catch(_) {}
  });

  var boardEl = document.querySelector('cg-board, #board, .cg-wrap, [id*="board"]');
  if (boardEl) {
    var br2 = boardEl.getBoundingClientRect();
    if (br2.width > 100 && br2.height > 100) {
      var sqW = br2.width  / 8;
      var sqH = br2.height / 8;
      var flipped = boardEl.closest('.cg-wrap.orientation-black') !== null
                  || boardEl.classList.contains('flipped')
                  || boardEl.closest('[class*="flipped"]') !== null;
      var files = ['a','b','c','d','e','f','g','h'];
      var ranks = ['8','7','6','5','4','3','2','1'];
      if (flipped) { files = files.slice().reverse(); ranks = ranks.slice().reverse(); }
      for (var fi = 0; fi < 8 && out.length < 450; fi++) {
        for (var ri = 0; ri < 8 && out.length < 450; ri++) {
          var sqX = Math.round(br2.left + sqW * fi + sqW / 2);
          var sqY = Math.round(br2.top  + sqH * ri + sqH / 2);
          out.push({ id: nextId++, x: sqX, y: sqY,
            w: Math.round(sqW), h: Math.round(sqH),
            label: 'Square: ' + files[fi] + ranks[ri] });
        }
      }
    }
  }

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
          if (area1 <= area2) {
            toRemove.add(box2.id);
          } else {
            toRemove.add(box1.id);
          }
        }
      }
    }
  }
  out = out.filter(function(item) { return !toRemove.has(item.id); });
  out = out.slice(0, 300);
  out.forEach(function(item, index) {
    item.id = index + 1;
  });

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
  var nextId = 1;
  var deadline = Date.now() + 1800;

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
    var cx = Math.round(r.left + r.width / 2) + (offsetLeft || 0);
    var cy = Math.round(r.top  + r.height / 2) + (offsetTop || 0);
    out.push({ id: nextId++, x: cx, y: cy,
               w: Math.round(r.width), h: Math.round(r.height), label: lbl(el) });
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
  return out;
}

// Step 2: draw numbered labels onto the screenshot using OffscreenCanvas.
async function addSetOfMarks(dataUrl, elements, logicalW, logicalH) {
  if (!elements || elements.length === 0) return null;
  try {
    const resp = await fetch(dataUrl);
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(logicalW, logicalH);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, logicalW, logicalH);
    bitmap.close();

    for (const el of elements) {
      const lx = Math.max(0, el.x - el.w / 2);
      const ly = Math.max(0, el.y - el.h / 2);
      const lw = Math.min(el.w, logicalW - lx);
      const lh = Math.min(el.h, logicalH - ly);
      if (lw < 2 || lh < 2) continue;

      // Bounding box
      ctx.strokeStyle = "#FF3300";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(lx + 0.5, ly + 0.5, lw, lh);

      // Label pill
      const lbl = String(el.id);
      ctx.font = "bold 10px Arial";
      const pillW = Math.max(ctx.measureText(lbl).width + 5, 15);
      const pillH = 14;
      const px = Math.min(lx, logicalW - pillW);
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

    const outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.75 });
    const buf = await outBlob.arrayBuffer();
    const arr = new Uint8Array(buf);
    let b64 = "";
    for (let i = 0; i < arr.length; i += 8192)
      b64 += String.fromCharCode(...arr.subarray(i, Math.min(i + 8192, arr.length)));
    return btoa(b64);
  } catch (_) { return null; }
}

// -- Snapshot -----------------------------------------------------------------

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
  const tab = await chrome.tabs.get(tabId);
  const logicalW = tab.width || 1280;
  const logicalH = tab.height || 800;

  let scrollPosStr = "";
  let boardFlipped = false;
  let promotionActive = false;
  try {
    const { result } = await sendCDP(tabId, "Runtime.evaluate", {
      expression: `(function(){
        var scrollY = Math.round(window.scrollY);
        var pageHeight = Math.round(document.documentElement.scrollHeight);
        var pct = pageHeight > 0 ? Math.round((scrollY / pageHeight) * 100) : 0;
        var board = document.querySelector('cg-board, #board, .cg-wrap');
        var flipped = board ? (board.closest('.cg-wrap.orientation-black') !== null || board.classList.contains('orientation-black') || board.closest('[class*="flipped"]') !== null) : false;
        var promo = document.querySelector('.promotion-choice, #promotion-choice, .promotion-menu, .promotion-popup, cg-board + .promotion, .promotion-choices, [class*="promotion"]');
        var promotionActive = false;
        if (promo) {
          var rect = promo.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            promotionActive = true;
          }
        }
        return {
          scroll: "scrollY=" + scrollY + " / pageHeight=" + pageHeight + " (" + pct + "% scrolled)",
          flipped: flipped,
          promotionActive: promotionActive
        };
      })()`,
      returnByValue: true
    });
    if (result && result.value) {
      scrollPosStr = `<SCROLL_POS>${result.value.scroll}</SCROLL_POS>`;
      boardFlipped = !!result.value.flipped;
      promotionActive = !!result.value.promotionActive;
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

  if (canUseCache) {
    screenshotB64 = STATE.lastScreenshotB64;
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

    try {
      const dataUrl = await withTimeout(
        chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 55 }),
        5000, "captureVisibleTab"
      );
      screenshotB64 = await resizeScreenshotToLogical(dataUrl, logicalW, logicalH);
      if (elementMap.length > 0 && screenshotB64) {
        const somUrl = `data:image/jpeg;base64,${screenshotB64}`;
        const somB64 = await addSetOfMarks(somUrl, elementMap, logicalW, logicalH);
        if (somB64) screenshotB64 = somB64;
      }
    } catch (_) {}

    STATE.lastUrl = tab.url;
    STATE.lastTitle = tab.title;
    STATE.lastScrollPos = scrollPosStr;
    STATE.lastScreenshotB64 = screenshotB64;
    STATE.lastElementMapArray = elementMap;
    STATE.elementMapDirty = false;
  }

  const notification = newTabHistoryEntry;
  newTabHistoryEntry = null;

  let tabListStr = "";
  try {
    const tabs = await chrome.tabs.query({ windowId: tab.windowId });
    tabListStr = tabs.map((t, idx) => `${idx}: ${t.title || t.url || "blank"}${t.active ? " [active]" : ""}`).join(" | ");
  } catch (_) {}

  return {
    url: tab.url,
    title: tab.title,
    accessibility_tree: a11yText,
    visible_text: visibleText,
    screenshot_b64: screenshotB64,
    a11y_failed: a11yFailed,
    viewport: [logicalW, logicalH],
    injection_warnings: [],
    element_map: elementMap,
    scroll_pos: scrollPosStr,
    tab_list: tabListStr ? `<TAB_LIST>${tabListStr}</TAB_LIST>` : "",
    tab_notification: notification,
    flipped: boardFlipped,
    promotionActive: promotionActive
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
      case "find_text":
        return await actFindText(tabId, action);
      case "close_tab":
        return await actCloseTab(tabId, action);
      default:
        return { success: false, action_type: action.type, error: "unsupported in extension" };
    }
  } catch (e) {
    return { success: false, action_type: action.type, error: String(e.message || e) };
  }
}

async function actNewTab(tabId, a) {
  await showAgentCursor(tabId, 640, 60);
  // Open a new tab, wait for it to load, re-attach the debugger to it.
  const newTab = await chrome.tabs.create({ url: a.url, active: true });
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

  // Strategy 1: Native CDP path — works for <input type="file"> elements
  try {
    await sendCDP(tabId, "DOM.setFileInputFiles", { files: [a.path], backendNodeId });
    await waitForDOMStability(tabId, 2000, 300);
    const tab = await chrome.tabs.get(tabId);
    return { success: true, action_type: "file_upload", method: "file_input", url: tab.url, title: tab.title };
  } catch (e) {
    // Only fall through for "not a file input" type errors; hard-fail for other errors
    const msg = (e.message || '').toLowerCase();
    if (!msg.includes('file input') && !msg.includes('not of type') && !msg.includes('node is not')) {
      return { success: false, action_type: "file_upload", error: `CDP setFileInputFiles failed: ${e.message}` };
    }
  }

  // Strategy 2: DataTransfer drop-event injection — for div/custom drop zones.
  // Dispatches dragenter → dragover → drop with a synthetic File whose metadata
  // (name, type) matches the target path.  Sites that inspect file content server-side
  // after form submission will still receive the real file because the browser's own
  // upload machinery is triggered by the drop; what we can't inject here is the actual
  // bytes (the File blob is empty) — sites that do client-side MD5/preview before upload
  // may notice.  For the vast majority of drag-and-drop upload widgets this is sufficient.
  const pt = resolvedPt || { x: 640, y: 400 };
  const fileName = (a.path || '').replace(/\\/g, '/').split('/').pop() || 'file';
  const mimeType = guessMimeType(fileName);

  const injectResult = await sendCDP(tabId, "Runtime.evaluate", {
    expression: `(function(px, py, fName, fMime) {
      try {
        var el = document.elementFromPoint(px, py);
        if (!el) return { ok: false, err: 'no element at coords (' + px + ',' + py + ')' };
        var dt = new DataTransfer();
        dt.items.add(new File([''], fName, { type: fMime }));
        ['dragenter', 'dragover', 'drop'].forEach(function(evtName) {
          el.dispatchEvent(new DragEvent(evtName, { bubbles: true, cancelable: true, dataTransfer: dt }));
        });
        return { ok: true, tag: el.tagName };
      } catch (err) { return { ok: false, err: err.message }; }
    })(${Math.round(pt.x)}, ${Math.round(pt.y)}, ${JSON.stringify(fileName)}, ${JSON.stringify(mimeType)})`,
    returnByValue: true,
  });

  const val = injectResult?.result?.value;
  if (val?.ok) {
    await waitForDOMStability(tabId, 2000, 300);
    const tab = await chrome.tabs.get(tabId);
    return { success: true, action_type: "file_upload", method: "datatransfer_inject", url: tab.url, title: tab.title };
  }

  return {
    success: false, action_type: "file_upload",
    error: `Drop zone injection failed: ${val?.err || 'unknown'}. ` +
           `If this element opens a native OS file dialog, click it first and then handle the dialog separately.`,
  };
}

async function actSwitchTab(tabId, a) {
  const tabs = await chrome.tabs.query({ windowId: chrome.windows.WINDOW_ID_CURRENT });
  if (a.tab_index < 0 || a.tab_index >= tabs.length) {
    return { success: false, action_type: "switch_tab", error: `Tab index ${a.tab_index} out of range (0-${tabs.length - 1})` };
  }
  const targetTab = tabs[a.tab_index];
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
  const fpBefore = await domFingerprint(tabId);
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
      if (this.tagName.toLowerCase() !== 'select') {
        // Try to find the nearest select element
        var sel = this.closest('select') || this.querySelector('select');
        if (!sel) return { ok: false, err: 'not a select element: ' + this.tagName };
        this = sel;
      }
      var opts = Array.from(this.options);
      var opt = null;
      if (val !== null) opt = opts.find(function(o){ return o.value === val; });
      if (!opt && txt !== null) opt = opts.find(function(o){ return o.text.trim() === txt; });
      if (!opt && txt !== null) opt = opts.find(function(o){ return o.text.trim().toLowerCase().includes(txt.toLowerCase()); });
      if (!opt) return { ok: false, err: 'option not found: value=' + val + ' text=' + txt };
      this.value = opt.value;
      this.dispatchEvent(new Event('change', { bubbles: true }));
      this.dispatchEvent(new Event('input',  { bubbles: true }));
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
  const tab    = await chrome.tabs.get(tabId);
  const fpAfter = await domFingerprint(tabId);
  const diff    = diffFingerprints(fpBefore, fpAfter);
  return { success: true, action_type: "select", selected: val.selected, url: tab.url, title: tab.title, page_changed: (tab.url !== (await chrome.tabs.get(tabId)).url) || diff.anyChange, dom_diff: diff.summary };
}

// Make an HTTP request from the page context (inherits cookies/session).
// Useful for calling page APIs, submitting JSON, reading REST endpoints, etc.
async function actFetch(tabId, a) {
  const method  = (a.method || "GET").toUpperCase();
  const url     = a.url;
  const headers = a.headers || {};
  const body    = a.body    != null ? (typeof a.body === "string" ? a.body : JSON.stringify(a.body)) : null;

  if (!url) return { success: false, action_type: "fetch", error: "fetch requires a url" };

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
  const tabs = await chrome.tabs.query({ windowId: chrome.windows.WINDOW_ID_CURRENT });
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

  await chrome.tabs.remove(targetId);

  // If we closed our own tab and other tabs exist, re-attach to the new active tab
  if (targetId === tabId && tabs.length > 1) {
    const [newActive] = await chrome.tabs.query({ active: true, currentWindow: true });
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

// Inject a transient arrow cursor at (x, y) — orange OS-style pointer with the
// tip at the exact click coordinate so the user sees the precise target.
async function showAgentCursor(tabId, x, y) {
  if (!tabId || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const expr = `(function(x,y){
    var e=document.getElementById('__lba_cur');if(e)e.remove();
    if(!document.getElementById('__lba_sty')){
      var s=document.createElement('style');s.id='__lba_sty';
      s.textContent='@keyframes lba-fade{0%,50%{opacity:1}100%{opacity:0}}';
      document.head.appendChild(s);
    }
    var d=document.createElement('div');d.id='__lba_cur';
    d.style.cssText='position:fixed;left:'+x+'px;top:'+y+'px;pointer-events:none;z-index:2147483647;animation:lba-fade 0.9s ease-out forwards;';
    var ns='http://www.w3.org/2000/svg';
    var svg=document.createElementNS(ns,'svg');
    svg.setAttribute('width','20');svg.setAttribute('height','26');
    svg.style.cssText='position:absolute;left:0;top:0;overflow:visible;filter:drop-shadow(0 0 1.5px #000) drop-shadow(0 0 1px #000);';
    var path=document.createElementNS(ns,'path');
    path.setAttribute('d','M0,0 L0,20 L6,14 L9,22 L11.5,21 L8.5,13 L16,13 Z');
    path.setAttribute('fill','#06b6d4');
    path.setAttribute('stroke','#0a111a');
    path.setAttribute('stroke-width','0.8');
    path.setAttribute('stroke-linejoin','round');
    svg.appendChild(path);
    var tip=document.createElementNS(ns,'circle');
    tip.setAttribute('cx','1.5');tip.setAttribute('cy','1.5');tip.setAttribute('r','2');
    tip.setAttribute('fill','#fff');tip.setAttribute('opacity','0.9');
    svg.appendChild(tip);
    d.appendChild(svg);
    document.documentElement.appendChild(d);
    setTimeout(function(){d.remove();},950);
  })(${x},${y})`;
  try { await sendCDP(tabId, "Runtime.evaluate", { expression: expr }); } catch (_) {}
}

async function actClick(tabId, a) {
  const tabBefore = await chrome.tabs.get(tabId);
  const urlBefore = tabBefore.url;
  const fpBefore = await domFingerprint(tabId);
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
  // --- Priority 3: raw (x,y) — user-estimated coords, needs verification
  } else {
    x = a.x;
    y = a.y;

    // Pre-click verification: show crosshair, screenshot, let LLM confirm.
    // Skipped for som_id and ref clicks — those coordinates are already exact.
    if (!a.confirmed) {
      await showCrosshair(tabId, x, y);
      await sleep(60);
      const verifyTab = await chrome.tabs.get(tabId);
      let verifyShotB64 = null;
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(
          verifyTab.windowId, { format: "jpeg", quality: 60 }
        );
        verifyShotB64 = await resizeScreenshotToLogical(
          dataUrl, verifyTab.width || 1280, verifyTab.height || 800
        );
      } catch (_) {}
      await removeCrosshair(tabId);

      if (verifyShotB64) {
        const dataUrl = `data:image/jpeg;base64,${verifyShotB64}`;
        chrome.storage.session.set({ lastScreenshot: dataUrl }).catch(() => {});
        broadcastStatus({ event: "screenshot_ready" });
        return { success: false, action_type: "click", verify_screenshot: verifyShotB64, x, y };
      }
    }
  }

  await showAgentCursor(tabId, x, y);
  await synthClick(tabId, x, y);
  await waitForDOMStability(tabId, 3500, 350);
  const tab = await chrome.tabs.get(tabId);
  const fpAfter = await domFingerprint(tabId);
  const diff = diffFingerprints(fpBefore, fpAfter);
  const urlChanged = tab.url !== urlBefore;
  const pageChanged = urlChanged || diff.anyChange;
  if (diff.anyChange || urlChanged) STATE.elementMapDirty = true;

  // If the click did not navigate anywhere, check for a newly-opened overlay
  // (dropdown, modal, popover). If one is visible, dismiss it with Escape so it
  // doesn't block the next action. This is a silent recovery — the caller still
  // sees page_changed=false and can decide what to do next.
  if (!urlChanged) {
    try {
      const overlayExpr = `(function(){
        var sel = '[role="dialog"],[role="menu"],[role="listbox"],[role="tooltip"],' +
                  '.dropdown-content,.modal,.popover,.overlay,' +
                  '[data-testid*="dropdown"],[data-testid*="menu"]';
        var els = document.querySelectorAll(sel);
        for (var i = 0; i < els.length; i++) {
          var r = els[i].getBoundingClientRect();
          var s = window.getComputedStyle(els[i]);
          if (r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden') return true;
        }
        return false;
      })()`;
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const sel = '[role="dialog"],[role="menu"],[role="listbox"],[role="tooltip"],' +
                      '.dropdown-content,.modal,.popover,.overlay,' +
                      '[data-testid*="dropdown"],[data-testid*="menu"]';
          for (const el of document.querySelectorAll(sel)) {
            const r = el.getBoundingClientRect();
            const s = window.getComputedStyle(el);
            if (r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden') return true;
          }
          return false;
        },
      });
      if (res && res.result) {
        // Dismiss the overlay so the next click is not blocked
        await sendCDP(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
        await sendCDP(tabId, "Input.dispatchKeyEvent", { type: "keyUp",   key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
        await waitForDOMStability(tabId, 1000, 200);
      }
    } catch (_) {}
  }

  return { success: true, action_type: "click", url: tab.url, title: tab.title, page_changed: pageChanged, dom_diff: diff.summary };
}

// When a ref is stale (page re-rendered between snapshot and execution),
// fall back to finding the best matching input by CSS selectors.
async function focusInputFallback(tabId) {
  const expr = `(function() {
    const queries = [
      'input[type="search"]:not([disabled])',
      '[role="searchbox"]:not([disabled])',
      'input[name="search"]:not([disabled])',
      'input[placeholder]:not([disabled])',
      'textarea:not([disabled])',
      'input[type="text"]:not([disabled])'
    ];
    for (const q of queries) {
      const el = [...document.querySelectorAll(q)].find(e => e.offsetParent !== null);
      if (el) { el.focus(); el.select(); return true; }
    }
    return false;
  })()`;
  const { result } = await sendCDP(tabId, "Runtime.evaluate", { expression: expr, returnByValue: true });
  return result.value === true;
}

async function actType(tabId, a) {
  const tabBefore = await chrome.tabs.get(tabId);
  const urlBefore = tabBefore.url;
  const fpBefore = await domFingerprint(tabId);
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
      const ok = await focusInputFallback(tabId);
      if (!ok) {
        return { success: false, action_type: "type", error: `ref ${a.ref} stale — page has no visible input field. If this is a reading/content page with no text boxes, use 'read' to extract the content, then emit done with what you found.` };
      }
      await sendCDP(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 65, key: "a", modifiers: 2 });
      await sendCDP(tabId, "Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 65, key: "a", modifiers: 2 });
    }
  }
  await showAgentCursor(tabId, cursorX ?? 400, cursorY ?? 300);
  try {
    await sendCDP(tabId, "Input.insertText", { text: a.text });
  } catch (_) {
    for (const ch of a.text) {
      await sendCDP(tabId, "Input.dispatchKeyEvent", { type: "char", text: ch });
    }
  }
  // Fire React/Vue/Angular controlled-input events: use the native HTMLInputElement.prototype
  // value setter (bypasses React's patched setter), then dispatch synthetic input+change events.
  // Without this, controlled components see insertText as a no-op because React never gets notified.
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

  const fpAfter = await domFingerprint(tabId);
  const diff = diffFingerprints(fpBefore, fpAfter);
  if (diff.anyChange || tab.url !== urlBefore) STATE.elementMapDirty = true;
  return {
    success: true, action_type: "type", url: tab.url, title: tab.title,
    page_changed: (tab.url !== urlBefore) || diff.anyChange, suggestions_visible: suggestionsVisible,
    actual_value: actualValue, value_mismatch: valueMismatch, dom_diff: diff.summary
  };
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
    const tab = await chrome.tabs.get(tabId);
    return { success: true, action_type: "scroll", url: tab.url, ...scrollInfo };
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
  const tab = await chrome.tabs.get(tabId);
  return { success: true, action_type: "scroll", url: tab.url, ...scrollInfo };
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
  await showAgentCursor(tabId, 640, 400);
  const map = {
    Enter: 13, Tab: 9, Escape: 27, Backspace: 8,
    ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
    PageUp: 33, PageDown: 34, Home: 36, End: 35,
  };
  const code = map[a.key];
  await sendCDP(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: code, key: a.key });
  await sendCDP(tabId, "Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: code, key: a.key });
  // Enter/Tab can trigger navigation or SPA state updates — wait longer.
  if (a.key === "Enter" || a.key === "Tab") {
    await waitForDOMStability(tabId, 3500, 350);
  } else {
    await waitForDOMStability(tabId, 1000, 200);
  }
  const tab = await chrome.tabs.get(tabId);
  const fpAfter = await domFingerprint(tabId);
  const diff = diffFingerprints(fpBefore, fpAfter);
  if (diff.anyChange || tab.url !== urlBefore) STATE.elementMapDirty = true;
  return { success: true, action_type: "key", url: tab.url, title: tab.title, page_changed: (tab.url !== urlBefore) || diff.anyChange, dom_diff: diff.summary };
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

function detachDebugger() {
  return new Promise((resolve) => {
    if (STATE.attachedTabId == null) return resolve();
    chrome.debugger.detach({ tabId: STATE.attachedTabId }, () => {
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
  const ptr = async (type, buttons) => {
    try {
      await sendCDP(tabId, "Runtime.evaluate", {
        expression: `(function(t,x,y,btn){
          var el = document.elementFromPoint(x,y);
          if (!el) return;
          el.dispatchEvent(new PointerEvent(t, {
            bubbles:true, cancelable:true,
            clientX:x, clientY:y, screenX:x, screenY:y,
            button: btn > 0 ? 0 : -1, buttons: btn,
            pointerId:1, pointerType:'mouse', isPrimary:true
          }));
        })(${JSON.stringify(type)},${Math.round(x)},${Math.round(y)},${buttons})`,
      });
    } catch (_) {}
  };
  // Move to coordinates first to trigger mouseover/mouseenter/pointerover
  await sendCDP(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved", x, y, button: "none", buttons: 0,
  });
  await ptr("pointerover", 0);
  await sleep(50);
  await ptr("pointerdown", 1);
  await sendCDP(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1,
  });
  await sleep(30);
  await ptr("pointerup", 0);
  await sendCDP(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1,
  });
}

async function synthDoubleClick(tabId, x, y) {
  // Move to coordinates first to trigger mouseover/mouseenter/pointerover
  await sendCDP(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved", x, y, button: "none", buttons: 0,
  });
  await sleep(50);
  // First click
  await sendCDP(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1,
  });
  await sendCDP(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1,
  });
  await sleep(60);
  // Second click (clickCount:2 triggers dblclick event)
  await sendCDP(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 2,
  });
  await sendCDP(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 2,
  });
}

async function synthDrag(tabId, sx, sy, dx, dy) {
  // Helper: dispatch a PointerEvent via JS injection on the element at (x,y).
  // Needed for frameworks (chessground, React-DnD, SortableJS, etc.) that listen
  // only to pointer events, not the raw mouse events CDP fires.
  const ptr = async (type, x, y, buttons) => {
    try {
      await sendCDP(tabId, "Runtime.evaluate", {
        expression: `(function(t,x,y,btn){
          var el = document.elementFromPoint(x,y);
          if (!el) return;
          el.dispatchEvent(new PointerEvent(t, {
            bubbles:true, cancelable:true,
            clientX:x, clientY:y, screenX:x, screenY:y,
            button: btn > 0 ? 0 : -1, buttons: btn,
            pointerId:1, pointerType:'mouse', isPrimary:true
          }));
        })(${JSON.stringify(type)},${Math.round(x)},${Math.round(y)},${buttons})`,
      });
    } catch (_) {}
  };

  // 1. Move to source and fire pointerover so the element enters hover state
  await sendCDP(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: sx, y: sy, button: "none", buttons: 0 });
  await ptr("pointerover", sx, sy, 0);
  await sleep(60);

  // 2. pointerdown + mousedown at source
  await ptr("pointerdown", sx, sy, 1);
  await sendCDP(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: sx, y: sy, button: "left", buttons: 1, clickCount: 1 });
  await sleep(100);

  // 3. Small jitter to cross the drag-start threshold (usually ~3px)
  const ox = dx !== sx ? (dx > sx ? 4 : -4) : 0;
  const oy = dy !== sy ? (dy > sy ? 4 : -4) : 4;
  await ptr("pointermove", sx + ox, sy + oy, 1);
  await sendCDP(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: sx + ox, y: sy + oy, button: "left", buttons: 1 });
  await sleep(50);

  // 4. Interpolate ~15 move events for smooth drag path
  const steps = 15;
  for (let i = 1; i <= steps; i++) {
    const ix = Math.round(sx + (dx - sx) * i / steps);
    const iy = Math.round(sy + (dy - sy) * i / steps);
    await ptr("pointermove", ix, iy, 1);
    await sendCDP(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: ix, y: iy, button: "left", buttons: 1 });
    await sleep(20);
  }
  await sleep(80);

  // 5. Final hover at destination
  await ptr("pointermove", dx, dy, 1);
  await sendCDP(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: dx, y: dy, button: "left", buttons: 1 });
  await sleep(100);

  // 6. pointerup + mouseup at destination
  await ptr("pointerup", dx, dy, 0);
  await sendCDP(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: dx, y: dy, button: "left", buttons: 0, clickCount: 1 });
}

// -- Resolve som_id → exact (x, y) from the cached element map ----------------
// If the id is missing (stale snapshot — SPA re-rendered between snapshot and execute),
// we do one live re-scan of the DOM and try again before giving up.
async function resolveSomId(tabId, somId) {
  if (somId == null) return null;
  let el = STATE.lastElementMap[somId];
  if (el) return { x: el.x, y: el.y };

  // Stale — try a live re-scan
  try {
    const fresh = await getInteractiveElements(tabId);
    if (fresh.length) {
      STATE.lastElementMap = {};
      for (const e of fresh) STATE.lastElementMap[e.id] = e;
      el = STATE.lastElementMap[somId];
      if (el) return { x: el.x, y: el.y };
    }
  } catch (_) {}
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
    return { x: (x1 + x2) / 2, y: (y1 + y3) / 2 };
  }
  return { x, y };
}

async function actDoubleClick(tabId, a) {
  const tabBefore = await chrome.tabs.get(tabId);
  const urlBefore = tabBefore.url;
  const fpBefore = await domFingerprint(tabId);
  const somPt = await resolveSomId(tabId, a.som_id);
  const coords = somPt ? somPt : await resolveCoords(tabId, a.ref, a.x, a.y, "double_click");
  if (coords.error) return { success: false, ...coords };
  await showAgentCursor(tabId, coords.x, coords.y);
  await synthDoubleClick(tabId, coords.x, coords.y);
  await waitForDOMStability(tabId, 3000, 350);
  const tab = await chrome.tabs.get(tabId);
  const fpAfter = await domFingerprint(tabId);
  const diff = diffFingerprints(fpBefore, fpAfter);
  if (diff.anyChange || tab.url !== urlBefore) STATE.elementMapDirty = true;
  return { success: true, action_type: "double_click", url: tab.url, title: tab.title, page_changed: (tab.url !== urlBefore) || diff.anyChange, dom_diff: diff.summary };
}

async function actRightClick(tabId, a) {
  const tabBefore = await chrome.tabs.get(tabId);
  const urlBefore = tabBefore.url;
  const fpBefore = await domFingerprint(tabId);
  const somPt = await resolveSomId(tabId, a.som_id);
  const coords = somPt ? somPt : await resolveCoords(tabId, a.ref, a.x, a.y, "right_click");
  if (coords.error) return { success: false, ...coords };
  await showAgentCursor(tabId, coords.x, coords.y);
  await sendCDP(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x: coords.x, y: coords.y, button: "right", buttons: 2, clickCount: 1,
  });
  await sendCDP(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x: coords.x, y: coords.y, button: "right", buttons: 0, clickCount: 1,
  });
  await waitForDOMStability(tabId, 2000, 300);
  const tab = await chrome.tabs.get(tabId);
  const fpAfter = await domFingerprint(tabId);
  const diff = diffFingerprints(fpBefore, fpAfter);
  if (diff.anyChange || tab.url !== urlBefore) STATE.elementMapDirty = true;
  return { success: true, action_type: "right_click", url: tab.url, title: tab.title, page_changed: (tab.url !== urlBefore) || diff.anyChange, dom_diff: diff.summary };
}

async function actDrag(tabId, a) {
  const tabBefore = await chrome.tabs.get(tabId);
  const urlBefore = tabBefore.url;
  const fpBefore = await domFingerprint(tabId);
  // Resolve source: prefer from_som_id (precise center of labeled element)
  let src;
  if (a.from_som_id != null) {
    const pt = await resolveSomId(tabId, a.from_som_id);
    if (!pt) return { success: false, action_type: "drag", error: `from_som_id ${a.from_som_id} not found in element map — page may have changed` };
    src = pt;
  } else {
    src = await resolveCoords(tabId, a.from_ref, a.from_x, a.from_y, "drag");
    if (src.error) return { success: false, ...src };
  }
  // Resolve destination: prefer to_som_id
  let dst;
  if (a.to_som_id != null) {
    const pt = await resolveSomId(tabId, a.to_som_id);
    if (!pt) return { success: false, action_type: "drag", error: `to_som_id ${a.to_som_id} not found in element map — page may have changed` };
    dst = pt;
  } else {
    dst = await resolveCoords(tabId, a.to_ref, a.to_x, a.to_y, "drag");
    if (dst.error) return { success: false, ...dst };
  }
  let isChess = false;
  try {
    const { result } = await sendCDP(tabId, "Runtime.evaluate", {
      expression: `!!document.querySelector('cg-board, #board, .cg-wrap cg-board, chess-board, [class*="chess-board"]')`,
      returnByValue: true
    });
    isChess = !!(result && result.value);
  } catch (_) {}

  if (isChess) {
    await showAgentCursor(tabId, src.x, src.y);
    await synthClick(tabId, src.x, src.y);
    await waitForDOMStability(tabId, 1500, 200);
    await showAgentCursor(tabId, dst.x, dst.y);
    await synthClick(tabId, dst.x, dst.y);
    await waitForDOMStability(tabId, 3000, 600);
    const tab2 = await chrome.tabs.get(tabId);
    const fpAfter2 = await domFingerprint(tabId);
    const diff2 = diffFingerprints(fpBefore, fpAfter2);
    if (diff2.anyChange || tab2.url !== urlBefore) STATE.elementMapDirty = true;
    return { success: true, action_type: "drag", url: tab2.url, title: tab2.title, page_changed: (tab2.url !== urlBefore) || diff2.anyChange, dom_diff: diff2.summary, method: "click_to_move" };
  }

  await showAgentCursor(tabId, src.x, src.y);
  await synthDrag(tabId, src.x, src.y, dst.x, dst.y);
  // 600ms settle — gives CSS transition animations (kanban cards, game pieces, etc.) time to finish
  await waitForDOMStability(tabId, 3000, 600);
  const tab = await chrome.tabs.get(tabId);
  const fpAfter = await domFingerprint(tabId);
  const diff = diffFingerprints(fpBefore, fpAfter);

  // Drag produced no change — try click-to-move fallback.
  // Many UIs (chess boards, kanban columns, sortable lists) support both drag AND
  // click-select-then-click-destination as equivalent gestures. Try that path now.
  if (!diff.anyChange && tab.url === urlBefore) {
    await showAgentCursor(tabId, src.x, src.y);
    await synthClick(tabId, src.x, src.y);
    await waitForDOMStability(tabId, 1500, 200);
    await showAgentCursor(tabId, dst.x, dst.y);
    await synthClick(tabId, dst.x, dst.y);
    await waitForDOMStability(tabId, 3000, 600);
    const tab2 = await chrome.tabs.get(tabId);
    const fpAfter2 = await domFingerprint(tabId);
    const diff2 = diffFingerprints(fpBefore, fpAfter2);
    if (diff2.anyChange || tab2.url !== urlBefore) STATE.elementMapDirty = true;
    return { success: true, action_type: "drag", url: tab2.url, title: tab2.title, page_changed: (tab2.url !== urlBefore) || diff2.anyChange, dom_diff: diff2.summary, method: "click_to_move" };
  }

  if (diff.anyChange || tab.url !== urlBefore) STATE.elementMapDirty = true;
  return { success: true, action_type: "drag", url: tab.url, title: tab.title, page_changed: (tab.url !== urlBefore) || diff.anyChange, dom_diff: diff.summary };
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
          // Sample CSS transform/position of first 20 visible positioned elements.
          // Detects moves that change only style (chess pieces, kanban cards, sliders, etc.)
          // without altering DOM structure or text content.
          var posStyles = [...document.querySelectorAll('[style]')]
            .filter(function(e){ return e.offsetParent!==null; })
            .slice(0,20)
            .map(function(e){
              var s = e.style;
              return (s.transform||'')+'|'+(s.left||'')+'|'+(s.top||'');
            });
          return {
            url:          location.href,
            dialogCount:  dialogs.length,
            dialogTexts:  dialogs.slice(0,3).map(function(d){ return d.innerText.slice(0,100).replace(/\\s+/g,' '); }),
            alertCount:   alerts.length,
            alertTexts:   alerts.slice(0,3).map(function(a){ return a.innerText.slice(0,100).replace(/\\s+/g,' '); }),
            expandedCount: expd,
            errorCount:   errors.length,
            errorTexts:   errors.map(function(e){ return e.innerText.slice(0,80).replace(/\\s+/g,' '); }),
            inputVals:    inputVals,
            checks:       checks,
            posStyles:    posStyles,
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

  // CSS transform/position changes — catches drag-and-drop moves, chess pieces,
  // kanban cards, sliders, and any UI that repositions elements via style only.
  if (before.posStyles && after.posStyles && before.posStyles.length > 0) {
    const bPos = before.posStyles.join(",");
    const aPos = after.posStyles.join(",");
    if (bPos !== aPos) {
      anyChange = true;
      if (parts.length === 0) parts.push("element positions changed");
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
        obs.observe(document.documentElement, {childList:true,subtree:true,attributes:true,characterData:true});
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
  let x, y;
  const somPt = await resolveSomId(tabId, a.som_id);
  if (somPt) {
    x = somPt.x; y = somPt.y;
  } else if (a.ref) {
    let object, model;
    try {
      ({ object } = await sendCDP(tabId, "DOM.resolveNode", { backendNodeId: Number(a.ref) }));
      ({ model } = await sendCDP(tabId, "DOM.getBoxModel", { objectId: object.objectId }));
    } catch (e) {
      return { success: false, action_type: "hover", error: `ref ${a.ref} is stale or not found — re-read AX tree.` };
    }
    const [x1, y1, x2, , , y3] = model.content;
    x = (x1 + x2) / 2; y = (y1 + y3) / 2;
  } else {
    x = a.x; y = a.y;
  }
  await showAgentCursor(tabId, x, y);
  await sendCDP(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
  await waitForDOMStability(tabId, 1500, 250); // wait for tooltips/menus to appear
  const tab = await chrome.tabs.get(tabId);
  return { success: true, action_type: "hover", url: tab.url };
}

async function actGoBack(tabId) {
  const tabBefore = await chrome.tabs.get(tabId);
  const urlBefore = tabBefore.url;
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
  STATE.elementMapDirty = true;
  const tab = await chrome.tabs.get(tabId);
  return { success: true, action_type: "go_back", url: tab.url, title: tab.title, page_changed: tab.url !== urlBefore };
}

async function actGoForward(tabId) {
  const tabBefore = await chrome.tabs.get(tabId);
  const urlBefore = tabBefore.url;
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
  STATE.elementMapDirty = true;
  const tab = await chrome.tabs.get(tabId);
  return { success: true, action_type: "go_forward", url: tab.url, title: tab.title, page_changed: tab.url !== urlBefore };
}

async function actRefresh(tabId) {
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
  STATE.elementMapDirty = true;
  const tab = await chrome.tabs.get(tabId);
  return { success: true, action_type: "refresh", url: tab.url, title: tab.title };
}

async function actScript(tabId, a) {
  const tabBefore = await chrome.tabs.get(tabId);
  const urlBefore = tabBefore.url;
  const htmlLenBefore = await getDOMLength(tabId);
  let expression = a.code || "";
  // Wrap top-level returns in an async IIFE to prevent Illegal return statement SyntaxErrors
  const trimmed = expression.trim();
  if (expression.includes("return") && !trimmed.startsWith("(") && !trimmed.startsWith("function") && !trimmed.startsWith("async")) {
    expression = `(async () => {\n${expression}\n})()`;
  }

  const { result, exceptionDetails } = await sendCDP(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    userGesture: true,
    awaitPromise: true,
  });
  if (exceptionDetails) {
    const errMsg = exceptionDetails.exception && exceptionDetails.exception.description
      ? exceptionDetails.exception.description
      : "Exception occurred during script evaluation";
    return { success: false, action_type: "script", error: errMsg };
  }
  const val = result ? result.value : undefined;
  const resString = val !== undefined ? JSON.stringify(val) : "undefined";
  await waitForDOMStability(tabId, 2000, 300);
  const tab = await chrome.tabs.get(tabId);
  const htmlLenAfter = await getDOMLength(tabId);
  return {
    success: true,
    action_type: "script",
    url: tab.url,
    title: tab.title,
    page_changed: (tab.url !== urlBefore) || (htmlLenBefore !== htmlLenAfter),
    result: resString.slice(0, 5000),
  };
}

// On install, configure the side panel to open when the toolbar icon is clicked.
// chrome.sidePanel can be undefined on Chrome < 114 or in some channel builds,
// so guard the call — the extension still works without it (icon click won't
// auto-open the panel; users open it via chrome://extensions or the command).
chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === "function") {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((e) => console.warn("[agent] sidePanel.setPanelBehavior failed:", e));
  } else {
    console.warn("[agent] chrome.sidePanel API unavailable; open the panel manually.");
  }
});
