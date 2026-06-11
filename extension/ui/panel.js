// panel.js — side panel UI logic.

const $ = id => document.getElementById(id);
const logEl = $("log");

let pendingDialog = null;
let ctxMax = 200000;
let taskIndex = 0;
let activeTimelineId = null;
let activeAgentMsgId = null;

// -- Port management (MV3 service workers can be killed at any time) ---------

let port = null;

function connectPort() {
  port = chrome.runtime.connect({ name: "panel" });
  port.onMessage.addListener(handlePortMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(() => {
      connectPort();
    }, 200);
  });
}

function safePostMessage(msg) {
  if (!port) connectPort();
  try {
    port.postMessage(msg);
  } catch (_) {
    port = null;
  }
}

// -- Connection status -------------------------------------------------------

function setConnDot(id, state) { $(id).className = `conn-dot ${state}`; }
function setConnVal(id, text)  { $(id).textContent = text; }

// Cloud model lists (mirrors CLOUD_MODEL_LISTS in llm.js — no import in panel context)
const CLOUD_MODEL_LISTS = {
  anthropic: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001", "claude-3-5-sonnet-latest", "claude-3-5-haiku-latest", "claude-3-opus-latest"],
  openai:    ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-4", "o1", "o1-mini", "o3-mini"],
  gemini:    ["gemini-2.5-pro-preview-06-05", "gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-1.5-pro", "gemini-1.5-flash"],
  deepseek:  ["deepseek-chat", "deepseek-reasoner"],
  xai:       ["grok-3-beta", "grok-3-mini-beta", "grok-2-vision-1212", "grok-2-1212"],
  zai:       ["z1-preview"],
};

const PROVIDER_PRESETS = {
  ollama:    { baseUrl: "http://127.0.0.1:11434/v1", needsKey: false, keyLabel: "",                       keyPlaceholder: "" },
  lmstudio:  { baseUrl: "http://127.0.0.1:1234/v1",  needsKey: false, keyLabel: "",                       keyPlaceholder: "" },
  anthropic: { baseUrl: "",                           needsKey: true,  keyLabel: "Anthropic API Key",       keyPlaceholder: "sk-ant-..." },
  openai:    { baseUrl: "",                           needsKey: true,  keyLabel: "OpenAI API Key",          keyPlaceholder: "sk-..." },
  gemini:    { baseUrl: "",                           needsKey: true,  keyLabel: "Google API Key",          keyPlaceholder: "AIza..." },
  deepseek:  { baseUrl: "",                           needsKey: true,  keyLabel: "DeepSeek API Key",        keyPlaceholder: "sk-..." },
  xai:       { baseUrl: "",                           needsKey: true,  keyLabel: "xAI API Key",             keyPlaceholder: "xai-..." },
  zai:       { baseUrl: "",                           needsKey: true,  keyLabel: "z.ai API Key",            keyPlaceholder: "..." },
  custom:    { baseUrl: "",                           needsKey: false, keyLabel: "API Key (optional)",      keyPlaceholder: "" },
};

function applyProviderUI(provider) {
  const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom;
  const isLocal = !preset.needsKey && provider !== "custom";

  // Show/hide API key field
  const keyGroup = $("apiKeyGroup");
  if (preset.needsKey || provider === "custom") {
    keyGroup.classList.remove("hidden");
    $("apiKeyLabel").textContent = preset.keyLabel || "API Key";
    $("apiKeyInput").placeholder = preset.keyPlaceholder || "";
  } else {
    keyGroup.classList.add("hidden");
  }

  // Show/hide base URL field (local + custom always show it; cloud providers don't need it)
  const urlGroup = $("baseUrlGroup");
  if (isLocal || provider === "custom") {
    urlGroup.classList.remove("hidden");
    if (preset.baseUrl && !$("baseUrlInput").value) {
      $("baseUrlInput").value = preset.baseUrl;
    }
  } else {
    urlGroup.classList.add("hidden");
  }
}

