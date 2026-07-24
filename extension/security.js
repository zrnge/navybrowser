// security.js — Security policy gate and auditing for Navy.

export const BUILTIN_SENSITIVE_DOMAINS = [
  // Major US banks
  "chase.com", "bankofamerica.com", "wellsfargo.com", "citibank.com", "citi.com",
  "usbank.com", "tdbank.com", "capitalone.com", "pnc.com", "regions.com",
  // UK / international banks
  "barclays.co.uk", "hsbc.com", "lloydsbank.com", "natwest.com", "santander.co.uk",
  // Investment / brokerage
  "schwab.com", "fidelity.com", "vanguard.com", "robinhood.com", "etrade.com",
  "tdameritrade.com", "merrilledge.com",
  // Payment
  "paypal.com", "venmo.com", "cashapp.com", "zelle.com",
  // Crypto exchanges
  "coinbase.com", "kraken.com", "binance.com", "crypto.com", "gemini.com",
  // Password managers
  "1password.com", "bitwarden.com", "lastpass.com", "dashlane.com",
  "keeper.com", "nordpass.com", "keepersecurity.com",
  // Government / identity
  "irs.gov", "login.gov", "ssa.gov", "medicare.gov", "mygov.au",
  "hmrc.gov.uk", "gov.uk",
  // Healthcare
  "mychart.com",
];

function getHostname(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname.toLowerCase();
  } catch (_) {
    return null;
  }
}

export class DomainPolicy {
  constructor(config = {}) {
    this.allowlist = new Set(config.allowlist || []);
    this.userDenylist = new Set(config.userDenylist || []);
    this.requirePerSessionEnable = config.requirePerSessionEnable || false;
    this.strictAllowlist = config.strictAllowlist || false;
    this.uncensored = config.uncensored || false;
  }

  isSensitive(url) {
    const host = getHostname(url);
    if (!host) return false;

    // Built-in sensitive domains are always protected — uncensored mode does NOT bypass these
    for (const blocked of BUILTIN_SENSITIVE_DOMAINS) {
      if (host === blocked || host.endsWith("." + blocked)) return true;
    }
    if (this.uncensored) return false;
    for (const blocked of this.userDenylist) {
      if (host === blocked || host.endsWith("." + blocked)) return true;
    }
    return false;
  }

  isAllowed(url) {
    if (this.uncensored) return true;
    const host = getHostname(url);
    if (!host) return false;

    if (this.isSensitive(url)) return false;
    
    // If the user has explicitly defined an allowlist, treat it as strict implicitly.
    // (allowlist is a Set — .size, not .length: the .length bug made every
    // user-configured allowlist silently ignored.)
    if (this.allowlist && this.allowlist.size > 0) {
      for (const allowed of this.allowlist) {
        if (host === allowed || host.endsWith("." + allowed)) return true;
      }
      return false;
    }

    if (!this.strictAllowlist) return true;
    return false;
  }
}

