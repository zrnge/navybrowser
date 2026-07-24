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
let lastGoal = "";
let savedTtsVoice = "auto";
let attachedImages = [];
let messageQueue = [];

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
// First-run SEED lists only. Live provider /models fetches are authoritative and
// override these; once a live fetch succeeds it is cached (see MODEL_CACHE_KEY) and
// the cache — not this static list — becomes the fallback. These exist only so the
// dropdown isn't empty before the very first successful fetch.
const CLOUD_MODEL_LISTS = {
  anthropic:  ["claude-3-5-sonnet-latest", "claude-3-5-haiku-latest", "claude-3-opus-latest"],
  openai:     ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-4", "o1", "o1-mini", "o3-mini"],
  gemini:     ["gemini-2.0-flash", "gemini-2.5-flash-preview-05-20", "gemini-2.5-pro-exp-03-25", "gemini-2.0-flash-lite", "gemini-1.5-pro", "gemini-1.5-flash"],
  deepseek:   ["deepseek-chat", "deepseek-reasoner"],
  xai:        ["grok-3-beta", "grok-3-mini-beta", "grok-2-vision-1212", "grok-2-1212"],
  zai:        ["z1-preview"],
  groq:       ["llama-3.3-70b-versatile", "llama-3.1-70b-versatile", "llama-3.1-8b-instant", "llama3-70b-8192", "llama3-8b-8192", "mixtral-8x7b-32768", "gemma2-9b-it", "compound-beta", "compound-beta-mini"],
  // openrouter: fetched live
};

// Persisted cache of the last successful live model fetch, keyed by provider.
// Survives fetch failures, avoids re-fetching on every provider switch, and keeps
// the dropdown current after the API adds/removes models.
const MODEL_CACHE_KEY = "cachedModelsByProvider";

// Freshness tracking for the model list, shared across the 8s health poll.
// While the list is stale (not confirmed live) the poll re-attempts a real fetch
// at most once per REFRESH_COOLDOWN_MS, so a provider recovering from offline
// upgrades cached→live instead of the tooltip freezing on "cached" forever.
let lastModelSource = null;
let lastModelFetchTs = 0;
const REFRESH_COOLDOWN_MS = 30000;

async function getCachedModels(provider) {
  try {
    const { [MODEL_CACHE_KEY]: cache = {} } = await chrome.storage.local.get(MODEL_CACHE_KEY);
    const entry = cache[provider];
    if (entry && Array.isArray(entry.models) && entry.models.length) return entry;
  } catch (_) {}
  return null;
}

async function cacheModels(provider, models) {
  if (!Array.isArray(models) || !models.length) return;
  try {
    const { [MODEL_CACHE_KEY]: cache = {} } = await chrome.storage.local.get(MODEL_CACHE_KEY);
    cache[provider] = { models, ts: Date.now() };
    await chrome.storage.local.set({ [MODEL_CACHE_KEY]: cache });
  } catch (_) {}
}

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

  // Provider description — safe to call even if element not yet in DOM (function checks)
  if (typeof applyProviderDescription === "function") applyProviderDescription(provider);
}