async function checkConnection() {
  setConnDot("orchDot", "ok");
  setConnVal("orchVal", "active");

  const settings = await chrome.storage.local.get({
    provider:     "ollama",
    baseUrl:      "http://127.0.0.1:11434/v1",
    apiKey:       "",
    anthropicKey: "",
    model:        "minicpm-v:8b",
  });

  // Backward compat: if old anthropicKey exists and no provider set, treat as anthropic
  const provider   = settings.provider || (settings.anthropicKey ? "anthropic" : "ollama");
  const apiKey     = settings.apiKey   || settings.anthropicKey || "";
  const cloudModels = CLOUD_MODEL_LISTS[provider];

  setConnDot("llmDot", "checking");
  setConnVal("llmVal", "checking…");

  const sel = $("modelSelect");

  try {
    if (cloudModels) {
      // Cloud provider — no network check needed, just populate hard-coded model list
      sel.innerHTML = "";
      for (const m of cloudModels) {
        const opt = document.createElement("option");
        opt.value = m; opt.textContent = m;
        if (m === settings.model) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.disabled = false;
      $("applyModelBtn").disabled = false;
      setConnDot("llmDot", apiKey ? "ok" : "warn");
      setConnVal("llmVal", apiKey ? provider.toUpperCase() : `${provider.toUpperCase()} (no key)`);
      if (!apiKey) showError(`${provider} requires an API key — open Settings and enter it.`);
      else clearError();
    } else {
      // Local provider (Ollama/LM Studio/custom) — probe the /api/tags or /models endpoint
      const base    = (settings.baseUrl || "http://127.0.0.1:11434/v1").replace(/\/v1\/?$/, "");
      const tagsUrl = base + "/api/tags";
      const resp    = await fetch(tagsUrl, { signal: AbortSignal.timeout(4000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data   = await resp.json();
      const models = (data.models && data.models.length ? data.models.map(m => m.name) : []);
      if (models.length === 0 && settings.model) models.push(settings.model);

      sel.innerHTML = "";
      for (const m of models) {
        const opt = document.createElement("option");
        opt.value = m; opt.textContent = m;
        if (m === settings.model) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.disabled = false;
      $("applyModelBtn").disabled = false;
      setConnDot("llmDot", "ok");
      setConnVal("llmVal", settings.model || models[0] || provider);
      clearError();
    }
  } catch (e) {
    setConnDot("llmDot", "bad");
    setConnVal("llmVal", "offline");
    $("modelSelect").disabled = true;
    $("applyModelBtn").disabled = true;
    if (!cloudModels) {
      showError(`Local LLM not reachable at ${settings.baseUrl}. Is ${provider === "lmstudio" ? "LM Studio" : "Ollama"} running?`);
    }
  }
}

// Poll every 8 s
setInterval(checkConnection, 8000);

// -- Settings Load/Save ------------------------------------------------------

async function loadSettings() {
  const settings = await chrome.storage.local.get({
    thinking:     false,
    provider:     "ollama",
    baseUrl:      "http://127.0.0.1:11434/v1",
    apiKey:       "",
    anthropicKey: "",
    temperature:  0.2,
    maxSteps:     100,
    uncensored:   false,
  });

  // Backward compat: migrate anthropicKey → apiKey + provider=anthropic
  const provider = settings.provider || (settings.anthropicKey && !settings.apiKey ? "anthropic" : "ollama");
  const apiKey   = settings.apiKey || settings.anthropicKey || "";

  const provSel = $("providerSelect");
  if (provSel) provSel.value = provider;

  $("baseUrlInput").value  = settings.baseUrl;
  $("apiKeyInput").value   = apiKey;
  $("tempInput").value     = settings.temperature;
  $("maxStepsInput").value = settings.maxSteps;
  $("uncensoredCheck").checked = settings.uncensored;
  if ($("thinkingCheck")) $("thinkingCheck").checked = settings.thinking;

  applyProviderUI(provider);
}

$("saveSettingsBtn").addEventListener("click", async () => {
  const provider    = ($("providerSelect") ? $("providerSelect").value : "ollama") || "ollama";
  const preset      = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom;
  const baseUrl     = preset.needsKey && provider !== "custom"
    ? (PROVIDER_PRESETS[provider]?.baseUrl || $("baseUrlInput").value.trim())
    : $("baseUrlInput").value.trim();
  const apiKey      = $("apiKeyInput").value.trim();
  const temperature = parseFloat($("tempInput").value);
  const maxSteps    = parseInt($("maxStepsInput").value, 10);
  const uncensored  = $("uncensoredCheck").checked;
  const thinking    = $("thinkingCheck") ? $("thinkingCheck").checked : false;

  try {
    await chrome.storage.local.set({ provider, baseUrl, apiKey, temperature, maxSteps, uncensored, thinking });
    $("settingsStatus").textContent = "Settings saved";
    $("settingsStatus").className   = "status-line ok";
    safePostMessage({ type: "update_config" });
    setTimeout(() => { $("settingsStatus").textContent = ""; }, 2500);
    await checkConnection();
  } catch (e) {
    $("settingsStatus").textContent = `Save failed: ${e.message}`;
    $("settingsStatus").className   = "status-line bad";
  }
});

if ($("downloadLogsBtn")) {
  $("downloadLogsBtn").addEventListener("click", async () => {
    try {
      const data = await chrome.storage.local.get({ auditLogs: [] });
      const logs = data.auditLogs;
      
      const blob = new Blob([JSON.stringify(logs, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `navy_debug_logs_${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(`Export failed: ${e.message}`);
    }
  });
}

// Live provider selector: update UI immediately when user switches provider
if ($("providerSelect")) {
  $("providerSelect").addEventListener("change", (e) => {
    const p = e.target.value;
    applyProviderUI(p);
    // Auto-fill base URL for local providers
    const preset = PROVIDER_PRESETS[p];
    if (preset && preset.baseUrl && !preset.needsKey) {
      $("baseUrlInput").value = preset.baseUrl;
    }
  });
}

// -- Error banner ------------------------------------------------------------

function showError(msg) {
  const b = $("errorBanner");
  b.textContent = msg;
  b.classList.remove("hidden");
}
function clearError() { $("errorBanner").classList.add("hidden"); }

// -- Screenshot strip management ---------------------------------------------
const lastScreenshots = [];

function addToScreenshotStrip(url) {
  if (lastScreenshots.includes(url)) return;
  lastScreenshots.push(url);
  if (lastScreenshots.length > 3) {
    lastScreenshots.shift();
  }
  renderScreenshotStrip();
}

function renderScreenshotStrip() {
  const strip = $("screenshotStrip");
  strip.innerHTML = "";
  if (lastScreenshots.length === 0) {
    strip.classList.add("hidden");
    return;
  }
  strip.classList.remove("hidden");
  for (const url of lastScreenshots) {
    const img = document.createElement("img");
    img.src = url;
    img.title = "Click to enlarge";
    img.style.height = "60px";
    img.style.borderRadius = "3px";
    img.style.border = "1px solid var(--line)";
    img.style.cursor = "zoom-in";
    img.style.opacity = "0.85";
    img.style.transition = "opacity 0.15s, border-color 0.15s";
    img.addEventListener("click", () => window.open(url, "_blank"));
    strip.appendChild(img);
  }
}

// -- Context window ----------------------------------------------------------

function updateCtx(tokensUsed, tokensMax, step, stepsMax, activeSubtaskIdx, subtasksLen) {
  if (tokensMax) ctxMax = tokensMax;
  const pct = Math.min(100, (tokensUsed / ctxMax) * 100);
  const bar = $("ctxBar");
  bar.style.width = `${pct}%`;
  bar.className = "ctx-bar" + (pct > 85 ? " danger" : pct > 60 ? " warn" : "");
  $("ctxLabel").textContent =
    `${tokensUsed.toLocaleString()} / ${ctxMax.toLocaleString()} tokens`;
  $("ctxSteps").textContent = `step ${step} / ${stepsMax || 100}`;
  $("ctxSection").classList.remove("hidden");

  const subtaskRow = $("subtaskProgressRow");
  if (subtasksLen && subtasksLen > 0) {
    subtaskRow.classList.remove("hidden");
    const subPct = Math.min(100, (activeSubtaskIdx / subtasksLen) * 100);
    $("subtaskBar").style.width = `${subPct}%`;
    $("subtaskLabel").textContent = `Subtasks: ${activeSubtaskIdx} / ${subtasksLen}`;
  } else {
    subtaskRow.classList.add("hidden");
  }
}

function resetCtx() {
  $("ctxBar").style.width = "0%";
  $("ctxBar").className = "ctx-bar";
  $("ctxLabel").textContent = "0 / 200 000 tokens";
  $("ctxSteps").textContent = "step 0 / 100";
  $("ctxSection").classList.add("hidden");

  $("subtaskBar").style.width = "0%";
  $("subtaskLabel").textContent = "Subtasks: 0 / 0";
  $("subtaskProgressRow").classList.add("hidden");

  lastScreenshots.length = 0;
  renderScreenshotStrip();
  $("copyResultBtn").classList.add("hidden");
}

// -- Tab status --------------------------------------------------------------

const RESTRICTED_PREFIXES = [
  "chrome://", "chrome-extension://", "chrome-search://", "chrome-devtools://",
  "devtools://", "edge://", "brave://", "opera://", "vivaldi://",
  "about:", "view-source:", "file://",
  "https://chrome.google.com/webstore", "https://chromewebstore.google.com",
];

function isRestrictedUrl(url) {
  if (!url) return true;
  const lo = url.toLowerCase();
  return RESTRICTED_PREFIXES.some(p => lo.startsWith(p));
}

async function refreshTabStatus() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) { setStatus("currentTab", "warn", "no active tab"); return; }
    if (isRestrictedUrl(tab.url)) {
      setStatus("currentTab", "bad",
        `cannot run on ${tab.url} — switch to a normal tab`);
    } else {
      setStatus("currentTab", "ok", `ready: ${tab.url}`);
    }
  } catch (_) {}
}

// -- Log helpers -------------------------------------------------------------

function logEntry(kind, tag, text, badge = "") {
  // If it's the User's goal, start a new chat turn
  if (tag === "GOAL") {
    taskIndex++;
    activeTimelineId = `timeline-${taskIndex}`;
    activeAgentMsgId = `agentMsg-${taskIndex}`;

    // Append User Message Bubble
    const userBubble = document.createElement("div");
    userBubble.className = "chat-bubble user-message";
    userBubble.innerHTML = `<div class="bubble-content">${escapeHtml(text)}</div>`;
    logEl.appendChild(userBubble);

    // Append Agent Response Card
    const agentBubble = document.createElement("div");
    agentBubble.className = "chat-bubble agent-message";
    agentBubble.id = activeAgentMsgId;
    agentBubble.innerHTML = `
      <div class="agent-header">
        <svg class="working-spinner" viewBox="0 0 24 24" width="16" height="16">
          <path d="M12,2 L14,7 L19,6 L17,11 L22,12 L17,13 L19,18 L14,17 L12,22 L10,17 L5,18 L7,13 L2,12 L7,11 L5,6 L10,7 Z" fill="var(--accent-aqua)" />
        </svg>
        <span class="working-text">Working</span>
      </div>
      <div class="timeline" id="${activeTimelineId}"></div>
    `;
    logEl.appendChild(agentBubble);
    logEl.parentElement.scrollTop = logEl.parentElement.scrollHeight;
    return;
  }

  // Ensure activeTimelineId exists
  if (!activeTimelineId) {
    taskIndex++;
    activeTimelineId = `timeline-${taskIndex}`;
    activeAgentMsgId = `agentMsg-${taskIndex}`;
    const agentBubble = document.createElement("div");
    agentBubble.className = "chat-bubble agent-message";
    agentBubble.id = activeAgentMsgId;
    agentBubble.innerHTML = `<div class="timeline" id="${activeTimelineId}"></div>`;
    logEl.appendChild(agentBubble);
  }

  const timeline = $(activeTimelineId);
  if (!timeline) return;

  // Render system/metadata tags with a subtle look
  if (["INIT", "TAB", "START", "MODEL"].includes(tag)) {
    const sysNode = document.createElement("div");
    sysNode.className = "timeline-system";
    sysNode.innerHTML = `<span class="sys-tag">[${tag}]</span> ${escapeHtml(text)}`;
    timeline.appendChild(sysNode);
    logEl.parentElement.scrollTop = logEl.parentElement.scrollHeight;
    return;
  }

  // Render timeline steps
  const step = document.createElement("div");
  step.className = `timeline-step ${kind}`;

  // Pick suitable icon based on details
  let icon = "○";
  if (tag.startsWith("STEP")) icon = "✦";
  if (kind === "act") icon = "⚡";
  if (kind === "ok") icon = "✓";
  if (kind === "bad") icon = "✗";
  if (kind === "warn" || tag === "GATE" || tag === "ASK") icon = "⚠";

  const badgeHtml = badge ? `<span class="step-badge">${escapeHtml(badge)}</span>` : "";
  step.innerHTML = `
    <span class="step-icon">${icon}</span>
    <div class="step-details">
      <span class="step-title">${tag}</span>
      <div class="step-desc">${badgeHtml}${escapeHtml(text)}</div>
    </div>
  `;
  timeline.appendChild(step);
  logEl.parentElement.scrollTop = logEl.parentElement.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function setStatus(id, kind, text) {
  const el = $(id);
  if (el) {
    el.className = `status-line ${kind || ""}`.trim();
    el.textContent = text;
  }
}

// -- Header status dot -------------------------------------------------------

function setDot(live, danger) {
  const dot = $("statusDot");
  if (dot) {
    dot.classList.toggle("live", !!live);
    dot.classList.toggle("danger", !!danger);
  }
}

// -- Button wiring -----------------------------------------------------------

$("refreshBtn").addEventListener("click", checkConnection);

if ($("modelSelect")) {
  $("modelSelect").addEventListener("change", async () => {
    const model = $("modelSelect").value;
    if (!model) return;
    try {
      await chrome.storage.local.set({ model });
      setConnVal("llmVal", model);
      logEntry("ok", "MODEL", `switched to ${model}`);
      safePostMessage({ type: "update_config" });
      clearError();
    } catch (e) {
      showError(`Failed to set model: ${e.message}`);
    }
  });
}

$("applyModelBtn").addEventListener("click", async () => {
  const model = $("modelSelect").value;
  if (!model) return;
  $("applyModelBtn").disabled = true;
  try {
    await chrome.storage.local.set({ model });
    setConnVal("llmVal", model);
    logEntry("ok", "MODEL", `switched to ${model}`);
    safePostMessage({ type: "update_config" });
    clearError();
  } catch (e) {
    showError(`Failed to set model: ${e.message}`);
    logEntry("bad", "ERR", `model switch failed: ${e.message}`);
  } finally {
    $("applyModelBtn").disabled = false;
  }
});

$("runBtn").addEventListener("click", async () => {
  const goal = $("goalInput").value.trim();
  if (!goal) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { logEntry("bad", "ERR", "no active tab"); return; }
  const autoApprove = $("autoApproveCheck").checked;
  clearError();
  resetCtx();
  logEntry("info", "GOAL", goal);
  logEntry("info", "TAB", `${tab.title || ""}  ${tab.url || ""}`);
  if (autoApprove) logEntry("warn", "AUTO", "auto-approve ON — all actions run without confirmation");
  logEntry("info", "INIT", "attaching debugger and starting planning loop…");
  safePostMessage({ type: "start_task", goal, tabId: tab.id, autoApprove });
  $("goalInput").value = "";
});

$("goalInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (!$("runBtn").classList.contains("hidden")) {
      $("runBtn").click();
    }
  }
});

$("stopBtn").addEventListener("click", () => safePostMessage({ type: "cancel_task" }));

if ($("autoApproveSelect")) {
  $("autoApproveSelect").addEventListener("change", (e) => {
    $("autoApproveCheck").checked = (e.target.value === "auto");
  });
}

$("copyResultBtn").addEventListener("click", () => {
  const text = $("copyResultBtn").dataset.resultText;
  if (text) {
    navigator.clipboard.writeText(text).then(() => {
      const oldText = $("copyResultBtn").textContent;
      $("copyResultBtn").textContent = "Copied!";
      setTimeout(() => {
        $("copyResultBtn").textContent = oldText;
      }, 1500);
    }).catch(err => {
      console.error("Failed to copy text: ", err);
    });
  }
});

$("dialogYes").addEventListener("click", () => respondDialog(true));
$("dialogNo").addEventListener("click",  () => respondDialog(false));

// -- Dialogs -----------------------------------------------------------------

function showConfirmDialog(rid, prompt) {
  pendingDialog = { rid, kind: "confirm" };
  $("dialogTitle").textContent = "New permissions required";
  $("dialogBody").textContent = prompt;
  $("dialogInput").classList.add("hidden");
  
  const yesBtn = $("dialogYes");
  const noBtn = $("dialogNo");
  if (yesBtn.classList.contains("dialog-yes-btn")) {
    yesBtn.innerHTML = `Allow this action <span>↵</span>`;
    noBtn.innerHTML = `Decline <span>ESC</span>`;
  } else {
    yesBtn.textContent = "Allow this action";
    noBtn.textContent = "Decline";
  }
  $("dialog").classList.remove("hidden");
}

function showVerifyDialog(rid, observation, verified) {
  pendingDialog = { rid, kind: "confirm" };
  $("dialogTitle").textContent = verified ? "Step verified — continue?" : "⚠ Verification issue";
  $("dialogBody").textContent  = observation;
  $("dialogInput").classList.add("hidden");

  const yesBtn = $("dialogYes");
  const noBtn  = $("dialogNo");
  yesBtn.innerHTML = verified
    ? `Continue <span>↵</span>`
    : `Continue anyway <span>↵</span>`;
  noBtn.innerHTML = `Stop task <span>ESC</span>`;
  $("dialog").classList.remove("hidden");
}

function showAnswerDialog(rid, question) {
  pendingDialog = { rid, kind: "answer" };
  $("dialogTitle").textContent = "Navy needs input";
  $("dialogBody").textContent = question;
  $("dialogInput").value = "";
  $("dialogInput").classList.remove("hidden");
  
  const yesBtn = $("dialogYes");
  const noBtn = $("dialogNo");
  if (yesBtn.classList.contains("dialog-yes-btn")) {
    yesBtn.innerHTML = `Send <span>↵</span>`;
    noBtn.innerHTML = `Cancel <span>ESC</span>`;
  } else {
    yesBtn.textContent = "Send";
    noBtn.textContent = "Cancel";
  }
  $("dialog").classList.remove("hidden");
  $("dialogInput").focus();
}

function respondDialog(yes) {
  if (!pendingDialog) return;
  const { rid, kind } = pendingDialog;
  $("dialog").classList.add("hidden");
  if (kind === "confirm") {
    safePostMessage({
      type: "confirm_response",
      payload: { type: "user_confirm_response", rid, ok: yes },
    });
    logEntry(yes ? "ok" : "bad", yes ? "ALLOWED" : "DENIED",
      yes ? "action granted" : "action denied");
  } else {
    const text = yes ? $("dialogInput").value : "";
    safePostMessage({
      type: "answer_response",
      payload: { type: "user_answer_response", rid, text },
    });
    logEntry(yes ? "info" : "warn", "ANSWER", yes ? "input sent" : "cancelled");
  }
  pendingDialog = null;
}

// -- Keyboard shortcuts for active dialogs --
document.addEventListener("keydown", (e) => {
  if (pendingDialog) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      respondDialog(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      respondDialog(false);
    }
  }
});

// -- Messages from background.js ---------------------------------------------

function handlePortMessage(msg) {
  switch (msg.type) {
    case "status":
      if (msg.running) {
        setDot(true, false);
        setStatus("currentTab", "ok", `task running: ${msg.goal || ""}`);
        $("runBtn").classList.add("hidden");
        $("stopBtn").classList.remove("hidden");
      } else {
        $("runBtn").classList.remove("hidden");
        $("stopBtn").classList.add("hidden");
      }
      break;
    case "error":
      showError(msg.message || JSON.stringify(msg));
      logEntry("bad", "ERR", msg.message || JSON.stringify(msg));
      break;
    default:
      handleEvent(msg);
  }
}

function handleEvent(evt) {
  switch (evt.event) {
    case "started":
      setDot(true, false);
      setStatus("currentTab", "ok", "task running");
      $("runBtn").classList.add("hidden");
      $("stopBtn").classList.remove("hidden");
      logEntry("info", "START", evt.goal);
      clearError();
      break;

    case "progress": {
      let thought = evt.thought || "";
      let badge = "";
      const m = thought.match(/\s+\[([a-z_]+)\]$/i);
      if (m) {
        badge = `[${m[1].toUpperCase()}] `;
        thought = thought.substring(0, m.index);
      }

      if (evt.kind === "act") {
        logEntry("act", `STEP ${evt.step}`, thought, badge);
      } else if (evt.kind === "verify") {
        // Verification phase — show inline in timeline with distinct icon
        const ok = thought.startsWith("✓");
        logEntry(ok ? "ok" : "warn", "VERIFY", thought);
      } else if (evt.kind === "plan") {
        logEntry("plan", `PLAN`, thought);
      } else if (evt.kind === "auto") {
        logEntry("auto", `AUTO`, thought);
      } else if (evt.kind === "warn") {
        logEntry("warn", `WARN`, thought);
      } else {
        logEntry(evt.kind === "think" ? "think" : evt.kind || "info", `STEP ${evt.step}`, thought, badge);
      }
      if (evt.tokens_used !== undefined) {
        updateCtx(evt.tokens_used, evt.tokens_max || ctxMax, evt.step, evt.steps_max || 100, evt.active_subtask_idx, evt.subtasks_len);
      }
      break;
    }

    case "confirm_request":
      logEntry("warn", "GATE", "agent needs confirmation");
      showConfirmDialog(evt.rid, evt.prompt);
      break;

    case "verify_request":
      // Post-action awaiting_approval: show verification result + Continue? prompt
      logEntry(evt.verified ? "ok" : "warn", "VERIFY", evt.observation);
      showVerifyDialog(evt.rid, evt.observation, evt.verified);
      break;

    case "answer_request":
      logEntry("warn", "ASK", evt.question);
      showAnswerDialog(evt.rid, evt.question);
      break;

    case "done": {
      setDot(false, false);
      
      const activeMsg = $(activeAgentMsgId);
      if (activeMsg) {
        const spinner = activeMsg.querySelector(".working-spinner");
        if (spinner) spinner.style.display = "none";
        const textEl = activeMsg.querySelector(".working-text");
        if (textEl) textEl.textContent = "Finished";
      }

      $("runBtn").classList.remove("hidden");
      $("stopBtn").classList.add("hidden");

      const r = evt.result;
      if (r.success) {
        logEntry("ok", "DONE", r.summary || r.reason);
        if (r.finalAnswer) logEntry("ok", "RESULT", r.finalAnswer);
        setStatus("currentTab", "ok",
          `done — ${r.stepsTaken} steps, ${parseFloat(r.elapsedSeconds).toFixed(1)}s`);
        
        $("copyResultBtn").classList.remove("hidden");
        $("copyResultBtn").dataset.resultText = r.finalAnswer || r.summary || r.reason || "Success";
      } else {
        logEntry("bad", "FAIL", r.reason);
        setStatus("currentTab", "bad", `failed — ${r.reason}`);
        showError(`Task failed: ${r.reason}`);
      }
      break;
    }

    case "panic": {
      setDot(false, true);

      const activeMsg = $(activeAgentMsgId);
      if (activeMsg) {
        const spinner = activeMsg.querySelector(".working-spinner");
        if (spinner) spinner.style.display = "none";
        const textEl = activeMsg.querySelector(".working-text");
        if (textEl) textEl.textContent = "Stopped";
      }

      $("runBtn").classList.remove("hidden");
      $("stopBtn").classList.add("hidden");

      logEntry("bad", "PANIC", evt.reason);
      setStatus("currentTab", "bad", `STOPPED — ${evt.reason}`);
      setTimeout(() => setDot(false, false), 2000);
      break;
    }

    case "closed": {
      setDot(false, false);

      const activeMsg = $(activeAgentMsgId);
      if (activeMsg) {
        const spinner = activeMsg.querySelector(".working-spinner");
        if (spinner) spinner.style.display = "none";
        const textEl = activeMsg.querySelector(".working-text");
        if (textEl) textEl.textContent = "Closed";
      }

      $("runBtn").classList.remove("hidden");
      $("stopBtn").classList.add("hidden");
      break;
    }

    case "screenshot_ready": {
      chrome.storage.session.get("lastScreenshot").then(({ lastScreenshot }) => {
        if (!lastScreenshot) return;
        
        const timeline = $(activeTimelineId);
        if (timeline) {
          const row = document.createElement("div");
          row.className = "timeline-screenshot-row";
          row.innerHTML = `
            <span class="screenshot-icon">📷</span>
            <div class="screenshot-details">
              <span class="screenshot-label">Take screenshot</span>
              <img src="${lastScreenshot}" class="timeline-screenshot-thumb" title="Click to enlarge">
            </div>
          `;
          row.querySelector("img").addEventListener("click", () => window.open(lastScreenshot, "_blank"));
          timeline.appendChild(row);
        } else {
          const img = document.createElement("img");
          img.src = lastScreenshot;
          img.className = "log-screenshot";
          img.addEventListener("click", () => window.open(lastScreenshot, "_blank"));
          logEl.appendChild(img);
        }
        logEl.parentElement.scrollTop = logEl.parentElement.scrollHeight;

        addToScreenshotStrip(lastScreenshot);
      }).catch(() => {});
      break;
    }

    case "error":
      showError(evt.message);
      logEntry("bad", "ERR", evt.message);
      break;
  }
}

// -- Advanced toggle ---------------------------------------------------------

$("advancedToggle").addEventListener("click", (e) => {
  e.preventDefault();
  const panel = $("setupPanel");
  panel.classList.toggle("hidden");
  $("advancedToggle").textContent = panel.classList.contains("hidden")
    ? "Advanced settings" : "Hide advanced";
});

if ($("closeSettingsBtn")) {
  $("closeSettingsBtn").addEventListener("click", () => {
    $("setupPanel").classList.add("hidden");
    $("advancedToggle").textContent = "Advanced settings";
  });
}

// -- Chat history persistence -------------------------------------------------
// Saves the rendered chat log to session storage so it survives panel close/reopen.
// Uses a MutationObserver + debounce — no changes to logEntry() needed.

const CHAT_STORAGE_KEY = "navyChatLog";
let chatSaveTimer = null;

function saveChatHistory() {
  chrome.storage.session.set({ [CHAT_STORAGE_KEY]: logEl.innerHTML }).catch(() => {});
}

function debouncedSave() {
  clearTimeout(chatSaveTimer);
  chatSaveTimer = setTimeout(saveChatHistory, 600);
}

async function restoreChatHistory() {
  try {
    const data = await chrome.storage.session.get(CHAT_STORAGE_KEY);
    const html = data[CHAT_STORAGE_KEY];
    if (!html) return;

    logEl.innerHTML = html;
    logEl.parentElement.scrollTop = logEl.parentElement.scrollHeight;

    // Re-wire screenshot click-to-enlarge (event listeners don't survive innerHTML)
    logEl.querySelectorAll("img.timeline-screenshot-thumb, img.log-screenshot").forEach(img => {
      img.addEventListener("click", () => window.open(img.src, "_blank"));
    });

    // Restore taskIndex so the next task gets a unique timeline ID
    const timelines = [...logEl.querySelectorAll("[id^='timeline-']")];
    if (timelines.length > 0) {
      const ids = timelines.map(el => parseInt(el.id.replace("timeline-", ""), 10)).filter(n => !isNaN(n));
      if (ids.length) taskIndex = Math.max(...ids);
    }
  } catch (_) {}
}

// -- Init --------------------------------------------------------------------

connectPort();
loadSettings().then(() => checkConnection());
restoreChatHistory().then(() => {
  // Start observing AFTER restore so the initial innerHTML set doesn't trigger a save
  const observer = new MutationObserver(debouncedSave);
  observer.observe(logEl, { childList: true, subtree: true, characterData: true });
});
refreshTabStatus();
chrome.tabs.onActivated.addListener(refreshTabStatus);
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url || info.status === "complete") refreshTabStatus();
});
