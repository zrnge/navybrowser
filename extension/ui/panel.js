// panel.js — side panel UI logic.

const $ = id => document.getElementById(id);
const logEl = $("log");

let pendingDialog = null;
let ctxMax = 200000;
let taskIndex = 0;
let activeTimelineId = null;
let activeAgentMsgId = null;
let streamEntry = null;   // active streaming timeline element
let streamBuffer = "";
let suppressNextPanicLog = false;

let attachedTabId = null;
let currentTabId = null;
let isTaskRunning = false;
let taskTabGroupId = null;
let currentTabGroupId = null;

// Guard that suppresses the overlay briefly after connecting so the background's
// forced tab-switch (chrome.tabs.update) has time to complete and fire onActivated
// before we evaluate currentTabId vs attachedTabId.
let overlayGuarded = false;
let overlayGuardTimer = null;

function armOverlayGuard(ms = 350) {
  // Don't reset the timer if already guarded — repeated connectPort reconnects (MV3 service
  // worker restart storms) would otherwise keep rescheduling the timer and hold overlayGuarded
  // permanently true, hiding legitimate wrong-tab warnings.
  if (overlayGuarded) return;
  overlayGuarded = true;
  overlayGuardTimer = setTimeout(() => {
    overlayGuarded = false;
    overlayGuardTimer = null;
    checkTabOverlay();
  }, ms);
}

// -- Port management (MV3 service workers can be killed at any time) ---------

let port = null;
let reconnectTimeout = null;

function connectPort() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  if (port) return;
  armOverlayGuard();

  try {
    port = chrome.runtime.connect({ name: "panel" });
    port.onMessage.addListener(handlePortMessage);
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab) {
        currentTabId = tab.id;
        checkTabOverlay();
        if (port) {
          port.postMessage({ type: "panel_init", windowId: tab.windowId, tabId: tab.id });
        }
      }
    }).catch(() => {});
    port.onDisconnect.addListener(() => {
      port = null;
      if (!reconnectTimeout) {
        reconnectTimeout = setTimeout(connectPort, 200);
      }
    });
  } catch (e) {
    console.error("Failed to connect port:", e);
  }
}

function safePostMessage(msg) {
  if (!port) {
    connectPort();
  }
  try {
    port.postMessage(msg);
  } catch (_) {
    port = null;
  }
}

// -- Connection status -------------------------------------------------------

function setConnDot(id, state) { $(id).className = `conn-dot ${state}`; }
function setConnVal(id, text)  { $(id).textContent = text; }

// Fallback model lists — used only when live fetch fails
const CLOUD_MODEL_LISTS = {
  anthropic:  ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001", "claude-3-5-sonnet-latest", "claude-3-5-haiku-latest", "claude-3-opus-latest"],
  openai:     ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-4", "o1", "o1-mini", "o3-mini"],
  gemini:     ["gemini-2.0-flash", "gemini-2.5-flash-preview-05-20", "gemini-2.5-pro-exp-03-25", "gemini-2.0-flash-lite", "gemini-1.5-pro", "gemini-1.5-flash"],
  deepseek:   ["deepseek-chat", "deepseek-reasoner"],
  xai:        ["grok-3-beta", "grok-3-mini-beta", "grok-2-vision-1212", "grok-2-1212"],
  zai:        ["z1-preview"],
  groq:       ["llama-3.3-70b-versatile", "llama-3.1-70b-versatile", "llama-3.1-8b-instant", "llama3-70b-8192", "llama3-8b-8192", "mixtral-8x7b-32768", "gemma2-9b-it", "compound-beta", "compound-beta-mini"],
  // openrouter: fetched live
};

