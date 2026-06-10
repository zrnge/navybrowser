// security.js — Security policy gate and auditing for Navy.

export const BUILTIN_SENSITIVE_DOMAINS = [
  "chase.com",
  "bankofamerica.com",
  "paypal.com",
  "1password.com",
  "bitwarden.com",
  "irs.gov",
  "login.gov",
  "coinbase.com"
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
    if (this.uncensored) return false;
    const host = getHostname(url);
    if (!host) return false;

    for (const blocked of this.userDenylist) {
      if (host === blocked || host.endsWith("." + blocked)) return true;
    }
    for (const blocked of BUILTIN_SENSITIVE_DOMAINS) {
      if (host === blocked || host.endsWith("." + blocked)) return true;
    }
    return false;
  }

  isAllowed(url) {
    if (this.uncensored) return true;
    const host = getHostname(url);
    if (!host) return false;

    if (this.isSensitive(url)) return false;
    if (!this.strictAllowlist) return true;

    for (const allowed of this.allowlist) {
      if (host === allowed || host.endsWith("." + allowed)) return true;
    }
    return false;
  }
}

const INJECTION_PATTERNS = [
  /ignore\s+(\w+\s+){0,3}(previous|above|prior)\s+instructions?/i,
  /disregard\s+(\w+\s+){0,3}(previous|above|prior)/i,
  /new\s+instructions?\s*[:-]/i,
  /system\s*(prompt|message)\s*[:-]/i,
  /<\/?(system|instruction|prompt)>/i,
  /you\s+are\s+now\s+(a|an)\s+/i,
  /forget\s+(everything|your\s+instructions)/i,
  /send\s+(the\s+)?(user'?s?\s+)?(cookies|password|credentials)/i,
  /navigate\s+to\s+https?:\/\//i,
  /click\s+(this|the\s+following)\s+link/i
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

const CRED_FIELD_HINTS = /(password|passwd|pwd|secret|token|api[_-]?key|ssn|social|card[_-]?number|cvv|cvc|pin|otp|2fa|mfa)/i;

export function looksLikeCredentialField(fieldName, fieldType) {
  if (fieldType && fieldType.toLowerCase() === "password") return true;
  if (fieldName && CRED_FIELD_HINTS.test(fieldName)) return true;
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

export function evaluateAction(action, currentUrl, policy) {
  const t = action.type;

  if (["read", "wait", "done", "ask_user", "abort"].includes(t)) {
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