// Fetch model list live from a provider's /models endpoint.
// Returns a sorted array of { id, contextLength } objects, or throws on error.
// On success the result is persisted to the per-provider cache.
async function fetchProviderModels(provider, apiKey) {
  const preset = PROVIDER_PRESETS[provider];
  if (!preset?.baseUrl) throw new Error("no base URL");

  const baseUrl = preset.baseUrl.replace(/\/$/, "");
  const headers = {};
  const url = `${baseUrl}/models`;

  if (provider === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-dangerous-direct-browser-access"] = "true";
  } else if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();

  // Normalize across schemas: OpenAI-compat ({data:[{id}]}) and OpenRouter
  // ({data:[{id, context_length}]}) both use `data`; Anthropic likewise.
  const rows = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
  let models = rows
    .map(m => ({
      id: m.id || m.name,
      // Providers expose the window under different keys; take whichever exists.
      contextLength: m.context_length || m.context_window || (m.top_provider && m.top_provider.context_length) || undefined,
    }))
    .filter(m => m.id);

  // Filter out non-chat model types per provider
  if (provider === "openai") {
    const exclude = ["text-embedding", "whisper", "tts-", "dall-e", "babbage", "davinci-002", "ada-002"];
    models = models.filter(m => !exclude.some(p => m.id.startsWith(p)));
  } else if (provider === "groq") {
    models = models.filter(m => !m.id.startsWith("whisper") && !m.id.startsWith("distil-whisper"));
  } else if (provider === "gemini") {
    models = models.filter(m => m.id.startsWith("gemini") || m.id.startsWith("models/gemini"))
                   .map(m => ({ ...m, id: m.id.replace(/^models\//, "") }));
  }

  models.sort((a, b) => a.id.localeCompare(b.id));
  await cacheModels(provider, models);
  return models;
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
  const needsFetch = forceFetchModels || sel.options.length <= 1 ||
    (lastModelSource && lastModelSource !== "live" && (Date.now() - lastModelFetchTs > REFRESH_COOLDOWN_MS));

  if (needsFetch) {
    setConnDot("llmDot", "checking");
    setConnVal("llmVal", "checking…");
  }

  const KNOWN_CONTEXT_SIZES = {
    "gpt-4o": "128k",
    "gpt-4o-mini": "128k",
    "gpt-4-turbo": "128k",
    "claude-3-5-sonnet": "200k",
    "claude-3-5-haiku": "200k",
    "claude-3-opus": "200k",
    "gemini-2.0-flash": "1M",
    "gemini-1.5-pro": "2M",
    "gemini-1.5-flash": "1M",
    "llama-3.1-70b-instruct": "128k",
    "deepseek-chat": "64k"
  };

  function guessContextSize(modelId) {
    for (const [key, size] of Object.entries(KNOWN_CONTEXT_SIZES)) {
      if (modelId.includes(key)) return size;
    }
    return null;
  }

  function formatContextSize(num) {
    if (!num) return "";
    if (typeof num === "string") return num;
    if (num >= 1000000) return (num / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
    if (num >= 1000) return Math.round(num / 1000) + "k";
    return String(num);
  }

  function populateModelSelect(models, savedModel) {
    sel.innerHTML = "";
    
    // Convert all inputs to objects for unified handling
    const listObjects = models.map(m => typeof m === "string" ? { id: m } : m);
    
    // Ensure the saved model is always present even if not in fetched list
    const savedId = typeof savedModel === "object" ? savedModel.id : savedModel;
    if (savedId && !listObjects.some(m => m.id === savedId)) {
      listObjects.unshift({ id: savedId });
    }

    for (const m of listObjects) {
      const opt = document.createElement("option");
      opt.value = m.id; 
      opt.textContent = m.id;
      
      const ctx = m.contextLength || KNOWN_CONTEXT_SIZES[m.id] || guessContextSize(m.id);
      if (ctx) opt.dataset.context = ctx;
      
      if (m.id === savedId) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.disabled = false;
    $("applyModelBtn").disabled = false;

    sel.dispatchEvent(new Event("change"));
  }

  // Annotate where the current model list came from, on the selector's tooltip,
  // so a stale/offline list is never silently mistaken for a live one.
  function markModelSource(source) {
    const map = {
      live:   "Model list: live from provider",
      cached: "Model list: cached (last successful fetch — provider unreachable now)",
      seed:   "Model list: built-in defaults (no API key / never fetched)",
    };
    sel.title = map[source] || "Active LLM model";
    lastModelSource = source;
    if (source === "live") lastModelFetchTs = Date.now();
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

    if (provider === "openrouter" || PROVIDER_PRESETS[provider]?.needsKey) {
      // Cloud provider (incl. OpenRouter) — live /models fetch is authoritative,
      // then last-cached live list, then static seed as the final fallback.
      const seed = CLOUD_MODEL_LISTS[provider] || (settings.model ? [settings.model] : []);
      if (!apiKey) {
        const cached = await getCachedModels(provider);
        populateModelSelect(cached ? cached.models : seed, settings.model);
        markModelSource(cached ? "cached" : "seed");
        setConnDot("llmDot", "warn");
        setConnVal("llmVal", `${provider.toUpperCase()} (no key)`);
        showError(`${provider} requires an API key — open Settings and enter it.`);
      } else {
        setConnVal("llmVal", "fetching models…");
        let models = null, source = "seed";
        try {
          const fetched = await fetchProviderModels(provider, apiKey);
          if (fetched.length) { models = fetched; source = "live"; }
        } catch (_) { /* fall through to cache/seed */ }
        if (!models) {
          const cached = await getCachedModels(provider);
          if (cached) { models = cached.models; source = "cached"; }
        }
        populateModelSelect(models || seed, settings.model);
        markModelSource(source);
        setConnDot("llmDot", "ok");
        setConnVal("llmVal", provider.toUpperCase());
        clearError();
      }
    } else {
      // Local / custom provider — probe /api/tags (Ollama) then /v1/models (LM Studio / OpenAI-compat)
      const base    = (settings.baseUrl || "http://127.0.0.1:11434/v1").replace(/\/v1\/?$/, "");
      let models = [];
      try {
        const resp = await fetch(base + "/api/tags", { signal: AbortSignal.timeout(4000) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        models = (data.models || []).map(m => ({ id: m.name })).filter(m => m.id);
      } catch (_) {
        // Not Ollama — try the OpenAI-compatible /v1/models (LM Studio, llama.cpp, vLLM…)
        const resp = await fetch(base + "/v1/models", { signal: AbortSignal.timeout(4000) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        models = (data.data || []).map(m => ({ id: m.id })).filter(m => m.id);
      }
      if (models.length) await cacheModels(provider, models);
      const finalModels = models.length ? models : ((await getCachedModels(provider))?.models || (settings.model ? [settings.model] : []));
      populateModelSelect(finalModels, settings.model);
      markModelSource(models.length ? "live" : "cached");
      setConnDot("llmDot", "ok");
      setConnVal("llmVal", settings.model || (finalModels[0] && (finalModels[0].id || finalModels[0])) || provider);
      clearError();
    }
  } catch (e) {
    setConnDot("llmDot", "bad");
    if (PROVIDER_PRESETS[provider]?.needsKey || provider === "openrouter") {
      setConnVal("llmVal", "error");
      showError(`${provider} connection error: ${e.message}`);
    } else {
      // Local provider unreachable — show last-cached list (or saved model) so config isn't lost
      setConnVal("llmVal", "offline");
      const cached = await getCachedModels(provider);
      const fallback = cached ? cached.models : (settings.model ? [settings.model] : []);
      if (fallback.length) {
        populateModelSelect(fallback, settings.model);
        markModelSource("cached");
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

function populateVoiceList() {
  const select = $("ttsVoiceSelect");
  if (!select) return;
  const voices = window.speechSynthesis.getVoices();
  
  select.innerHTML = '<option value="auto">Auto (Best Available)</option>';
  voices.forEach(voice => {
    const option = document.createElement("option");
    option.textContent = `${voice.name} (${voice.lang})`;
    option.value = voice.voiceURI;
    select.appendChild(option);
  });
  select.value = savedTtsVoice;
}

if (speechSynthesis.onvoiceschanged !== undefined) {
  speechSynthesis.onvoiceschanged = populateVoiceList;
}

async function loadSettings() {
  const settings = await chrome.storage.local.get({
    thinking:          false,
    provider:          "ollama",
    baseUrl:           "http://127.0.0.1:11434/v1",
    apiKey:            "",
    anthropicKey:      "",
    temperature:       0.2,
    maxSteps:          100,
    maxOutputTokens:   4096,
    uncensored:        false,
    autoApprove:       false,
    autoApproveTypes:  [],
    mcpServerUrl:      "",
    ttsVoice:          "auto",
  });

  savedTtsVoice = settings.ttsVoice;
  if ($("ttsVoiceSelect")) {
    populateVoiceList();
    $("ttsVoiceSelect").value = savedTtsVoice;
  }

  // Backward compat: migrate anthropicKey → apiKey + provider=anthropic
  const provider = settings.provider || (settings.anthropicKey && !settings.apiKey ? "anthropic" : "ollama");
  const apiKey   = settings.apiKey || settings.anthropicKey || "";

  const provSel = $("providerSelect");
  if (provSel) provSel.value = provider;

  $("baseUrlInput").value  = settings.baseUrl;
  $("apiKeyInput").value   = apiKey;
  $("tempInput").value     = settings.temperature;
  $("maxStepsInput").value = settings.maxSteps;
  if ($("maxOutputTokensInput")) $("maxOutputTokensInput").value = settings.maxOutputTokens || 4096;
  $("uncensoredCheck").checked = settings.uncensored;
  const uncensoredWarn = $("uncensoredWarning");
  if (uncensoredWarn) uncensoredWarn.classList.toggle("hidden", !settings.uncensored);
  if ($("thinkingCheck")) $("thinkingCheck").checked = settings.thinking;
  if ($("mcpServerUrlInput")) $("mcpServerUrlInput").value = settings.mcpServerUrl || "";

  // Restore auto-approve state
  if ($("autoApproveSelect")) $("autoApproveSelect").value = settings.autoApprove ? "auto" : "ask";
  $("autoApproveCheck").checked = !!settings.autoApprove;
  applyAutoApproveWarning(!!settings.autoApprove);

  // Restore per-action-type auto-approve checkboxes
  const types = settings.autoApproveTypes || [];
  document.querySelectorAll("#autoApproveTypes [data-bucket]").forEach(cb => {
    cb.checked = types.includes(cb.dataset.bucket);
  });

  applyProviderUI(provider);
  applyProviderDescription(provider);
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
  const maxOutputTokens = $("maxOutputTokensInput") ? parseInt($("maxOutputTokensInput").value, 10) : 4096;
  const uncensored       = $("uncensoredCheck").checked;
  const thinking         = $("thinkingCheck") ? $("thinkingCheck").checked : false;
  const mcpServerUrl     = $("mcpServerUrlInput") ? $("mcpServerUrlInput").value.trim() : "";
  const ttsVoice         = $("ttsVoiceSelect") ? $("ttsVoiceSelect").value : "auto";
  const autoApproveTypes = Array.from(document.querySelectorAll("#autoApproveTypes [data-bucket]:checked"))
    .map(cb => cb.dataset.bucket);

  try {
    await chrome.storage.local.set({ provider, baseUrl, apiKey, temperature, maxSteps, maxOutputTokens, uncensored, thinking, mcpServerUrl, autoApproveTypes, ttsVoice });
    savedTtsVoice = ttsVoice;
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

// Live uncensored checkbox: show/hide warning
if ($("uncensoredCheck")) {
  $("uncensoredCheck").addEventListener("change", (e) => {
    const warn = $("uncensoredWarning");
    if (warn) warn.classList.toggle("hidden", !e.target.checked);
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
  if ($("readAloudBtn")) {
    $("readAloudBtn").classList.add("hidden");
    window.speechSynthesis.cancel();
  }
  if ($("exportPdfBtn")) $("exportPdfBtn").classList.add("hidden");
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

function logEntry(kind, tag, text, badge = "", images = []) {
  // If it's the User's goal, start a new chat turn
  if (tag === "GOAL") {
    taskIndex++;
    activeTimelineId = `timeline-${taskIndex}`;
    activeAgentMsgId = `agentMsg-${taskIndex}`;

    const userBubble = document.createElement("div");
    userBubble.className = "chat-bubble user-message";
    userBubble.innerHTML = `
      <div class="bubble-content">${escapeHtml(text)}</div>
      <button type="button" class="bubble-read-btn" title="Read message">🔊</button>
      <button type="button" class="bubble-copy-btn" title="Copy message">📋</button>
    `;

    if (images && images.length > 0) {
      const imgContainer = document.createElement("div");
      imgContainer.className = "user-images";
      imgContainer.style.cssText = "display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap;";
      for (const img of images) {
        const imgEl = document.createElement("img");
        imgEl.src = img;
        imgEl.style.cssText = "max-width: 150px; max-height: 150px; border-radius: 8px; object-fit: cover; cursor: pointer;";
        imgEl.title = "Click to enlarge";
        imgEl.addEventListener("click", () => openLightbox(imgEl.src, imgEl));
        imgContainer.appendChild(imgEl);
      }
      userBubble.insertBefore(imgContainer, userBubble.firstChild);
    }
    logEl.appendChild(userBubble);

    // Append Agent Response Card
    const agentBubble = document.createElement("div");
    agentBubble.className = "chat-bubble agent-message";
    agentBubble.id = activeAgentMsgId;
    agentBubble.innerHTML = `
      <div class="agent-header">
        <svg class="working-spinner" viewBox="0 0 128 128" width="16" height="16">
          <g stroke="var(--accent-aqua)" fill="var(--accent-aqua)">
            <circle cx="64" cy="64" r="40.5" fill="none" stroke-width="7"/>
            <circle cx="64" cy="64" r="22"   fill="none" stroke-width="3.5"/>
            <circle cx="64" cy="64" r="7"    fill="none" stroke-width="5"/>
            <circle cx="64" cy="64" r="3.5"  fill="none" stroke-width="2.5"/>
            <line x1="64" y1="56" x2="64" y2="26.5" stroke-width="4" stroke-linecap="round"/>
            <line x1="64" y1="19.5" x2="64" y2="12" stroke-width="4.5" stroke-linecap="round"/>
            <circle cx="64" cy="7" r="5"/>
            <line x1="69.7" y1="58.3" x2="90.5" y2="37.5" stroke-width="4" stroke-linecap="round"/>
            <line x1="95.5" y1="32.5" x2="100.8" y2="27.2" stroke-width="4.5" stroke-linecap="round"/>
            <circle cx="104.3" cy="23.7" r="5"/>
            <line x1="72" y1="64" x2="101.5" y2="64" stroke-width="4" stroke-linecap="round"/>
            <line x1="108.5" y1="64" x2="116" y2="64" stroke-width="4.5" stroke-linecap="round"/>
            <circle cx="121" cy="64" r="5"/>
            <line x1="69.7" y1="69.7" x2="90.5" y2="90.5" stroke-width="4" stroke-linecap="round"/>
            <line x1="95.5" y1="95.5" x2="100.8" y2="100.8" stroke-width="4.5" stroke-linecap="round"/>
            <circle cx="104.3" cy="104.3" r="5"/>
            <line x1="64" y1="72" x2="64" y2="101.5" stroke-width="4" stroke-linecap="round"/>
            <line x1="64" y1="108.5" x2="64" y2="116" stroke-width="4.5" stroke-linecap="round"/>
            <circle cx="64" cy="121" r="5"/>
            <line x1="58.3" y1="69.7" x2="37.5" y2="90.5" stroke-width="4" stroke-linecap="round"/>
            <line x1="32.5" y1="95.5" x2="27.2" y2="100.8" stroke-width="4.5" stroke-linecap="round"/>
            <circle cx="23.7" cy="104.3" r="5"/>
            <line x1="56" y1="64" x2="26.5" y2="64" stroke-width="4" stroke-linecap="round"/>
            <line x1="19.5" y1="64" x2="12" y2="64" stroke-width="4.5" stroke-linecap="round"/>
            <circle cx="7" cy="64" r="5"/>
            <line x1="58.3" y1="58.3" x2="37.5" y2="37.5" stroke-width="4" stroke-linecap="round"/>
            <line x1="32.5" y1="32.5" x2="27.2" y2="27.2" stroke-width="4.5" stroke-linecap="round"/>
            <circle cx="23.7" cy="23.7" r="5"/>
          </g>
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

  // RESULT and DONE are the two rows that carry a complete, standalone answer worth
  // hearing or exporting on their own — every other row is a mid-task trace line.
  // Tag is logged upper-case ("DONE"), so the check must match that exactly.
  const isSummaryRow = (tag === "RESULT" || tag === "DONE");
  const readBtnHtml = isSummaryRow ? `<button type="button" class="bubble-read-btn inline-read-btn" title="Read aloud" style="margin-left:8px; background:none; border:none; cursor:pointer; font-size:12px;">🔊</button>` : "";
  // A PDF report only earns its own button on a genuinely long answer — a one-line
  // "Task finished" or a short result has nothing worth paginating into a document.
  // 1000 chars is roughly a couple of paragraphs, well past the ambient chat length.
  const PDF_MIN_CHARS = 1000;
  const canExportPdf = isSummaryRow && String(text || "").length > PDF_MIN_CHARS;
  // data-md carries this row's own raw text so the PDF export uses exactly what
  // this bubble says, independent of the single task-wide report button below the
  // composer. escapeHtml makes it attribute-safe; reading it back via .dataset
  // auto-decodes the entities, restoring the original text unchanged.
  const pdfBtnHtml = canExportPdf ? `<button type="button" class="inline-pdf-btn" data-md="${escapeHtml(text)}" title="Export as PDF" style="margin-left:6px; background:none; border:none; cursor:pointer; font-size:12px;">📄</button>` : "";
  const badgeHtml = badge ? `<span class="step-badge">${escapeHtml(badge)}</span>` : "";
  // The RESULT bubble carries the model's final answer, which is authored as
  // Markdown — render it so headings/lists/links/code display as intended. Every
  // other row stays plain, escaped text. renderMarkdown escapes before adding tags.
  const bodyHtml = tag === "RESULT"
    ? `<div class="result-markdown">${renderMarkdown(text)}</div>`
    : escapeHtml(text);
  step.innerHTML = `
    <span class="step-icon">${icon}</span>
    <div class="step-details">
      <span class="step-title">${tag}</span>
      <div class="step-desc">${badgeHtml}${bodyHtml}${readBtnHtml}${pdfBtnHtml}</div>
    </div>
  `;
  timeline.appendChild(step);
  logEl.parentElement.scrollTop = logEl.parentElement.scrollHeight;
}

// escapeHtml / renderMarkdown / stripMarkdown / buildReportHtml now live in
// report-render.js (loaded before this file in panel.html) -- shared with report.html
// so the exported PDF always matches what the chat rendered.

// Export the current result as a PDF via the browser's native print-to-PDF.
// Opens report.html — a real, standalone extension page, in its own new tab — which
// reads the title/markdown back out of chrome.storage.session and prints itself.
//
// Two approaches were tried and both failed before this one:
//  1. A hidden iframe inside the side panel + iframe.contentWindow.print() — the side
//     panel is not a normal top-level tab, and Chrome's print pipeline can silently
//     decline to open a dialog for a request from that kind of embedded surface (no
//     error, nothing visibly happens).
//  2. A new tab opened on a blob: URL built in the panel — blob: URLs are only
//     resolvable within the browsing context that created them; navigating a
//     DIFFERENT tab/process to that URL hits ERR_FILE_NOT_FOUND, since the blob data
//     simply does not exist there.
// Passing the data through chrome.storage.session and letting report.html build and
// print itself sidesteps both: it is a genuine chrome-extension:// page navigation
// (always reliable) and printing happens from an ordinary top-level tab (no side-panel
// restriction).
function exportResultPdf(title, markdown) {
  if (!markdown || !markdown.trim()) return;
  try {
    // Keyed per-click (not a fixed shared key) so two exports fired in quick
    // succession — e.g. clicking RESULT's button then DONE's a moment later —
    // can never race: a second write can no longer clobber the first report
    // before its own tab has had a chance to read it.
    const rid = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const key = "navyReport_" + rid;
    chrome.storage.session.set(
      { [key]: { title: title || "Task Result", markdown } },
      () => {
        if (chrome.runtime.lastError) {
          console.error("[navy] PDF export: failed to stash report:", chrome.runtime.lastError);
          return;
        }
        chrome.tabs.create({ url: chrome.runtime.getURL("ui/report.html") + "?rid=" + encodeURIComponent(rid) });
      }
    );
  } catch (e) {
    console.error("[navy] PDF export failed:", e);
  }
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
    const label = danger ? "Agent status: error" : live ? "Agent status: running" : "Agent status: idle";
    dot.setAttribute("aria-label", label);
    dot.title = label;
  }
}

// -- Button wiring -----------------------------------------------------------

$("refreshBtn").addEventListener("click", () => checkConnection(true));

if ($("modelSelect")) {
  $("modelSelect").addEventListener("change", async (evt) => {
    const sel = $("modelSelect");
    const model = sel.value;
    
    const badge = $("modelContextBadge");
    const selectedOpt = sel.options[sel.selectedIndex];
    if (badge && selectedOpt) {
      const ctx = selectedOpt.dataset.context;
      if (ctx) {
        badge.textContent = formatContextSize(ctx);
        badge.classList.remove("hidden");
      } else {
        badge.classList.add("hidden");
      }
    }

    if (!model || !evt.isTrusted) return; // Prevent programmatic changes from spamming storage and logs
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

// -- Image Attachment --------------------------------------------------------

if ($("attachImageBtn")) {
  $("attachImageBtn").addEventListener("click", () => {
    $("imageInput").click();
  });

  $("imageInput").addEventListener("change", async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;

    const container = $("imagePreviewContainer");
    container.classList.remove("hidden");

    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target.result;
        attachedImages.push(dataUrl);
        const idx = attachedImages.length - 1;

        const item = document.createElement("div");
        item.className = "image-preview-item";
        item.innerHTML = `
          <img src="${dataUrl}" alt="attached image">
          <button type="button" class="image-preview-remove" data-idx="${idx}">×</button>
        `;
        container.appendChild(item);
      };
      reader.readAsDataURL(file);
    }
    e.target.value = "";
  });

  $("imagePreviewContainer").addEventListener("click", (e) => {
    if (e.target.classList.contains("image-preview-remove")) {
      const idx = parseInt(e.target.dataset.idx, 10);
      attachedImages[idx] = null;
      e.target.closest(".image-preview-item").remove();
      if (attachedImages.every(img => img === null)) {
        $("imagePreviewContainer").classList.add("hidden");
      }
    }
  });
}

$("runBtn").addEventListener("click", async () => {
  if (isTaskRunning) {
    queueMessage();
    return;
  }

  const goal = $("goalInput").value.trim();
  if (!goal) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { logEntry("bad", "ERR", "no active tab"); return; }
  const autoApprove = $("autoApproveCheck").checked;
  lastGoal = goal;
  
  const imagesToSend = attachedImages.filter(img => img !== null);
  
  clearError();
  resetCtx();
  logEntry("info", "GOAL", goal, "", imagesToSend);
  
  safePostMessage({ type: "classify_intent", goal, tabId: tab.id, autoApprove, attachedImages: imagesToSend });
  
  $("goalInput").value = "";
  updateGoalCharCount();
  
  attachedImages = [];
  if ($("imagePreviewContainer")) {
    $("imagePreviewContainer").innerHTML = "";
    $("imagePreviewContainer").classList.add("hidden");
  }
});

$("goalInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (!$("runBtn").classList.contains("hidden")) {
      $("runBtn").click();
    } else if (isTaskRunning) {
      queueMessage();
    }
  }
});

function queueMessage() {
  const goal = $("goalInput").value.trim();
  if (!goal) return;
  const imagesToSend = attachedImages.filter(img => img !== null);
  
  messageQueue.push({ goal, images: imagesToSend });
  
  logEntry("info", "QUEUED", goal, "", imagesToSend);
  renderQueueIndicator();
  
  $("goalInput").value = "";
  updateGoalCharCount();
  
  attachedImages = [];
  if ($("imagePreviewContainer")) {
    $("imagePreviewContainer").innerHTML = "";
    $("imagePreviewContainer").classList.add("hidden");
  }
}

function renderQueueIndicator() {
  const qInd = $("queueIndicator");
  const qText = $("queueText");
  if (!qInd || !qText) return;
  if (messageQueue.length > 0) {
    qInd.classList.remove("hidden");
    const count = messageQueue.length;
    const nextMsg = messageQueue[0].goal;
    qText.textContent = `Queued (${count}): ${nextMsg}`;
  } else {
    qInd.classList.add("hidden");
  }
}

function processQueueIfAny() {
  if (messageQueue.length > 0 && !isTaskRunning) {
    const nextMsg = messageQueue.shift();
    renderQueueIndicator();
    
    // Slight delay to allow UI to settle before firing next task
    setTimeout(() => {
      logEntry("info", "GOAL", nextMsg.goal, "", nextMsg.images);
      safePostMessage({ 
        type: "classify_intent", 
        goal: nextMsg.goal, 
        tabId: attachedTabId || currentTabId || null, 
        autoApprove: $("autoApproveCheck").checked, 
        attachedImages: nextMsg.images 
      });
    }, 300);
  }
}

function updateGoalCharCount() {
  const inp = $("goalInput");
  const el = $("goalCharCount");
  if (!el) return;
  const count = inp.value.length;
  if (count === 0) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden", "warn", "limit");
  el.textContent = `${count}/2000`;
  if (count > 1800) el.classList.add("limit");
  else if (count > 1500) el.classList.add("warn");
}

$("goalInput").addEventListener("input", () => {
  $("goalInput").style.height = "auto";
  $("goalInput").style.height = Math.min(120, $("goalInput").scrollHeight) + "px";
  updateGoalCharCount();
});

$("stopBtn").addEventListener("click", () => {
  safePostMessage({ type: "cancel_task" });
  // Show "Stopping…" until the done/panic/closed event arrives
  const stopBtn = $("stopBtn");
  stopBtn.classList.add("stopping");
  stopBtn.disabled = true;
  const activeMsg = $(activeAgentMsgId);
  if (activeMsg) {
    const textEl = activeMsg.querySelector(".working-text");
    if (textEl) textEl.textContent = "Stopping…";
  }
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
  lastGoal = "";
  $("ctxSection").classList.add("hidden");
  $("copyResultBtn").classList.add("hidden");
  if ($("readAloudBtn")) {
    $("readAloudBtn").classList.add("hidden");
    window.speechSynthesis.cancel();
  }
  if ($("exportPdfBtn")) $("exportPdfBtn").classList.add("hidden");
  $("goalInput").value = "";
  $("goalInput").style.height = "auto";
  $("goalInput").removeAttribute("readonly");
  $("goalInput").placeholder = "Ask Navy to do something...";
  $("runBtn").classList.remove("hidden");
  $("stopBtn").classList.remove("stopping");
  $("stopBtn").classList.add("hidden");
  $("stopBtn").disabled = false;
  document.body.classList.remove("task-running");
  hideLiveStatus();
  hideSuggestionChips();
  updateGoalCharCount();
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

function getBestVoice() {
  const voices = window.speechSynthesis.getVoices();
  if (!voices || voices.length === 0) return null;
  if (savedTtsVoice && savedTtsVoice !== "auto") {
    const selected = voices.find(v => v.voiceURI === savedTtsVoice);
    if (selected) return selected;
  }
  let best = voices.find(v => v.name.includes("Google") && v.lang.startsWith("en"));
  if (!best) best = voices.find(v => (v.name.includes("Natural") || v.name.includes("Premium")) && v.lang.startsWith("en"));
  if (!best) best = voices.find(v => v.name.includes("Zira") && v.lang.startsWith("en"));
  if (!best) best = voices.find(v => v.lang.startsWith("en") && v.default);
  if (!best) best = voices.find(v => v.lang.startsWith("en"));
  return best || voices[0];
}

logEl.addEventListener("click", async (e) => {
  const readBtn = e.target.closest(".bubble-read-btn");
  if (readBtn) {
    const bubble = readBtn.closest(".chat-bubble");
    if (!bubble) return;
    
    if (readBtn.classList.contains("reading")) {
      window.speechSynthesis.cancel();
      readBtn.classList.remove("reading");
      readBtn.textContent = "🔊";
      return;
    }
    
    window.speechSynthesis.cancel();
    document.querySelectorAll(".bubble-read-btn.reading").forEach(btn => {
      btn.classList.remove("reading");
      btn.textContent = "🔊";
    });
    
    let textToRead = "";
    if (bubble.classList.contains("user-message")) {
      const contentEl = bubble.querySelector(".bubble-content");
      textToRead = contentEl ? contentEl.innerText.trim() : "";
    } else if (bubble.classList.contains("agent-message")) {
      const chatReply = bubble.querySelector(".chat-reply-text");
      if (chatReply) {
        textToRead = chatReply.innerText.trim();
      } else if (readBtn.classList.contains("inline-read-btn")) {
        const stepDesc = readBtn.closest(".step-desc");
        // Strip both this button's own glyphs AND the adjacent inline-pdf-btn's
        // "📄" — they share the same .step-desc, so its innerText would otherwise
        // include the PDF button's icon in the spoken text.
        if (stepDesc) textToRead = stepDesc.innerText.replace(/[🔊🔇📄]/g, "").trim();
      }
    }
    
    if (textToRead) {
      const utterance = new SpeechSynthesisUtterance(textToRead);
      const voice = getBestVoice();
      if (voice) utterance.voice = voice;
      utterance.onend = () => {
        readBtn.classList.remove("reading");
        readBtn.textContent = "🔊";
      };
      utterance.onerror = () => {
        readBtn.classList.remove("reading");
        readBtn.textContent = "🔊";
      };
      readBtn.classList.add("reading");
      readBtn.textContent = "🔇";
      window.speechSynthesis.speak(utterance);
    }
    return;
  }

  const pdfBtn = e.target.closest(".inline-pdf-btn");
  if (pdfBtn) {
    const md = pdfBtn.dataset.md || "";
    if (!md.trim()) return;
    const stepTitle = pdfBtn.closest(".timeline-step")?.querySelector(".step-title")?.textContent || "";
    const title = lastGoal || stepTitle || "Task Result";
    const old = pdfBtn.textContent;
    pdfBtn.textContent = "…";
    pdfBtn.disabled = true;
    exportResultPdf(title, md);
    setTimeout(() => { pdfBtn.textContent = old; pdfBtn.disabled = false; }, 1500);
    return;
  }

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

function applyAutoApproveWarning(isAuto) {
  const wrap = $("autoApproveSelect") && $("autoApproveSelect").closest(".control-dropdown-wrap");
  if (wrap) wrap.classList.toggle("auto-approve-active", !!isAuto);
}

if ($("autoApproveSelect")) {
  $("autoApproveSelect").addEventListener("change", async (e) => {
    const isAuto = e.target.value === "auto";
    $("autoApproveCheck").checked = isAuto;
    applyAutoApproveWarning(isAuto);
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
    });
  }
});

let isReadingAloud = false;
if ($("readAloudBtn")) {
  $("readAloudBtn").addEventListener("click", () => {
    if (isReadingAloud) {
      window.speechSynthesis.cancel();
      isReadingAloud = false;
      $("readAloudBtn").innerHTML = "🔊 Read";
      return;
    }
    // Speak the markdown-stripped text so the voice does not read "#", "**", etc.
    const raw = $("copyResultBtn").dataset.resultMarkdown || $("copyResultBtn").dataset.resultText;
    const text = stripMarkdown(raw);
    if (text) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      const voice = getBestVoice();
      if (voice) utterance.voice = voice;
      utterance.onend = () => {
        isReadingAloud = false;
        $("readAloudBtn").innerHTML = "🔊 Read";
      };
      utterance.onerror = () => {
        isReadingAloud = false;
        $("readAloudBtn").innerHTML = "🔊 Read";
      };
      window.speechSynthesis.speak(utterance);
      isReadingAloud = true;
      $("readAloudBtn").innerHTML = "🔇 Stop";
    }
  });
}

if ($("exportPdfBtn")) {
  $("exportPdfBtn").addEventListener("click", () => {
    const md = $("copyResultBtn").dataset.resultMarkdown || $("copyResultBtn").dataset.resultText;
    const goal = $("copyResultBtn").dataset.resultGoal || "Task Result";
    if (!md) return;
    const btn = $("exportPdfBtn");
    const old = btn.innerHTML;
    btn.innerHTML = "📄 …";
    exportResultPdf(goal, md);
    setTimeout(() => { btn.innerHTML = old; }, 1500);
  });
}

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
  if (pendingDialog) respondDialog(false);
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
  if (pendingDialog) respondDialog(false);
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
  if (pendingDialog) respondDialog(false);
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
  } else if (kind === "answer") {
    if (!yes) {
      safePostMessage({ type: "cancel_task" });
    } else {
      const text = $("dialogInput").value.trim();
      safePostMessage({
        type: "answer_response",
        payload: { rid, answer: text }
      });
    }
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
  const key = msg.type || msg.event || "(unknown)";
  if (key !== "stream_token") console.log("[Panel] msg:", key);
  switch (msg.type) {
    case "status":
      isTaskRunning = msg.running;
      attachedTabId = msg.attachedTabId;
      taskTabGroupId = msg.tabGroupId;
      checkTabOverlay();
      if (msg.running) {
        setDot(true, false);
        setStatus("currentTab", "ok", `task running: ${msg.goal || ""}`);
        // Do not hide runBtn, keep it visible for queuing
        $("stopBtn").classList.remove("hidden");
        $("stopBtn").classList.remove("stopping");
        $("stopBtn").disabled = false;
        document.body.classList.add("task-running");
        updateTabIndicator();
      } else {
        $("runBtn").classList.remove("hidden");
        $("stopBtn").classList.remove("stopping");
        $("stopBtn").classList.add("hidden");
        $("stopBtn").disabled = false;
        document.body.classList.remove("task-running");
        $("goalInput").removeAttribute("readonly");
        $("goalInput").placeholder = "Ask Navy to do something...";
        hideLiveStatus();
        updateTabIndicator();
        
        processQueueIfAny();
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
      // Do not hide runBtn, keep it visible for queuing
      $("stopBtn").classList.remove("hidden");
      $("stopBtn").classList.remove("stopping");
      $("stopBtn").disabled = false;
      streamEntry = null; streamBuffer = "";
      logEntry("info", "START", evt.goal);
      clearError();
      document.body.classList.add("task-running");
      $("goalInput").placeholder = "Queue another task…";
      hideSuggestionChips();
      updateTabIndicator();
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
            <svg class="working-spinner" viewBox="0 0 128 128" width="16" height="16" style="animation:none; opacity:0.7;">
              <g stroke="var(--accent-aqua)" fill="var(--accent-aqua)">
                <circle cx="64" cy="64" r="40.5" fill="none" stroke-width="7"/>
                <circle cx="64" cy="64" r="22"   fill="none" stroke-width="3.5"/>
                <circle cx="64" cy="64" r="7"    fill="none" stroke-width="5"/>
                <circle cx="64" cy="64" r="3.5"  fill="none" stroke-width="2.5"/>
                <line x1="64" y1="56" x2="64" y2="26.5" stroke-width="4" stroke-linecap="round"/>
                <line x1="64" y1="19.5" x2="64" y2="12" stroke-width="4.5" stroke-linecap="round"/>
                <circle cx="64" cy="7" r="5"/>
                <line x1="69.7" y1="58.3" x2="90.5" y2="37.5" stroke-width="4" stroke-linecap="round"/>
                <line x1="95.5" y1="32.5" x2="100.8" y2="27.2" stroke-width="4.5" stroke-linecap="round"/>
                <circle cx="104.3" cy="23.7" r="5"/>
                <line x1="72" y1="64" x2="101.5" y2="64" stroke-width="4" stroke-linecap="round"/>
                <line x1="108.5" y1="64" x2="116" y2="64" stroke-width="4.5" stroke-linecap="round"/>
                <circle cx="121" cy="64" r="5"/>
                <line x1="69.7" y1="69.7" x2="90.5" y2="90.5" stroke-width="4" stroke-linecap="round"/>
                <line x1="95.5" y1="95.5" x2="100.8" y2="100.8" stroke-width="4.5" stroke-linecap="round"/>
                <circle cx="104.3" cy="104.3" r="5"/>
                <line x1="64" y1="72" x2="64" y2="101.5" stroke-width="4" stroke-linecap="round"/>
                <line x1="64" y1="108.5" x2="64" y2="116" stroke-width="4.5" stroke-linecap="round"/>
                <circle cx="64" cy="121" r="5"/>
                <line x1="58.3" y1="69.7" x2="37.5" y2="90.5" stroke-width="4" stroke-linecap="round"/>
                <line x1="32.5" y1="95.5" x2="27.2" y2="100.8" stroke-width="4.5" stroke-linecap="round"/>
                <circle cx="23.7" cy="104.3" r="5"/>
                <line x1="56" y1="64" x2="26.5" y2="64" stroke-width="4" stroke-linecap="round"/>
                <line x1="19.5" y1="64" x2="12" y2="64" stroke-width="4.5" stroke-linecap="round"/>
                <circle cx="7" cy="64" r="5"/>
                <line x1="58.3" y1="58.3" x2="37.5" y2="37.5" stroke-width="4" stroke-linecap="round"/>
                <line x1="32.5" y1="32.5" x2="27.2" y2="27.2" stroke-width="4.5" stroke-linecap="round"/>
                <circle cx="23.7" cy="23.7" r="5"/>
              </g>
            </svg>
            <span class="working-text">Chat</span>
          </div>
          <div class="chat-reply-text">${escapeHtml(evt.reply)}</div>
          <button type="button" class="bubble-read-btn" title="Read message">🔊</button>
          <button type="button" class="bubble-copy-btn" title="Copy message">📋</button>
        `;
      } else {
        const chatBubble = document.createElement("div");
        chatBubble.className = "chat-bubble agent-message";
        chatBubble.innerHTML = `
          <div class="agent-header">
            <svg class="working-spinner" viewBox="0 0 128 128" width="16" height="16" style="animation:none; opacity:0.7;">
              <g stroke="var(--accent-aqua)" fill="var(--accent-aqua)">
                <circle cx="64" cy="64" r="40.5" fill="none" stroke-width="7"/>
                <circle cx="64" cy="64" r="22"   fill="none" stroke-width="3.5"/>
                <circle cx="64" cy="64" r="7"    fill="none" stroke-width="5"/>
                <circle cx="64" cy="64" r="3.5"  fill="none" stroke-width="2.5"/>
                <line x1="64" y1="56" x2="64" y2="26.5" stroke-width="4" stroke-linecap="round"/>
                <line x1="64" y1="19.5" x2="64" y2="12" stroke-width="4.5" stroke-linecap="round"/>
                <circle cx="64" cy="7" r="5"/>
                <line x1="69.7" y1="58.3" x2="90.5" y2="37.5" stroke-width="4" stroke-linecap="round"/>
                <line x1="95.5" y1="32.5" x2="100.8" y2="27.2" stroke-width="4.5" stroke-linecap="round"/>
                <circle cx="104.3" cy="23.7" r="5"/>
                <line x1="72" y1="64" x2="101.5" y2="64" stroke-width="4" stroke-linecap="round"/>
                <line x1="108.5" y1="64" x2="116" y2="64" stroke-width="4.5" stroke-linecap="round"/>
                <circle cx="121" cy="64" r="5"/>
                <line x1="69.7" y1="69.7" x2="90.5" y2="90.5" stroke-width="4" stroke-linecap="round"/>
                <line x1="95.5" y1="95.5" x2="100.8" y2="100.8" stroke-width="4.5" stroke-linecap="round"/>
                <circle cx="104.3" cy="104.3" r="5"/>
                <line x1="64" y1="72" x2="64" y2="101.5" stroke-width="4" stroke-linecap="round"/>
                <line x1="64" y1="108.5" x2="64" y2="116" stroke-width="4.5" stroke-linecap="round"/>
                <circle cx="64" cy="121" r="5"/>
                <line x1="58.3" y1="69.7" x2="37.5" y2="90.5" stroke-width="4" stroke-linecap="round"/>
                <line x1="32.5" y1="95.5" x2="27.2" y2="100.8" stroke-width="4.5" stroke-linecap="round"/>
                <circle cx="23.7" cy="104.3" r="5"/>
                <line x1="56" y1="64" x2="26.5" y2="64" stroke-width="4" stroke-linecap="round"/>
                <line x1="19.5" y1="64" x2="12" y2="64" stroke-width="4.5" stroke-linecap="round"/>
                <circle cx="7" cy="64" r="5"/>
                <line x1="58.3" y1="58.3" x2="37.5" y2="37.5" stroke-width="4" stroke-linecap="round"/>
                <line x1="32.5" y1="32.5" x2="27.2" y2="27.2" stroke-width="4.5" stroke-linecap="round"/>
                <circle cx="23.7" cy="23.7" r="5"/>
              </g>
            </svg>
            <span class="working-text">Chat</span>
          </div>
          <div class="bubble-content">${escapeHtml(evt.text)}</div>
          <button type="button" class="bubble-read-btn" title="Read message">🔊</button>
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
        el.innerHTML = `<span class="step-icon">✦</span><div class="step-details"><span class="step-title">Thinking</span><div class="step-desc stream-text"></div></div>`;
        timeline.appendChild(el);
        streamEntry = el;
        streamBuffer = "";
      }
      streamBuffer += evt.text;
      const display = streamBuffer.length > 400 ? streamBuffer.slice(0, 400) + "…" : streamBuffer;
      const textEl = streamEntry.querySelector(".stream-text");
      if (textEl) textEl.textContent = display;
      logEl.parentElement.scrollTop = logEl.parentElement.scrollHeight;
      break;
    }

    case "progress": {
      if (!activeTimelineId) break;
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

      const ACT_LABELS = {
        click: "Click", type: "Type", navigate: "Navigate", scroll: "Scroll",
        read: "Read", screenshot: "Screenshot", drag: "Drag", hover: "Hover",
        fetch: "Fetch", script: "Script", done: "Done", ask_user: "Ask User",
        abort: "Abort", new_tab: "New Tab", wait: "Wait", file_upload: "Upload",
        batch: "Batch",
      };
      if (evt.kind === "act") {
        const actionLabel = evt.action_type ? (ACT_LABELS[evt.action_type] || evt.action_type.toUpperCase()) : `STEP ${evt.step}`;
        logEntry("act", actionLabel, thought, badge);
      } else if (evt.kind === "verify") {
        const ok = thought.startsWith("✓");
        logEntry(ok ? "ok" : "warn", "VERIFY", thought);
      } else if (evt.kind === "plan") {
        logEntry("plan", "PLAN", thought);
      } else if (evt.kind === "auto") {
        logEntry("auto", "AUTO", thought);
      } else if (evt.kind === "warn") {
        logEntry("warn", "WARN", thought);
      } else {
        logEntry(evt.kind === "think" ? "think" : evt.kind || "info", evt.kind === "think" ? "Thinking" : `STEP ${evt.step}`, thought, badge);
      }
      if (evt.tokens_used !== undefined) {
        updateCtx(evt.tokens_used, evt.tokens_max || ctxMax, evt.step, evt.steps_max || 100, evt.active_subtask_idx, evt.subtasks_len);
      }
      // Update live status strip
      const liveEl = $("liveStatus");
      if (liveEl) {
        if (evt.kind === "act" && evt.action_type) {
          const liveLabel = ACT_LABELS[evt.action_type] || evt.action_type;
          const liveSuffix = thought ? `: ${thought.substring(0, 70)}` : "";
          liveEl.textContent = `${liveLabel}${liveSuffix}`;
          liveEl.classList.remove("hidden");
        } else if (evt.kind === "think") {
          liveEl.textContent = `Thinking… (step ${evt.step})`;
          liveEl.classList.remove("hidden");
        }
      }
      break;
    }

    case "confirm_request": {
      if (!activeTimelineId) {
        safePostMessage({ type: "confirm_response", payload: { rid: evt.rid, ok: false, trust: false } });
        break;
      }
      clearError();
      logEntry("warn", "GATE", "agent needs confirmation");
      showConfirmDialog(evt.rid, evt.prompt, evt.targetUrl);
      break;
    }

    case "verify_request": {
      if (!activeTimelineId) {
        safePostMessage({ type: "confirm_response", payload: { rid: evt.rid, ok: false, trust: false } });
        break;
      }
      clearError();
      logEntry(evt.verified ? "ok" : "warn", "VERIFY", evt.observation);
      showVerifyDialog(evt.rid, evt.observation, evt.verified, evt.actionType);
      break;
    }

    case "answer_request": {
      if (!activeTimelineId) {
        safePostMessage({ type: "answer_response", payload: { rid: evt.rid, answer: "task cancelled" } });
        break;
      }
      clearError();
      logEntry("warn", "ASK", evt.question);
      showAnswerDialog(evt.rid, evt.question);
      break;
    }

    case "done": {
      isTaskRunning = false;
      attachedTabId = null;
      taskTabGroupId = null;
      checkTabOverlay();
      setDot(false, false);
      document.body.classList.remove("task-running");
      $("goalInput").removeAttribute("readonly");
      $("goalInput").placeholder = "Ask Navy to do something...";
      hideLiveStatus();
      updateTabIndicator();

      const activeMsg = $(activeAgentMsgId);
      if (activeMsg) {
        const spinner = activeMsg.querySelector(".working-spinner");
        if (spinner) spinner.style.display = "none";
        const textEl = activeMsg.querySelector(".working-text");
        if (textEl) textEl.textContent = "Finished";
      }

      $("runBtn").classList.remove("hidden");
      $("stopBtn").classList.remove("stopping");
      $("stopBtn").classList.add("hidden");
      $("stopBtn").disabled = false;

      const r = evt.result;
      if (r.success) {
        logEntry("ok", "DONE", r.summary || r.reason);
        if (r.finalAnswer) logEntry("ok", "RESULT", r.finalAnswer);
        setStatus("currentTab", "ok",
          `done — ${r.stepsTaken} steps, ${parseFloat(r.elapsedSeconds).toFixed(1)}s`);
        $("copyResultBtn").classList.remove("hidden");
        const resultMd = r.finalAnswer || r.summary || r.reason || "Success";
        $("copyResultBtn").dataset.resultText = resultMd;
        // Stash the raw Markdown + goal so Read-aloud and PDF export use the source,
        // not the rendered DOM (headings/lists stay intact, TTS strips the syntax).
        $("copyResultBtn").dataset.resultMarkdown = resultMd;
        $("copyResultBtn").dataset.resultGoal = lastGoal || "Task Result";
        if ($("readAloudBtn")) $("readAloudBtn").classList.remove("hidden");
        // Same >1000-char threshold as the inline per-message button — a short
        // result has nothing worth turning into a PDF report.
        if ($("exportPdfBtn")) $("exportPdfBtn").classList.toggle("hidden", resultMd.length <= 1000);
        saveTaskToHistory(lastGoal, true, r.summary || r.reason);
        showSuggestionChips(lastGoal);
      } else {
        logEntry("bad", "FAIL", r.reason);
        setStatus("currentTab", "bad", `failed — ${r.reason}`);
        showError(`Task failed: ${r.reason}`);
        saveTaskToHistory(lastGoal, false, r.reason);
        addRetryButton();
      }
      processQueueIfAny();
      break;
    }

    case "panic": {
      isTaskRunning = false;
      attachedTabId = null;
      taskTabGroupId = null;
      checkTabOverlay();
      document.body.classList.remove("task-running");
      $("goalInput").removeAttribute("readonly");
      $("goalInput").placeholder = "Ask Navy to do something...";
      hideLiveStatus();
      updateTabIndicator();
      // Drop any half-streamed "Thinking" block — the task was cancelled mid-thought,
      // so the partial reasoning is meaningless and would otherwise linger under the PANIC.
      if (streamEntry) { streamEntry.remove(); streamEntry = null; streamBuffer = ""; }
      if (suppressNextPanicLog) {
        suppressNextPanicLog = false;
        setDot(false, false);
        setStatus("currentTab", "", "");
        $("stopBtn").classList.remove("stopping");
        $("stopBtn").classList.add("hidden");
        $("stopBtn").disabled = false;
        $("runBtn").classList.remove("hidden");
        break;
      }
      setDot(false, true);

      const panicMsg = $(activeAgentMsgId);
      if (panicMsg) {
        const spinner = panicMsg.querySelector(".working-spinner");
        if (spinner) spinner.style.display = "none";
        const textEl = panicMsg.querySelector(".working-text");
        if (textEl) textEl.textContent = "Stopped";
      }

      $("runBtn").classList.remove("hidden");
      $("stopBtn").classList.remove("stopping");
      $("stopBtn").classList.add("hidden");
      $("stopBtn").disabled = false;

      logEntry("bad", "PANIC", evt.reason);
      setStatus("currentTab", "bad", `STOPPED — ${evt.reason}`);
      addRetryButton();
      setTimeout(() => setDot(false, false), 2000);
      processQueueIfAny();
      break;
    }

    case "closed": {
      setDot(false, false);
      document.body.classList.remove("task-running");
      $("goalInput").removeAttribute("readonly");
      $("goalInput").placeholder = "Ask Navy to do something...";
      hideLiveStatus();
      updateTabIndicator();

      const closedMsg = $(activeAgentMsgId);
      if (closedMsg) {
        const spinner = closedMsg.querySelector(".working-spinner");
        if (spinner) spinner.style.display = "none";
        const textEl = closedMsg.querySelector(".working-text");
        if (textEl) textEl.textContent = "Closed";
      }

      $("runBtn").classList.remove("hidden");
      $("stopBtn").classList.remove("stopping");
      $("stopBtn").classList.add("hidden");
      $("stopBtn").disabled = false;
      break;
    }

    case "screenshot_ready": {
      const showScreenshot = (url) => {
        if (!url) return;
        const scroller = logEl.parentElement;
        const scrollDown = () => { if (scroller) scroller.scrollTop = scroller.scrollHeight; };

        const img = document.createElement("img");
        img.className = "timeline-screenshot-thumb";
        img.title = "Click to enlarge";
        img.alt = "";
        img.onload = scrollDown;
        img.onerror = scrollDown;
        img.addEventListener("click", () => openLightbox(url, img));
        img.src = url;

        const timeline = $(activeTimelineId);
        if (timeline) {
          const row = document.createElement("div");
          row.className = "timeline-screenshot-row";
          const details = document.createElement("div");
          details.className = "screenshot-details";
          const label = document.createElement("span");
          label.className = "screenshot-label";
          label.textContent = "📷 Screenshot";
          details.appendChild(label);
          details.appendChild(img);
          row.appendChild(details);
          timeline.appendChild(row);
        } else {
          logEl.appendChild(img);
        }

        scrollDown();
        addToScreenshotStrip(url);
      };

      if (evt.lastScreenshot) {
        showScreenshot(evt.lastScreenshot);
      } else {
        chrome.storage.session.get("lastScreenshot").then(d => showScreenshot(d?.lastScreenshot)).catch(() => {});
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
  const isOpen = !panel.classList.contains("hidden");
  $("advancedToggle").setAttribute("aria-expanded", String(isOpen));
  $("advancedToggle").title = isOpen ? "Close settings" : "Agent settings";
});

if ($("closeSettingsBtn")) {
  $("closeSettingsBtn").addEventListener("click", () => {
    $("setupPanel").classList.add("hidden");
    $("advancedToggle").setAttribute("aria-expanded", "false");
    $("advancedToggle").title = "Agent settings";
  });
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

// -- Retry button ------------------------------------------------------------

function addRetryButton() {
  const activeMsg = $(activeAgentMsgId);
  if (!activeMsg || !lastGoal) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "retry-btn";
  btn.textContent = "↩ Retry";
  btn.addEventListener("click", () => {
    $("goalInput").value = lastGoal;
    $("goalInput").style.height = "auto";
    $("goalInput").style.height = Math.min(120, $("goalInput").scrollHeight) + "px";
    $("goalInput").focus();
    updateGoalCharCount();
  });
  activeMsg.appendChild(btn);
}

// -- Live status helpers -----------------------------------------------------

function hideLiveStatus() {
  const el = $("liveStatus");
  if (el) el.classList.add("hidden");
}

// -- Tab indicator -----------------------------------------------------------

async function updateTabIndicator() {
  const el = $("tabIndicator");
  if (!el) return;
  if (!attachedTabId || !isTaskRunning) {
    el.classList.add("hidden");
    return;
  }
  try {
    const tab = await chrome.tabs.get(attachedTabId);
    const host = tab.url ? new URL(tab.url).hostname.replace(/^www\./, "") : "?";
    el.classList.remove("hidden");
    el.innerHTML = tab.favIconUrl
      ? `<img src="${escapeHtml(tab.favIconUrl)}" alt="" width="13" height="13"><span class="tab-indicator-url">${escapeHtml(host)}</span>`
      : `<span class="tab-indicator-url">${escapeHtml(host)}</span>`;
  } catch (_) {
    el.classList.add("hidden");
  }
}

// -- Task history ------------------------------------------------------------

async function saveTaskToHistory(goal, success, summary) {
  try {
    const { taskHistory = [] } = await chrome.storage.local.get({ taskHistory: [] });
    taskHistory.unshift({ goal, success, summary: summary || "", ts: Date.now() });
    if (taskHistory.length > 50) taskHistory.length = 50;
    await chrome.storage.local.set({ taskHistory });
  } catch (_) {}
}

// -- Suggestion chips --------------------------------------------------------

const SUGGESTION_SETS = [
  ["Copy result to clipboard", "Summarize what you found"],
  ["Do it again", "Try a different approach"],
  ["Search for more details", "Open results in a new tab"],
];

function showSuggestionChips(goal) {
  const container = $("suggestionChips");
  if (!container) return;
  container.innerHTML = "";
  const chips = SUGGESTION_SETS[Math.floor(Math.random() * SUGGESTION_SETS.length)];
  chips.forEach(text => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "suggestion-chip";
    btn.textContent = text;
    btn.addEventListener("click", () => {
      $("goalInput").value = text;
      $("goalInput").style.height = "auto";
      $("goalInput").style.height = Math.min(120, $("goalInput").scrollHeight) + "px";
      $("goalInput").focus();
      updateGoalCharCount();
      hideSuggestionChips();
    });
    container.appendChild(btn);
  });
  container.classList.remove("hidden");
}

function hideSuggestionChips() {
  const el = $("suggestionChips");
  if (el) el.classList.add("hidden");
}


// -- Lightbox close button ---------------------------------------------------

const lightboxCloseBtn = $("lightboxClose");
if (lightboxCloseBtn) {
  lightboxCloseBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeLightbox();
  });
}

// -- Settings: API key toggle, test connection, provider description ---------

const PROVIDER_DESCRIPTIONS = {
  ollama:     "Free & private — runs entirely on your machine. No API key needed.",
  lmstudio:   "Free & private — runs local models via LM Studio. No API key needed.",
  anthropic:  "Claude models by Anthropic. Best reasoning and vision. API key required.",
  openai:     "GPT-4o and more by OpenAI. API key required.",
  gemini:     "Gemini models by Google. Fast and affordable. API key required.",
  deepseek:   "DeepSeek — strong reasoning at competitive pricing. API key required.",
  xai:        "Grok models by xAI. API key required.",
  zai:        "z.ai models. API key required.",
  groq:       "Ultra-fast inference. Free tier available. API key required.",
  openrouter: "Access 100+ models with one key. API key required.",
  custom:     "Connect to any OpenAI-compatible endpoint.",
};

function applyProviderDescription(provider) {
  const el = $("providerDesc");
  if (el) el.textContent = PROVIDER_DESCRIPTIONS[provider] || "";
}

if ($("toggleApiKeyBtn")) {
  $("toggleApiKeyBtn").addEventListener("click", () => {
    const inp = $("apiKeyInput");
    const btn = $("toggleApiKeyBtn");
    if (inp.type === "password") { inp.type = "text"; btn.textContent = "🙈"; }
    else { inp.type = "password"; btn.textContent = "👁"; }
  });
}

if ($("testConnectionBtn")) {
  $("testConnectionBtn").addEventListener("click", async () => {
    const btn = $("testConnectionBtn");
    btn.disabled = true;
    btn.textContent = "Testing…";
    try {
      await checkConnection(true);
    } finally {
      btn.disabled = false;
      btn.textContent = "Test Connection";
    }
  });
}

// Wire provider description updates
if ($("providerSelect")) {
  $("providerSelect").addEventListener("change", (e) => {
    applyProviderDescription(e.target.value);
  });
}

// -- Onboarding: Later button, clickable examples, spinner timeout -----------

$("obLater")?.addEventListener("click", () => {
  obDismiss();
  // No navyOnboardingDone set — wizard will appear again next session
});

document.querySelectorAll(".ob-tip-box-example").forEach(btn => {
  btn.addEventListener("click", () => {
    const goal = btn.dataset.goal;
    if (!goal) return;
    $("goalInput").value = goal;
    $("goalInput").style.height = "auto";
    $("goalInput").style.height = Math.min(120, $("goalInput").scrollHeight) + "px";
    updateGoalCharCount();
    chrome.storage.local.set({ navyOnboardingDone: true });
    obDismiss();
    $("goalInput").focus();
  });
});

// -- Keyboard shortcut: Escape to close lightbox ----------------------------

document.addEventListener("keydown", (e) => {
  if (!pendingDialog && e.key === "Escape") {
    const lb = $("lightbox");
    if (lb && !lb.classList.contains("hidden")) {
      e.preventDefault();
      closeLightbox();
    }
  }
});

// -- Init --------------------------------------------------------------------

connectPort();
loadSettings().then(() => checkConnection(true));
maybeShowOnboarding();
const observer = new MutationObserver(() => {
  checkEmptyState();
});
observer.observe(logEl, { childList: true, subtree: true, characterData: true });
checkEmptyState();
refreshTabStatus();
chrome.tabs.onActivated.addListener(refreshTabStatus);
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url || info.status === "complete" || info.groupId !== undefined) refreshTabStatus();
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
  anthropic:  "claude-3-5-sonnet-latest",
  openai:     "gpt-4o",
  gemini:     "gemini-2.0-flash",
  deepseek:   "deepseek-chat",
  xai:        "grok-3-beta",
  groq:       "llama-3.3-70b-versatile",
  openrouter: "google/gemini-2.5-flash",
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
  if (btn) btn.disabled = true;
  try {
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
  } catch (e) {
    obShow("obStep2CloudKey");
    obSetStatus("obCloudStatus", "Save failed — try again.", "err");
    if (btn) btn.disabled = false;
  }
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