const PROVIDER_PRESETS = {
  ollama:     { baseUrl: "http://127.0.0.1:11434/v1",    needsKey: false, keyLabel: "",                        keyPlaceholder: "" },
  lmstudio:   { baseUrl: "http://127.0.0.1:1234/v1",     needsKey: false, keyLabel: "",                        keyPlaceholder: "" },
  anthropic:  { baseUrl: "https://api.anthropic.com",                                label: "Anthropic Claude",  needsKey: true,  keyLabel: "Anthropic API Key",        keyPlaceholder: "sk-ant-..." },
  openai:     { baseUrl: "https://api.openai.com/v1",                                label: "OpenAI / ChatGPT",  needsKey: true,  keyLabel: "OpenAI API Key",           keyPlaceholder: "sk-..." },
  gemini:     { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/", label: "Google Gemini",     needsKey: true,  keyLabel: "Google API Key",           keyPlaceholder: "AIza..." },
  deepseek:   { baseUrl: "https://api.deepseek.com/v1",                             label: "DeepSeek",          needsKey: true,  keyLabel: "DeepSeek API Key",         keyPlaceholder: "sk-..." },
  xai:        { baseUrl: "https://api.x.ai/v1",                                     label: "xAI / Grok",        needsKey: true,  keyLabel: "xAI API Key",              keyPlaceholder: "xai-..." },
  zai:        { baseUrl: "https://api.z.ai/v1",                                     label: "z.ai",              needsKey: true,  keyLabel: "z.ai API Key",             keyPlaceholder: "..." },
  groq:       { baseUrl: "https://api.groq.com/openai/v1", needsKey: true,  keyLabel: "Groq API Key",             keyPlaceholder: "gsk_..." },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", needsKey: true,  keyLabel: "OpenRouter API Key",       keyPlaceholder: "sk-or-..." },
  custom:     { baseUrl: "",                              needsKey: false, keyLabel: "API Key (optional)",       keyPlaceholder: "" },
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

// Fetch model list live from a provider's /models endpoint.
// Returns sorted array of model IDs, or throws on error.
async function fetchProviderModels(provider, apiKey) {
  const preset = PROVIDER_PRESETS[provider];
  if (!preset?.baseUrl) throw new Error("no base URL");

  const baseUrl = preset.baseUrl.replace(/\/$/, "");
  const headers = {};
  let url;

  if (provider === "anthropic") {
    url = `${baseUrl}/models`;
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-dangerous-direct-browser-access"] = "true";
  } else {
    url = `${baseUrl}/models`;
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();

  let models = (data.data || []).map(m => m.id).filter(Boolean);

  // Filter out non-chat model types per provider
  if (provider === "openai") {
    const exclude = ["text-embedding", "whisper", "tts-", "dall-e", "babbage", "davinci-002", "ada-002"];
    models = models.filter(id => !exclude.some(p => id.startsWith(p)));
  } else if (provider === "groq") {
    models = models.filter(id => !id.startsWith("whisper") && !id.startsWith("distil-whisper"));
  } else if (provider === "gemini") {
    models = models.filter(id => id.startsWith("gemini"));
  }

  return models.sort();
}

async function checkConnection(forceFetchModels = false) {
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
  const provider = settings.provider || (settings.anthropicKey ? "anthropic" : "ollama");
  const apiKey   = settings.apiKey   || settings.anthropicKey || "";

  const sel = $("modelSelect");
  const needsFetch = forceFetchModels || sel.options.length <= 1;

  if (needsFetch) {
    setConnDot("llmDot", "checking");
    setConnVal("llmVal", "checking…");
  }

  function populateModelSelect(models, savedModel) {
    sel.innerHTML = "";
    // Ensure the saved model is always present even if not in fetched list
    const list = models.includes(savedModel) || !savedModel ? models : [savedModel, ...models];
    for (const m of list) {
      const opt = document.createElement("option");
      opt.value = m; opt.textContent = m;
      if (m === savedModel) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.disabled = false;
    $("applyModelBtn").disabled = false;
  }

  try {
    if (!needsFetch) {
      // Light status check only
      if (PROVIDER_PRESETS[provider]?.needsKey || provider === "openrouter") {
        if (!apiKey) {
          setConnDot("llmDot", "warn");
          setConnVal("llmVal", `${provider.toUpperCase()} (no key)`);
        } else {
          setConnDot("llmDot", "ok");
          setConnVal("llmVal", settings.model || provider.toUpperCase());
        }
      } else {
        const base = (settings.baseUrl || "http://127.0.0.1:11434/v1").replace(/\/v1\/?$/, "");
        const resp = await fetch(base + "/api/tags", { method: "HEAD", signal: AbortSignal.timeout(2000) }).catch(() => fetch(base, { method: "HEAD", signal: AbortSignal.timeout(2000) }));
        if (!resp.ok && resp.status !== 404 && resp.status !== 405) throw new Error(`HTTP ${resp.status}`);
        setConnDot("llmDot", "ok");
        setConnVal("llmVal", settings.model || provider);
      }
      clearError();
      return;
    }

    if (provider === "openrouter") {
      // OpenRouter — fetch live model list from their API (no auth needed for model list)
      if (!apiKey) {
        populateModelSelect(["openai/gpt-4o", "openai/gpt-4o-mini", "anthropic/claude-sonnet-4-6", "anthropic/claude-haiku-4-5", "google/gemini-2.0-flash", "meta-llama/llama-3.1-70b-instruct", "deepseek/deepseek-chat"], settings.model);
        setConnDot("llmDot", "warn");
        setConnVal("llmVal", "OpenRouter (no key)");
        showError("OpenRouter requires an API key — open Settings and enter it.");
      } else {
        try {
          const resp = await fetch("https://openrouter.ai/api/v1/models", {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(6000),
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const data = await resp.json();
          const models = (data.data || [])
            .filter(m => m.id)
            .map(m => m.id)
            .sort();
          populateModelSelect(models.length ? models : ["openai/gpt-4o"], settings.model);
        } catch (_) {
          // Fallback to popular models if fetch fails
          populateModelSelect(["openai/gpt-4o", "openai/gpt-4o-mini", "anthropic/claude-sonnet-4-6", "anthropic/claude-haiku-4-5", "google/gemini-2.0-flash", "meta-llama/llama-3.1-70b-instruct", "deepseek/deepseek-chat"], settings.model);
        }
        setConnDot("llmDot", "ok");
        setConnVal("llmVal", "OpenRouter");
        clearError();
      }
    } else if (PROVIDER_PRESETS[provider]?.needsKey) {
      // Cloud provider — fetch models live, fall back to hardcoded list on failure
      const fallback = CLOUD_MODEL_LISTS[provider] || (settings.model ? [settings.model] : []);
      if (!apiKey) {
        populateModelSelect(fallback, settings.model);
        setConnDot("llmDot", "warn");
        setConnVal("llmVal", `${provider.toUpperCase()} (no key)`);
        showError(`${provider} requires an API key — open Settings and enter it.`);
      } else {
        setConnVal("llmVal", "fetching models…");
        let models = fallback;
        try {
          const fetched = await fetchProviderModels(provider, apiKey);
          if (fetched.length) models = fetched;
        } catch (_) { /* silently use fallback */ }
        populateModelSelect(models, settings.model);
        setConnDot("llmDot", "ok");
        setConnVal("llmVal", provider.toUpperCase());
        clearError();
      }
    } else {
      // Local / custom provider — probe the /api/tags or /models endpoint
      const base    = (settings.baseUrl || "http://127.0.0.1:11434/v1").replace(/\/v1\/?$/, "");
      const tagsUrl = base + "/api/tags";
      const resp    = await fetch(tagsUrl, { signal: AbortSignal.timeout(4000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data   = await resp.json();
      const models = (data.models && data.models.length ? data.models.map(m => m.name) : []);
      populateModelSelect(models, settings.model);
      setConnDot("llmDot", "ok");
      setConnVal("llmVal", settings.model || models[0] || provider);
      clearError();
    }
  } catch (e) {
    setConnDot("llmDot", "bad");
    if (PROVIDER_PRESETS[provider]?.needsKey || provider === "openrouter") {
      setConnVal("llmVal", "error");
      showError(`${provider} connection error: ${e.message}`);
    } else {
      // Local provider failed — still show saved model in dropdown so config isn't lost
      setConnVal("llmVal", "offline");
      const fallback = settings.model ? [settings.model] : [];
      if (fallback.length) {
        populateModelSelect(fallback, settings.model);
      } else {
        $("modelSelect").disabled = true;
        $("applyModelBtn").disabled = true;
      }
      showError(`Local LLM not reachable at ${settings.baseUrl}. Is ${provider === "lmstudio" ? "LM Studio" : "Ollama"} running?`);
    }
  }
}

// Poll every 8 s
setInterval(() => checkConnection(false), 8000);

// -- Settings Load/Save ------------------------------------------------------

async function loadSettings() {
  const settings = await chrome.storage.local.get({
    thinking:          false,
    provider:          "ollama",
    baseUrl:           "http://127.0.0.1:11434/v1",
    apiKey:            "",
    anthropicKey:      "",
    temperature:       0.2,
    maxSteps:          100,
    uncensored:        false,
    autoApprove:       false,
    autoApproveTypes:  [],
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

  // Restore auto-approve state
  if ($("autoApproveSelect")) $("autoApproveSelect").value = settings.autoApprove ? "auto" : "ask";
  $("autoApproveCheck").checked = !!settings.autoApprove;

  // Restore per-action-type auto-approve checkboxes
  const types = settings.autoApproveTypes || [];
  document.querySelectorAll("#autoApproveTypes [data-bucket]").forEach(cb => {
    cb.checked = types.includes(cb.dataset.bucket);
  });

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
  const uncensored       = $("uncensoredCheck").checked;
  const thinking         = $("thinkingCheck") ? $("thinkingCheck").checked : false;
  const autoApproveTypes = Array.from(document.querySelectorAll("#autoApproveTypes [data-bucket]:checked"))
    .map(cb => cb.dataset.bucket);

  try {
    await chrome.storage.local.set({ provider, baseUrl, apiKey, temperature, maxSteps, uncensored, thinking, autoApproveTypes });
    safePostMessage({ type: "update_autoApproveTypes", types: autoApproveTypes });
    $("settingsStatus").textContent = "Settings saved";
    $("settingsStatus").className   = "status-line ok";
    safePostMessage({ type: "update_config" });
    setTimeout(() => { $("settingsStatus").textContent = ""; }, 2500);
    await checkConnection(true);
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
    currentTabId = tab.id;
    currentTabGroupId = tab.groupId;
    checkTabOverlay();
    safePostMessage({ type: "panel_tab_active", windowId: tab.windowId, tabId: tab.id });
    if (isRestrictedUrl(tab.url)) {
      setStatus("currentTab", "bad",
        `cannot run on ${tab.url} — switch to a normal tab`);
    } else {
      setStatus("currentTab", "ok", `ready: ${tab.url}`);
    }
  } catch (_) {}
}

function checkTabOverlay() {
  const overlay = $("wrongTabOverlay");
  if (!overlay) return;

  // Suppress during the post-connect grace period — the background may be mid
  // forced-switch so currentTabId / currentTabGroupId are not yet settled.
  if (overlayGuarded) {
    overlay.classList.add("hidden");
    return;
  }

  const hasTaskGroup = taskTabGroupId !== null && taskTabGroupId !== undefined && taskTabGroupId !== -1;
  if (isTaskRunning) {
    if (hasTaskGroup) {
      // Don't flash if we haven't fetched the current group yet
      if (currentTabGroupId === null || currentTabGroupId === undefined) {
        overlay.classList.add("hidden");
        return;
      }
      if (currentTabGroupId !== taskTabGroupId) {
        overlay.classList.remove("hidden");
      } else {
        overlay.classList.add("hidden");
      }
    } else {
      if (attachedTabId && currentTabId && currentTabId !== attachedTabId) {
        overlay.classList.remove("hidden");
      } else {
        overlay.classList.add("hidden");
      }
    }
  } else {
    overlay.classList.add("hidden");
  }
}

// Bind switch to active task tab button
const switchBtn = $("switchToTaskTabBtn");
if (switchBtn) {
  switchBtn.addEventListener("click", () => {
    if (attachedTabId) {
      safePostMessage({ type: "focus_task_tab" });
    }
  });
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
    userBubble.innerHTML = `
      <div class="bubble-content">${escapeHtml(text)}</div>
      <button type="button" class="bubble-copy-btn" title="Copy message">📋</button>
    `;
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
      <button type="button" class="bubble-copy-btn" title="Copy logs">📋</button>
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
    agentBubble.innerHTML = `
      <div class="timeline" id="${activeTimelineId}"></div>
      <button type="button" class="bubble-copy-btn" title="Copy logs">📋</button>
    `;
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

$("refreshBtn").addEventListener("click", () => checkConnection(true));

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
  // Send classify_intent instead of start_task — let the LLM decide
  safePostMessage({ type: "classify_intent", goal, tabId: tab.id, autoApprove });
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

$("goalInput").addEventListener("input", () => {
  $("goalInput").style.height = "auto";
  $("goalInput").style.height = Math.min(120, $("goalInput").scrollHeight) + "px";
});

$("stopBtn").addEventListener("click", () => {
  safePostMessage({ type: "cancel_task" });
  $("runBtn").classList.remove("hidden");
  $("stopBtn").classList.add("hidden");
  setDot(false, false);
  const activeMsg = $(activeAgentMsgId);
  if (activeMsg) {
    const spinner = activeMsg.querySelector(".working-spinner");
    if (spinner) spinner.style.display = "none";
    const textEl = activeMsg.querySelector(".working-text");
    if (textEl) textEl.textContent = "Stopped by user";
  }
  setStatus("currentTab", "bad", "STOPPED — user cancelled");
});

$("newChatBtn").addEventListener("click", () => {
  suppressNextPanicLog = true;
  safePostMessage({ type: "cancel_task" });
  safePostMessage({ type: "clear_task" });
  logEl.innerHTML = "";
  lastScreenshots.length = 0;
  renderScreenshotStrip();
  taskIndex = 0;
  activeTimelineId = null;
  activeAgentMsgId = null;
  $("ctxSection").classList.add("hidden");
  $("copyResultBtn").classList.add("hidden");
  $("goalInput").value = "";
  $("goalInput").style.height = "auto";
  $("runBtn").classList.remove("hidden");
  $("stopBtn").classList.add("hidden");
  clearError();
});
async function copyTextToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (err) {
      console.warn("navigator.clipboard.writeText failed, falling back to textarea method:", err);
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    const successful = document.execCommand("copy");
    if (!successful) {
      throw new Error("document.execCommand('copy') returned false");
    }
  } catch (err) {
    console.error("Fallback copy failed:", err);
    throw err;
  } finally {
    document.body.removeChild(textarea);
  }
}

logEl.addEventListener("click", async (e) => {
  const btn = e.target.closest(".bubble-copy-btn");
  if (!btn) return;

  const bubble = btn.closest(".chat-bubble");
  if (!bubble) return;

  let textToCopy = "";
  if (bubble.classList.contains("user-message")) {
    const contentEl = bubble.querySelector(".bubble-content");
    textToCopy = contentEl ? contentEl.innerText.trim() : bubble.innerText.replace("📋", "").trim();
  } else if (bubble.classList.contains("agent-message")) {
    const chatReply = bubble.querySelector(".chat-reply-text");
    if (chatReply) {
      textToCopy = chatReply.innerText.trim();
    } else {
      const timeline = bubble.querySelector(".timeline");
      if (timeline) {
        let timelineText = [];
        timeline.childNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const text = node.innerText.trim();
            if (text) timelineText.push(text);
          }
        });
        textToCopy = timelineText.join("\n");
      }
    }
  }

  if (!textToCopy) return;

  try {
    await copyTextToClipboard(textToCopy);
    const originalText = btn.textContent;
    btn.textContent = "✓";
    btn.style.color = "var(--accent-aqua)";
    setTimeout(() => {
      btn.textContent = originalText;
      btn.style.color = "";
    }, 1500);
  } catch (err) {
    console.error("Failed to copy chat bubble text:", err);
  }
});

if ($("autoApproveSelect")) {
  $("autoApproveSelect").addEventListener("change", async (e) => {
    const isAuto = e.target.value === "auto";
    $("autoApproveCheck").checked = isAuto;
    // Persist immediately so it survives sidebar close/reopen
    await chrome.storage.local.set({ autoApprove: isAuto });
    // Apply to any currently running task without requiring a restart
    safePostMessage({ type: "update_autoApprove", autoApprove: isAuto });
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

const alwaysRow = document.querySelector(".dialog-always-row");
if (alwaysRow) {
  alwaysRow.addEventListener("click", () => {
    if (pendingDialog && pendingDialog.kind === "confirm" && pendingDialog.targetUrl) {
      alwaysAllowSite(pendingDialog.targetUrl).then(() => {
        respondDialog(true);
      });
    }
  });
}

// -- Dialogs -----------------------------------------------------------------

function showConfirmDialog(rid, prompt, targetUrl) {
  pendingDialog = { rid, kind: "confirm", targetUrl };
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

  const alwaysRow = document.querySelector(".dialog-always-row");
  const alwaysText = document.querySelector(".always-text");
  if (alwaysRow && alwaysText) {
    if (targetUrl) {
      let host = "";
      try {
        host = new URL(targetUrl).hostname;
      } catch (_) {
        host = targetUrl;
      }
      alwaysText.textContent = `Always allow actions on ${host}`;
      alwaysRow.classList.remove("hidden");
    } else {
      alwaysRow.classList.add("hidden");
    }
  }

  $("dialog").classList.remove("hidden");
}

function showVerifyDialog(rid, observation, verified, actionType) {
  const CONFIRM_ALWAYS_TYPES = new Set(["script", "fetch", "file_upload"]);
  pendingDialog = { rid, kind: "confirm", actionType: actionType || null };
  $("dialogTitle").textContent = verified ? "Step verified — continue?" : "⚠ Verification issue";
  $("dialogBody").textContent  = observation;
  $("dialogInput").classList.add("hidden");

  const yesBtn = $("dialogYes");
  const noBtn  = $("dialogNo");
  yesBtn.innerHTML = verified
    ? `Continue <span>↵</span>`
    : `Continue anyway <span>↵</span>`;
  noBtn.innerHTML = `Stop task <span>ESC</span>`;

  // Show "Trust site for session" for high-risk action types so repeated tasks
  // on the same site don't require repeated confirmations.
  const alwaysRow = document.querySelector(".dialog-always-row");
  if (alwaysRow) {
    if (actionType && CONFIRM_ALWAYS_TYPES.has(actionType)) {
      const alwaysText = alwaysRow.querySelector(".always-text");
      if (alwaysText) alwaysText.textContent = `Trust this site for ${actionType} actions this session`;
      alwaysRow.classList.remove("hidden");
      alwaysRow.dataset.trust = "true";
      alwaysRow.dataset.actionType = actionType;
    } else {
      alwaysRow.classList.add("hidden");
      alwaysRow.dataset.trust = "false";
    }
  }

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

  const alwaysRow = document.querySelector(".dialog-always-row");
  if (alwaysRow) alwaysRow.classList.add("hidden");

  $("dialog").classList.remove("hidden");
  $("dialogInput").focus();
}

function respondDialog(yes) {
  if (!pendingDialog) return;
  const { rid, kind, actionType } = pendingDialog;
  $("dialog").classList.add("hidden");
  if (kind === "confirm") {
    const alwaysRow = document.querySelector(".dialog-always-row");
    const wantsTrust = alwaysRow && alwaysRow.dataset.trust === "true";
    safePostMessage({
      type: "confirm_response",
      payload: { type: "user_confirm_response", rid, ok: yes, trust: yes && wantsTrust, actionType: actionType || null },
    });
    logEntry(yes ? "ok" : "bad", yes ? "ALLOWED" : "DENIED",
      yes ? (wantsTrust ? "action granted + site trusted for session" : "action granted") : "action denied");
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

async function alwaysAllowSite(url) {
  if (!url) return;
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch (_) {
    host = url;
  }
  if (!host) return;

  try {
    const data = await chrome.storage.local.get({ allowlist: [] });
    const list = data.allowlist || [];
    if (!list.includes(host)) {
      list.push(host);
      await chrome.storage.local.set({ allowlist: list });
      logEntry("ok", "POLICY", `Added ${host} to allowed sites list`);
      safePostMessage({ type: "update_config" });
    }
  } catch (err) {
    console.error("Failed to add site to allowlist:", err);
  }
}

// -- Keyboard shortcuts for active dialogs --
document.addEventListener("keydown", (e) => {
  if (pendingDialog) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (pendingDialog.kind === "confirm" && pendingDialog.targetUrl) {
        alwaysAllowSite(pendingDialog.targetUrl).then(() => {
          respondDialog(true);
        });
      } else {
        respondDialog(true);
      }
    } else if (e.key === "Enter" && !e.shiftKey) {
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
      isTaskRunning = msg.running;
      attachedTabId = msg.attachedTabId;
      taskTabGroupId = msg.tabGroupId;
      checkTabOverlay();
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
      isTaskRunning = false;
      attachedTabId = null;
      taskTabGroupId = null;
      checkTabOverlay();
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
      isTaskRunning = true;
      attachedTabId = evt.attachedTabId;
      taskTabGroupId = evt.tabGroupId;
      checkTabOverlay();
      setDot(true, false);
      setStatus("currentTab", "ok", "task running");
      $("runBtn").classList.add("hidden");
      $("stopBtn").classList.remove("hidden");
      streamEntry = null; streamBuffer = "";
      logEntry("info", "START", evt.goal);
      clearError();
      break;

    case "close_side_panel":
      window.close();
      break;

    case "classifying":
      // Show a subtle "thinking" indicator while classifying intent
      logEntry("info", "INIT", "understanding your request…");
      break;

    case "chat_response": {
      const activeMsg = $(activeAgentMsgId);
      if (activeMsg) {
        activeMsg.innerHTML = `
          <div class="agent-header">
            <svg class="working-spinner" viewBox="0 0 24 24" width="16" height="16" style="animation:none; opacity:0.7;">
              <path d="M12,2 L14,7 L19,6 L17,11 L22,12 L17,13 L19,18 L14,17 L12,22 L10,17 L5,18 L7,13 L2,12 L7,11 L5,6 L10,7 Z" fill="var(--accent-aqua)" />
            </svg>
            <span class="working-text">Chat</span>
          </div>
          <div class="chat-reply-text">${escapeHtml(evt.reply)}</div>
          <button type="button" class="bubble-copy-btn" title="Copy message">📋</button>
        `;
      } else {
        const chatBubble = document.createElement("div");
        chatBubble.className = "chat-bubble agent-message";
        chatBubble.innerHTML = `
          <div class="agent-header">
            <svg class="working-spinner" viewBox="0 0 24 24" width="16" height="16" style="animation:none; opacity:0.7;">
              <path d="M12,2 L14,7 L19,6 L17,11 L22,12 L17,13 L19,18 L14,17 L12,22 L10,17 L5,18 L7,13 L2,12 L7,11 L5,6 L10,7 Z" fill="var(--accent-aqua)" />
            </svg>
            <span class="working-text">Chat</span>
          </div>
          <div class="chat-reply-text">${escapeHtml(evt.reply)}</div>
          <button type="button" class="bubble-copy-btn" title="Copy message">📋</button>
        `;
        logEl.appendChild(chatBubble);
      }
      logEl.parentElement.scrollTop = logEl.parentElement.scrollHeight;

      // Reset buttons (no task is running)
      $("runBtn").classList.remove("hidden");
      $("stopBtn").classList.add("hidden");
      break;
    }

    case "action_confirmed":
      // Intent classified as action — show the standard task initialization logs
      logEntry("info", "INIT", "attaching debugger and starting planning loop…");
      break;

    case "stream_token": {
      if (!activeTimelineId) break;
      if (!streamEntry) {
        const timeline = $(activeTimelineId);
        if (!timeline) break;
        const el = document.createElement("div");
        el.className = "timeline-step think";
        el.innerHTML = `<span class="step-icon">✦</span><div class="step-details"><span class="step-title">STEP ${evt.step || "?"}</span><div class="step-desc stream-text"></div></div>`;
        timeline.appendChild(el);
        streamEntry = el;
        streamBuffer = "";
      }
      streamBuffer += evt.text;
      const display = streamBuffer.length > 400 ? "…" + streamBuffer.slice(-400) : streamBuffer;
      const textEl = streamEntry.querySelector(".stream-text");
      if (textEl) textEl.textContent = display;
      logEl.parentElement.scrollTop = logEl.parentElement.scrollHeight;
      break;
    }

    case "progress": {
      // Clear streaming entry — the final parsed thought replaces it
      if (streamEntry && (evt.kind === "think" || evt.kind === "act")) {
        streamEntry.remove();
        streamEntry = null;
        streamBuffer = "";
      }
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
      showVerifyDialog(evt.rid, evt.observation, evt.verified, evt.actionType);
      break;

    case "answer_request":
      logEntry("warn", "ASK", evt.question);
      showAnswerDialog(evt.rid, evt.question);
      break;

    case "done": {
      isTaskRunning = false;
      attachedTabId = null;
      taskTabGroupId = null;
      checkTabOverlay();
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
      isTaskRunning = false;
      attachedTabId = null;
      taskTabGroupId = null;
      checkTabOverlay();
      if (suppressNextPanicLog) {
        suppressNextPanicLog = false;
        setDot(false, false);
        setStatus("currentTab", "", "");
        break;
      }
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
      const handleScreenshot = (lastScreenshot) => {
        if (!lastScreenshot) {
          console.warn("[Panel] Received empty screenshot.");
          return;
        }
        console.log("[Panel] Screenshot received, appending to chat. Data length:", lastScreenshot.length);
        
        const timeline = $(activeTimelineId);
        let imgEl;
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
          imgEl = row.querySelector("img");
          imgEl.addEventListener("click", () => openLightbox(lastScreenshot, imgEl));
          timeline.appendChild(row);
        } else {
          const img = document.createElement("img");
          img.src = lastScreenshot;
          img.className = "log-screenshot";
          img.addEventListener("click", () => openLightbox(lastScreenshot, img));
          logEl.appendChild(img);
          imgEl = img;
        }

        if (imgEl) {
          imgEl.onload = () => {
            logEl.parentElement.scrollTop = logEl.parentElement.scrollHeight;
          };
        }
        logEl.parentElement.scrollTop = logEl.parentElement.scrollHeight;

        addToScreenshotStrip(lastScreenshot);
      };

      if (evt.lastScreenshot) {
        handleScreenshot(evt.lastScreenshot);
      } else {
        chrome.storage.session.get("lastScreenshot").then(({ lastScreenshot }) => {
          handleScreenshot(lastScreenshot);
        }).catch(() => {});
      }
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

// Parse stored log HTML via DOMParser (sandboxed, no script execution),
// strip all inline event handlers and javascript: hrefs, then import the
// cleaned nodes into the live document. This prevents stored-XSS if malicious
// content were ever written to chrome.storage.session by a compromised path.
function importSafeHtml(targetEl, html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, link[rel='import'], object, embed").forEach(el => el.remove());
  doc.querySelectorAll("*").forEach(el => {
    [...el.attributes].forEach(attr => {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    });
    if (el.tagName === "A") {
      const href = (el.getAttribute("href") || "").trim();
      if (/^javascript:/i.test(href)) el.removeAttribute("href");
    }
  });
  targetEl.textContent = "";
  [...doc.body.childNodes].forEach(node => targetEl.appendChild(document.importNode(node, true)));
}

async function restoreChatHistory() {
  try {
    const data = await chrome.storage.session.get(CHAT_STORAGE_KEY);
    const html = data[CHAT_STORAGE_KEY];
    if (!html) return;

    importSafeHtml(logEl, html);
    logEl.parentElement.scrollTop = logEl.parentElement.scrollHeight;

    // Re-wire screenshot click-to-enlarge (event listeners don't survive innerHTML)
    logEl.querySelectorAll("img.timeline-screenshot-thumb, img.log-screenshot").forEach(img => {
      img.addEventListener("click", () => openLightbox(img.src, img));
    });

    // Restore taskIndex so the next task gets a unique timeline ID
    const timelines = [...logEl.querySelectorAll("[id^='timeline-']")];
    if (timelines.length > 0) {
      const ids = timelines.map(el => parseInt(el.id.replace("timeline-", ""), 10)).filter(n => !isNaN(n));
      if (ids.length) taskIndex = Math.max(...ids);
    }
  } catch (_) {}
}

function checkEmptyState() {
  const emptyEl = $("emptyState");
  if (!emptyEl) return;
  if (logEl.children.length === 0) {
    emptyEl.classList.remove("hidden");
  } else {
    emptyEl.classList.add("hidden");
  }
}

// -- Init --------------------------------------------------------------------

connectPort();
loadSettings().then(() => checkConnection(true));
maybeShowOnboarding();
restoreChatHistory().then(() => {
  // Start observing AFTER restore so the initial innerHTML set doesn't trigger a save
  const observer = new MutationObserver(() => {
    checkEmptyState();
    debouncedSave();
  });
  observer.observe(logEl, { childList: true, subtree: true, characterData: true });
  checkEmptyState();
});
refreshTabStatus();
chrome.tabs.onActivated.addListener(refreshTabStatus);
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url || info.status === "complete") refreshTabStatus();
});

// Bind quick action click handlers
document.querySelectorAll(".qa-card").forEach(card => {
  card.addEventListener("click", () => {
    const goal = card.dataset.goal;
    if (goal) {
      const input = $("goalInput");
      input.value = goal;
      input.style.height = "auto";
      input.style.height = Math.min(120, input.scrollHeight) + "px";
      input.focus();
    }
  });
});

// -- Lightbox Modal -----------------------------------------------------------
let activeThumbnail = null;

function openLightbox(src, clickedImg) {
  const lightbox = $("lightbox");
  const lightboxImg = $("lightboxImg");
  if (!lightbox || !lightboxImg) return;

  // Cancel any ongoing closing transition
  if (lightbox.onCloseTransitionEnd) {
    lightbox.removeEventListener("transitionend", lightbox.onCloseTransitionEnd);
    lightbox.onCloseTransitionEnd = null;
  }

  activeThumbnail = clickedImg;
  lightboxImg.src = src;

  // Temporarily disable transitions to set the initial state instantly
  lightbox.style.transition = "none";
  lightboxImg.style.transition = "none";
  
  // Make it visible to calculate layout
  lightbox.classList.remove("hidden");

  // Determine initial coordinates and scale from the clicked thumbnail
  const rect = clickedImg ? clickedImg.getBoundingClientRect() : null;
  if (rect && rect.width > 0 && rect.height > 0) {
    const thumbCenterX = rect.left + rect.width / 2;
    const thumbCenterY = rect.top + rect.height / 2;
    const viewportCenterX = window.innerWidth / 2;
    const viewportCenterY = window.innerHeight / 2;

    const tx = thumbCenterX - viewportCenterX;
    const ty = thumbCenterY - viewportCenterY;

    // Use current or estimated dimensions to calculate scale
    const finalW = lightboxImg.offsetWidth || (rect.width * Math.min(window.innerWidth * 0.9 / rect.width, window.innerHeight * 0.9 / rect.height));
    const finalH = lightboxImg.offsetHeight || (rect.height * Math.min(window.innerWidth * 0.9 / rect.width, window.innerHeight * 0.9 / rect.height));
    const scale = Math.max(0.05, Math.min(rect.width / finalW, rect.height / finalH));

    lightboxImg.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    lightbox.style.opacity = "0";
    lightbox.style.backdropFilter = "blur(0px)";
  } else {
    lightboxImg.style.transform = "scale(0.85)";
    lightbox.style.opacity = "0";
    lightbox.style.backdropFilter = "blur(0px)";
  }

  // Force reflow
  lightbox.offsetHeight;

  // Animate to full scale and opacity
  lightbox.style.transition = "opacity 0.28s cubic-bezier(0.4, 0, 0.2, 1), backdrop-filter 0.28s cubic-bezier(0.4, 0, 0.2, 1)";
  lightboxImg.style.transition = "transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1)";
  
  lightbox.style.opacity = "1";
  lightbox.style.backdropFilter = "blur(8px)";
  lightboxImg.style.transform = "translate(0, 0) scale(1)";
}

function closeLightbox() {
  const lightbox = $("lightbox");
  const lightboxImg = $("lightboxImg");
  if (!lightbox || !lightboxImg || lightbox.classList.contains("hidden")) return;

  // Prevent double trigger
  if (lightbox.onCloseTransitionEnd) return;

  const rect = activeThumbnail ? activeThumbnail.getBoundingClientRect() : null;
  if (rect && rect.width > 0 && rect.height > 0) {
    const thumbCenterX = rect.left + rect.width / 2;
    const thumbCenterY = rect.top + rect.height / 2;
    const viewportCenterX = window.innerWidth / 2;
    const viewportCenterY = window.innerHeight / 2;

    const tx = thumbCenterX - viewportCenterX;
    const ty = thumbCenterY - viewportCenterY;
    
    const finalW = lightboxImg.offsetWidth || (rect.width * Math.min(window.innerWidth * 0.9 / rect.width, window.innerHeight * 0.9 / rect.height));
    const finalH = lightboxImg.offsetHeight || (rect.height * Math.min(window.innerWidth * 0.9 / rect.width, window.innerHeight * 0.9 / rect.height));
    const scale = Math.max(0.05, Math.min(rect.width / finalW, rect.height / finalH));

    lightbox.style.transition = "opacity 0.25s cubic-bezier(0.4, 0, 0.2, 1), backdrop-filter 0.25s cubic-bezier(0.4, 0, 0.2, 1)";
    lightboxImg.style.transition = "transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)";
    
    lightbox.style.opacity = "0";
    lightbox.style.backdropFilter = "blur(0px)";
    lightboxImg.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  } else {
    lightbox.style.transition = "opacity 0.22s cubic-bezier(0.4, 0, 0.2, 1)";
    lightboxImg.style.transition = "transform 0.22s cubic-bezier(0.4, 0, 0.2, 1)";
    lightbox.style.opacity = "0";
    lightboxImg.style.transform = "scale(0.85)";
  }

  const onCloseTransitionEnd = (e) => {
    if (e.propertyName === "opacity") {
      lightbox.classList.add("hidden");
      // Reset inline styles
      lightbox.style.transition = "";
      lightboxImg.style.transition = "";
      lightbox.style.opacity = "";
      lightbox.style.backdropFilter = "";
      lightboxImg.style.transform = "";
      lightbox.removeEventListener("transitionend", onCloseTransitionEnd);
      lightbox.onCloseTransitionEnd = null;
    }
  };
  
  lightbox.onCloseTransitionEnd = onCloseTransitionEnd;
  lightbox.addEventListener("transitionend", onCloseTransitionEnd);
}

const lightboxEl = $("lightbox");
if (lightboxEl) {
  lightboxEl.addEventListener("click", closeLightbox);
}

// Fallback runtime message listener to close the side panel programmatically
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message.action === "closeSidePanel") {
    window.close();
  }
});

// -- First-run onboarding wizard ---------------------------------------------

const ONBOARD_KEY_LINKS = {
  anthropic:  { url: "https://console.anthropic.com/settings/keys",  label: "Anthropic Console → API Keys" },
  openai:     { url: "https://platform.openai.com/api-keys",         label: "OpenAI Platform → API Keys" },
  gemini:     { url: "https://aistudio.google.com/app/apikey",       label: "Google AI Studio → Get API key" },
  deepseek:   { url: "https://platform.deepseek.com/api_keys",       label: "DeepSeek Platform → API Keys" },
  xai:        { url: "https://console.x.ai/",                        label: "xAI Console → API Keys" },
  groq:       { url: "https://console.groq.com/keys",                label: "Groq Console → API Keys" },
  openrouter: { url: "https://openrouter.ai/settings/keys",          label: "OpenRouter → Keys" },
};

const ONBOARD_DEFAULT_MODELS = {
  anthropic:  "claude-sonnet-4-6",
  openai:     "gpt-4o",
  gemini:     "gemini-2.0-flash",
  deepseek:   "deepseek-chat",
  xai:        "grok-2-vision-1212",
  groq:       "meta-llama/llama-4-scout-17b-16e-instruct",
  openrouter: "google/gemini-2.0-flash-001",
};

let obSelectedProvider = null;

function obShow(stepId) {
  document.querySelectorAll(".ob-step").forEach(el => el.classList.add("hidden"));
  const step = $(stepId);
  if (step) step.classList.remove("hidden");
}

function obSetStatus(elId, msg, type) {
  const el = $(elId);
  if (!el) return;
  el.textContent = msg;
  el.className = "ob-status-line" + (type ? " " + type : "");
}

async function obTestOllama() {
  const btn = $("obTestLocal");
  btn.disabled = true;
  obSetStatus("obLocalStatus", "Connecting to Ollama…");
  obShow("obStep2Local");
  try {
    const resp = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const models = (data.models || []).map(m => m.name);
    const model = models.find(m => m.startsWith("minicpm-v")) || models[0] || "minicpm-v:8b";
    await chrome.storage.local.set({
      provider: "ollama",
      baseUrl:  "http://127.0.0.1:11434/v1",
      apiKey:   "",
      model,
      navyOnboardingDone: true,
    });
    await loadSettings();
    checkConnection(true);
    obShowSuccess(`Connected to Ollama. Using model: ${model}`);
  } catch (e) {
    let hint = e.message;
    if (hint.includes("Failed to fetch") || hint.includes("Load failed") || hint.includes("NetworkError")) {
      hint = "Could not reach Ollama. Make sure it is installed and running, then try again.";
    }
    obSetStatus("obLocalStatus", hint, "err");
    btn.disabled = false;
  }
}

async function obTestCloud() {
  const key = ($("obApiKeyInput")?.value || "").trim();
  if (!key) {
    obSetStatus("obCloudStatus", "Paste your API key first.", "err");
    return;
  }
  const btn = $("obTestCloud");
  btn.disabled = true;
  obShow("obStep3");
  $("obTestingMsg").textContent = `Saving ${PROVIDER_PRESETS[obSelectedProvider]?.label || obSelectedProvider} key…`;
  const model = ONBOARD_DEFAULT_MODELS[obSelectedProvider] || "";
  await chrome.storage.local.set({
    provider: obSelectedProvider,
    baseUrl:  PROVIDER_PRESETS[obSelectedProvider]?.baseUrl || "",
    apiKey:   key,
    model,
    navyOnboardingDone: true,
  });
  await loadSettings();
  checkConnection(true);
  obShowSuccess(`${PROVIDER_PRESETS[obSelectedProvider]?.label || obSelectedProvider} configured. Default model: ${model}`);
}

function obShowSuccess(msg) {
  $("obSuccessMsg").textContent = msg;
  obShow("obStep4");
}

function obDismiss() {
  const overlay = $("onboardingOverlay");
  if (overlay) overlay.classList.add("hidden");
}

async function maybeShowOnboarding() {
  const { navyOnboardingDone, provider, apiKey } = await chrome.storage.local.get({
    navyOnboardingDone: false,
    provider: "",
    apiKey: "",
  });
  if (navyOnboardingDone) return;
  // Also skip if user already has a cloud provider configured with a key
  if (provider && provider !== "ollama" && provider !== "lmstudio" && apiKey) return;
  const overlay = $("onboardingOverlay");
  if (overlay) overlay.classList.remove("hidden");
  obShow("obStep1");
}

// Wire up all onboarding buttons
(function wireOnboarding() {
  // Step 1 — choose path
  $("obChooseLocal")?.addEventListener("click", () => obShow("obStep2Local"));
  $("obChooseCloud")?.addEventListener("click", () => obShow("obStep2Cloud"));
  $("obSkip")?.addEventListener("click", async () => {
    await chrome.storage.local.set({ navyOnboardingDone: true });
    obDismiss();
  });

  // Step 2A — Ollama
  $("obBack2Local")?.addEventListener("click", () => obShow("obStep1"));
  $("obTestLocal")?.addEventListener("click", obTestOllama);

  // Step 2B — cloud provider selection
  $("obBack2Cloud")?.addEventListener("click", () => obShow("obStep1"));
  document.querySelectorAll(".ob-provider-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      obSelectedProvider = btn.dataset.provider;
      const preset  = PROVIDER_PRESETS[obSelectedProvider] || {};
      const keyInfo = ONBOARD_KEY_LINKS[obSelectedProvider] || {};
      $("obCloudProviderName").textContent = preset.label || obSelectedProvider;
      $("obCloudKeyHint").textContent = `Get your API key from the provider's website, then paste it below.`;
      const linkEl = $("obCloudKeyLink");
      linkEl.textContent = keyInfo.label || "Open provider dashboard →";
      linkEl.href = keyInfo.url || "#";
      $("obApiKeyInput").value = "";
      obSetStatus("obCloudStatus", "");
      obShow("obStep2CloudKey");
    });
  });

  // Step 2C — cloud API key
  $("obBack2CloudKey")?.addEventListener("click", () => obShow("obStep2Cloud"));
  $("obTestCloud")?.addEventListener("click", obTestCloud);
  $("obToggleKey")?.addEventListener("click", () => {
    const inp = $("obApiKeyInput");
    inp.type = inp.type === "password" ? "text" : "password";
  });

  // Copy command buttons
  document.querySelectorAll(".ob-copy-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const text = btn.dataset.copy;
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => {
        const orig = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => { btn.textContent = orig; }, 1500);
      }).catch(() => {});
    });
  });

  // Step 4 — finish
  $("obFinish")?.addEventListener("click", obDismiss);
})();

// Check on startup whether to show onboarding
maybeShowOnboarding();