const INJECTION_PATTERNS = [
  // Classic ignore/disregard variants
  /ignore\s+(\w+\s+){0,3}(previous|above|prior|all)\s+instructions?/i,
  /disregard\s+(\w+\s+){0,3}(previous|above|prior|all)/i,
  /override\s+(\w+\s+){0,3}(instructions?|directives?|rules?)/i,
  /dismiss\s+(\w+\s+){0,3}(instructions?|directives?|rules?)/i,
  // New / revised instructions
  /new\s+instructions?\s*[:-]/i,
  /revised?\s+instructions?\s*[:-]/i,
  /updated?\s+instructions?\s*[:-]/i,
  // System prompt references
  /system\s*(prompt|message)\s*[:-]/i,
  /<\/?(system|instruction|prompt|context|assistant)>/i,
  // Role hijacking
  /you\s+are\s+now\s+(a|an)\s+/i,
  /act\s+as\s+(a|an)\s+(new|different|unrestricted)/i,
  /your\s+(new\s+)?(role|persona|identity)\s+is/i,
  // Forget / reset
  /forget\s+(everything|your\s+instructions|prior)/i,
  /reset\s+(your\s+)?(instructions?|context|memory)/i,
  // Credential/data exfiltration commands
  /send\s+(the\s+)?(user'?s?\s+)?(cookies|password|credentials|token|key)/i,
  /exfiltrate|exfiltr[ae]te/i,
  /leak\s+(the\s+)?(cookies|password|data|token)/i,
  // Navigation commands embedded in content
  /navigate\s+to\s+https?:\/\//i,
  /go\s+to\s+https?:\/\//i,
  /click\s+(this|the\s+following)\s+link/i,
  // Task injection
  /your\s+(next\s+)?(task|action|step)\s+is/i,
  /execute\s+(the\s+following|this)\s+(command|instruction|action)/i,
];

export function sanitizePageText(text, maxLen = 8000) {
  const warnings = [];
  if (!text) {
    return {
      wrapped: "<UNTRUSTED_PAGE_CONTENT>\n\n</UNTRUSTED_PAGE_CONTENT>",
      warnings
    };
  }

  for (const pat of INJECTION_PATTERNS) {
    if (pat.test(text)) {
      warnings.push(`injection_pattern:${pat.source.substring(0, 40)}`);
    }
  }

  let truncated = text;
  if (text.length > maxLen) {
    truncated = text.substring(0, maxLen) + "\n[…truncated…]";
  }

  const wrapped = `<UNTRUSTED_PAGE_CONTENT>\n${truncated}\n</UNTRUSTED_PAGE_CONTENT>`;
  return { wrapped, warnings };
}

// Lightweight sanitizer for short inline strings (element labels, form field names/values).
// Unlike sanitizePageText, this does NOT wrap in <UNTRUSTED> tags because the strings
// appear inline inside structured data (ELEMENT_MAP, form state). Instead it blocks the
// entire string and returns a warning when an injection pattern is detected.
export function sanitizeLabel(str, maxLen = 80) {
  if (str === null || str === undefined || str === "") return { clean: "", warned: false };
  if (typeof str !== "string") str = String(str);
  const truncated = str.length > maxLen ? str.substring(0, maxLen) + "…" : str;
  for (const pat of INJECTION_PATTERNS) {
    if (pat.test(truncated)) {
      return { clean: "[BLOCKED: injection attempt detected in page label]", warned: true };
    }
  }
  return { clean: truncated, warned: false };
}

const CRED_FIELD_HINTS = /(password|passwd|pwd|secret|token|api[_-]?key|ssn|social[_-]?security|card[_-]?number|cvv|cvc|pin|otp|2fa|mfa|credential|auth[_-]?token|access[_-]?key|private[_-]?key|session[_-]?id)/i;
// autocomplete tokens that mark a sensitive value — a robust signal that catches
// fields whose NAME is obfuscated (e.g. name="f1" autocomplete="cc-number").
// Mirrors the set Claude for Chrome redacts in its accessibility tree.
const CRED_AUTOCOMPLETE = /(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp)/i;

export function looksLikeCredentialField(fieldName, fieldType, autocomplete) {
  if (fieldType && fieldType.toLowerCase() === "password") return true;
  if (fieldName && CRED_FIELD_HINTS.test(fieldName)) return true;
  if (autocomplete && CRED_AUTOCOMPLETE.test(autocomplete)) return true;
  return false;
}

export async function maskText(text) {
  if (!text) return "<empty>";
  try {
    const msgUint8 = new TextEncoder().encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return `<masked sha256:${hashHex.substring(0, 12)} len:${text.length}>`;
  } catch (e) {
    return `<masked len:${text.length}>`;
  }
}

export class PolicyDecision {
  constructor(allow, reason, requireUserConfirmation = false) {
    this.allow = allow;
    this.reason = reason;
    this.requireUserConfirmation = requireUserConfirmation;
  }
}

// Returns true for loopback, link-local, RFC-1918, and private IPv6 hostnames.
// Used to block SSRF via actFetch (service worker can reach any network the
// browser host can reach — including routers, dev servers, and AWS metadata).
function _isPrivateHost(host) {
  // Strip brackets from IPv6 literals like [::1]
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();

  if (bare === "localhost") return true;

  // IPv6: contains a colon
  if (bare.includes(":")) {
    if (bare === "::1" || bare === "::") return true;       // loopback / unspecified (::  ~= 0.0.0.0)
    // IPv4-mapped IPv6 ::ffff:192.168.x.x — recurse with the embedded IPv4 part
    const ipv4mapped = bare.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (ipv4mapped) return _isPrivateHost(ipv4mapped[1]);
    // Same mapping, hex form ::ffff:c0a8:1 — how the WHATWG URL parser serializes
    // an IPv4-mapped address, so this is the form actually reaching us in practice.
    const ipv4hex = bare.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (ipv4hex) {
      const hi = parseInt(ipv4hex[1], 16), lo = parseInt(ipv4hex[2], 16);
      return _isPrivateHost(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
    }
    if (/^f[cd]/i.test(bare)) return true;                 // ULA fc00::/7
    if (/^fe[89ab]/i.test(bare)) return true;              // link-local fe80::/10
    return false;
  }

  // IPv4
  const parts = bare.split(".").map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) return false;
  const [a, b] = parts;
  return (
    a === 0 ||                            // 0.0.0.0/8  "this host" — 0.0.0.0 reaches localhost on *nix
    a === 127 ||                          // 127.0.0.0/8  loopback
    a === 10 ||                           // 10.0.0.0/8   RFC-1918
    (a === 172 && b >= 16 && b <= 31) ||  // 172.16.0.0/12 RFC-1918
    (a === 192 && b === 168) ||           // 192.168.0.0/16 RFC-1918
    (a === 169 && b === 254)              // 169.254.0.0/16 link-local (AWS metadata etc.)
  );
}

// Complete set of action types the agent runtime recognises. Anything outside
// this set is denied by the policy gate — unknown types must not be silently
// permitted, as a prompt-injected page could manufacture novel type strings
// that get logged as policy_allow:true and then fail silently at runtime.
const KNOWN_ACTION_TYPES = new Set([
  // Navigation
  "navigate", "new_tab", "switch_tab", "close_tab", "list_tabs",
  "go_back", "go_forward", "refresh",
  // Pointer / keyboard
  "click", "double_click", "right_click", "drag", "hold", "scroll", "scroll_wheel", "hover",
  "hover_then_shoot",
  "type", "key", "select", "file_upload", "paste",
  // Observation
  "screenshot", "read", "zoom_canvas", "scan_canvas",
  // Data extraction
  "script", "fetch", "extract", "find_text",
  // Memory / history
  "remember", "bookmark", "history", "history_search",
  // Clipboard / downloads / files
  "clipboard_read", "clipboard_write", "download", "read_download", "downloads_list", "write_file",
  // Async helpers
  "watch_region", "wait", "wait_for", "listen",
  // Flow control
  "done", "abort", "ask_user", "ask_vision", "next_subtask",
  // Compound
  "batch", "repeat", "tool",
]);

export function evaluateAction(action, currentUrl, policy) {
  const t = action.type;

  if (!KNOWN_ACTION_TYPES.has(t)) {
    return new PolicyDecision(false, `unknown action type: "${t}" — not in permitted action set`);
  }

  if (t === "batch") {
    if (!Array.isArray(action.actions) || action.actions.length === 0) {
      return new PolicyDecision(false, "batch action has no actions list");
    }
    for (const subAction of action.actions) {
      const decision = evaluateAction(subAction, currentUrl, policy);
      if (!decision.allow) {
        return decision;
      }
    }
    return new PolicyDecision(true, "batch permitted by policy");
  }

  if (["read", "wait", "done", "ask_user", "ask_vision",
       "go_back", "go_forward", "refresh",
       "switch_tab"].includes(t)) {
    return new PolicyDecision(true, "non-side-effecting");
  }

  if (["navigate", "new_tab"].includes(t)) {
    const url = action.url;
    if (policy.isSensitive(url)) {
      return new PolicyDecision(false, "destination is on sensitive-domain list", true);
    }
    if (!policy.isAllowed(url)) {
      return new PolicyDecision(false, "destination not on allowlist", true);
    }
    return new PolicyDecision(true, "navigation permitted");
  }

  if (!currentUrl) {
    return new PolicyDecision(false, "no current page context");
  }
  if (policy.isSensitive(currentUrl)) {
    return new PolicyDecision(false, "current page is on sensitive-domain list", true);
  }
  if (!policy.isAllowed(currentUrl)) {
    return new PolicyDecision(false, "current page not on allowlist", true);
  }

  if (t === "type" && action.isSensitive) {
    return new PolicyDecision(false, "action targets sensitive field", true);
  }

  // Script actions that contain network calls (fetch, XHR, sendBeacon, WebSocket) can
  // exfiltrate page data to arbitrary URLs, bypassing the extension-level fetch policy
  // because the call runs in the PAGE context rather than the service worker.
  // Require user confirmation for any script that appears to make a network call.
  if (t === "script" && action.code) {
    const NET_PATTERN = /\bfetch\s*\(|\bnew\s+XMLHttpRequest\b|\bnavigator\s*\.\s*sendBeacon\s*\(|\bnew\s+WebSocket\s*\(|\bimportScripts\s*\(/i;
    if (NET_PATTERN.test(action.code)) {
      return new PolicyDecision(false, "script contains a network call — confirm before executing", true);
    }
  }

  // Cross-origin fetch must be confirmed by the user — the LLM cannot self-authorize it.
  // Same-origin fetches (e.g. user automating their own router at 192.168.1.1) are allowed
  // because the user is already on that page. SSRF blocking only applies to cross-origin
  // fetches to private ranges (to prevent the LLM from pivoting to internal services).
  if (t === "fetch") {
    if (!action.url) return new PolicyDecision(false, "fetch requires a url");
    let fetchUrl;
    try {
      fetchUrl = new URL(action.url);
    } catch (_) {
      return new PolicyDecision(false, "fetch has an invalid url");
    }
    const hostname = fetchUrl.hostname.toLowerCase();
    const fetchOrigin = fetchUrl.origin;
    const pageOrigin  = currentUrl ? new URL(currentUrl).origin : null;
    // Same-origin: always permitted (user is already on the page)
    if (pageOrigin && fetchOrigin === pageOrigin) {
      return new PolicyDecision(true, "same-origin fetch permitted");
    }
    // Cross-origin to private/loopback: hard block (SSRF)
    if (_isPrivateHost(hostname)) {
      return new PolicyDecision(false, `cross-origin fetch to private address ${hostname} is not permitted`);
    }
    // Cross-origin to public internet: require user confirmation
    return new PolicyDecision(false, `cross-origin fetch to ${fetchOrigin}`, true);
  }

  // download writes remote content to disk — same egress policy as fetch:
  // same-origin allowed, private ranges hard-blocked (SSRF), cross-origin confirmed.
  if (t === "download") {
    if (!action.url) return new PolicyDecision(false, "download requires a url");
    let dlUrl;
    try {
      dlUrl = new URL(action.url);
    } catch (_) {
      return new PolicyDecision(false, "download has an invalid url");
    }
    const dlHost = dlUrl.hostname.toLowerCase();
    const dlOrigin = dlUrl.origin;
    const pageOrig = currentUrl ? new URL(currentUrl).origin : null;
    if (pageOrig && dlOrigin === pageOrig) {
      return new PolicyDecision(true, "same-origin download permitted");
    }
    if (_isPrivateHost(dlHost)) {
      return new PolicyDecision(false, `cross-origin download from private address ${dlHost} is not permitted`);
    }
    return new PolicyDecision(false, `cross-origin download from ${dlOrigin}`, true);
  }

  if (t === "clipboard_write") {
    return new PolicyDecision(false, "writing to clipboard requires confirmation", true);
  }

  return new PolicyDecision(true, "permitted by policy");
}

export class AuditLogger {
  static async record(entry) {
    try {
      const { auditLogs } = await chrome.storage.local.get({ auditLogs: [] });
      
      const recordEntry = {
        ts: Date.now() / 1000,
        event: entry.event,
        task_id: entry.taskId,
        step: entry.step,
        url: entry.url || null
      };

      if (entry.action) {
        recordEntry.thought = (entry.action.thought || "").substring(0, 300);
        const act = entry.action.action;
        recordEntry.action_type = act.type;
        
        if (act.type === "type") {
          recordEntry.text = act.isSensitive ? await maskText(act.text) : (act.text || "").substring(0, 200);
          recordEntry.target_ref = act.ref || null;
          recordEntry.is_sensitive = !!act.isSensitive;
        } else if (act.type === "navigate") {
          recordEntry.url_to = act.url;
        } else {
          const params = { ...act };
          delete params.reasoning;
          recordEntry.params = params;
        }
      }

      if (entry.decision) {
        recordEntry.policy_allow = entry.decision.allow;
        recordEntry.policy_reason = entry.decision.reason;
      }
      
      if (entry.extra) {
        recordEntry.extra = entry.extra;
      }

      auditLogs.push(recordEntry);
      
      if (auditLogs.length > 1000) {
        auditLogs.shift();
      }
      
      await chrome.storage.local.set({ auditLogs });
    } catch (e) {
      console.error("Audit log failed:", e);
    }
  }
}
