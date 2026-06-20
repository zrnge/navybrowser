# Navy — Privacy Policy

**Effective date:** 2025-06-20  
**Extension:** Navy v0.1.0  
**Developer:** Zrnge — [https://github.com/zrnge/navybrowser](https://github.com/zrnge/navybrowser)

---

## Overview

Navy is a browser automation extension that uses an AI model to carry out tasks on web pages on your behalf. This policy describes exactly what data Navy touches, what it sends, what it stores, and what it never does.

**Short version:** Navy sends page content to the AI provider you configure. If you use a local provider (Ollama or LM Studio), no data leaves your machine. If you use a cloud provider (Anthropic, OpenAI, etc.), the content of the pages you are automating is sent to that provider. Navy's developer never receives any of your data.

---

## 1. What Data Navy Accesses

When you run an automation task, Navy collects the following from the active browser tab to enable the AI to reason about the page:

| Data type | What it is | Used for |
|---|---|---|
| **Screenshot** | A JPEG image of the current tab viewport (up to 1280 px wide) | AI visual reasoning |
| **Accessibility tree** | Structured list of interactive elements on the page (buttons, inputs, links, text) with their labels and positions | AI element targeting |
| **Visible page text** | Up to 12,000 characters of text visible on screen | AI context |
| **Form field state** | Current values of visible text inputs (up to 100 chars each). Fields whose type is `password` or whose name matches credential-like patterns (password, token, API key, OTP, PIN, CVV, SSN, etc.) are withheld and never sent to the AI. | AI form-filling context |
| **Page URL and title** | The current URL and document title | AI planning and navigation |
| **Tab audio** | Raw audio stream from the active tab, converted to a short audio clip | Only when you explicitly invoke the "listen" action (e.g., for audio CAPTCHAs). Never recorded passively. |
| **Conversation history** | The sequence of steps Navy has taken in the current task | AI multi-step planning |

Navy does **not** access:
- Other tabs beyond the one currently being automated (unless you ask Navy to switch tabs)
- Your browser history
- Saved passwords or the password manager
- Files on your local machine
- Your camera or microphone

---

## 2. Where Your Data Goes

Where your data is sent depends entirely on which AI provider you configure in Navy's settings.

### Local providers — no data leaves your machine

If you configure **Ollama** or **LM Studio**, all AI processing happens on your own computer. Page content, screenshots, and conversation history are sent to `localhost` only. Nothing is transmitted to any external server.

### Cloud providers — page content is sent to the provider you choose

If you configure a cloud AI provider, Navy sends page content (screenshots, accessible text, form state, conversation history) to that provider's API in order to perform the task. The providers currently supported are:

| Provider | API endpoint | Their privacy policy |
|---|---|---|
| Anthropic (Claude) | api.anthropic.com | [anthropic.com/legal/privacy](https://www.anthropic.com/legal/privacy) |
| OpenAI (ChatGPT, GPT-4) | api.openai.com | [openai.com/privacy](https://openai.com/privacy) |
| Google (Gemini) | generativelanguage.googleapis.com | [policies.google.com/privacy](https://policies.google.com/privacy) |
| DeepSeek | api.deepseek.com | [deepseek.com/privacy](https://www.deepseek.com/privacy) |
| xAI (Grok) | api.x.ai | [x.ai/legal/privacy-policy](https://x.ai/legal/privacy-policy) |
| Groq | api.groq.com | [groq.com/privacy-policy](https://groq.com/privacy-policy) |
| z.ai | api.z.ai | [z.ai/privacy](https://z.ai/privacy) |
| OpenRouter | openrouter.ai | [openrouter.ai/privacy](https://openrouter.ai/privacy) |
| Custom endpoint | URL you provide | Your endpoint's policy |

**Navy only sends data to the provider you have selected.** It does not send data to multiple providers or to any provider you have not configured.

**Navy's developer (Zrnge) never receives any page content, screenshots, task data, or personal information.** There are no analytics, no telemetry, and no collection of any kind by the extension developer.

---

## 3. What Data Is Stored Locally

Navy stores the following data on your device using Chrome's extension storage APIs:

| What | Where | Retention |
|---|---|---|
| **AI provider settings** (provider name, model name, base URL) | `chrome.storage.local` | Until you change or clear settings |
| **API key** | `chrome.storage.local` | Until you remove it. Never logged or transmitted anywhere other than the configured API endpoint. |
| **Task audit log** | `chrome.storage.local` | Last 1,000 task step entries. Automatically rotated. Credential-looking values (detected by pattern) are SHA-256 hashed before being written. |
| **Chat history** | `chrome.storage.session` | Current browser session only. Cleared when the browser closes. |
| **Debug logs** | `chrome.storage.local` | Last 500 log entries. Exportable by you via the Settings panel. |

None of this data is synced to Chrome Sync or transmitted anywhere by Navy.

---

## 4. Sensitive Sites

Navy maintains a built-in list of sensitive domains (banking, identity, and password manager sites) where it will not automatically operate. These sites require explicit user confirmation before Navy attaches to them. The built-in list includes sites such as major banks, PayPal, 1Password, Bitwarden, and government tax portals.

You can extend this list with your own sites in Navy's settings.

---

## 5. Permissions and Why Navy Needs Them

Navy requests the following Chrome permissions:

| Permission | Why it is needed |
|---|---|
| `debugger` | Attaches Chrome DevTools Protocol to the active tab — the only way to take screenshots, read the accessibility tree, and simulate precise mouse/keyboard input without injecting persistent content scripts |
| `scripting` | Injects Set-of-Marks visual overlays on the page and reads form state |
| `<all_urls>` (host permission) | Navy must be able to automate any site the user directs it to |
| `tabs` | Reads the URL and title of the active tab; required for tab management actions |
| `activeTab` | Focuses and attaches to the tab currently being automated |
| `storage` | Saves settings, API keys, and audit logs locally |
| `sidePanel` | Displays the Navy control panel in Chrome's side panel |
| `tabCapture` | Captures audio from the active tab for the "listen" action (audio CAPTCHAs, spoken content) |
| `offscreen` | Runs audio recording in an offscreen document (required by Chrome for MediaRecorder in service workers) |
| `alarms` | Schedules watchdog checks for the debugger connection |
| `tabGroups` | Organizes Navy's working tabs into a Chrome tab group for cleaner UX |
| `clipboardWrite` | Lets you copy task results to the clipboard |
| `downloads` | Exports debug logs when you click "Export Debug Logs" in Settings |

The `debugger` permission is attached only to the tab currently being automated. It is detached when the task ends, when you press the panic-stop shortcut (Ctrl+Shift+.), or when the tab is closed.

---

## 6. What Navy Never Does

- Never reads or stores your browser history
- Never accesses saved passwords
- Never transmits data to the extension developer (Zrnge)
- Never runs analytics or telemetry of any kind
- Never operates on banking/identity sites without your explicit confirmation
- Never records audio passively — tab audio is only captured when the `listen` action is explicitly triggered as part of a task
- Never executes on Chrome's own Web Store pages or internal browser pages

---

## 7. Your Controls

- **Stop any task instantly:** `Ctrl+Shift+.` (Windows/Linux) or `Cmd+Shift+.` (Mac), or click Stop in the panel
- **Clear local data:** Remove the extension or clear its storage via Chrome's extension management page
- **Remove your API key:** Settings → delete the key field and save
- **Export your audit log:** Settings → Export Debug Logs — the data goes to a file on your machine only
- **Restrict sites:** Settings → add domains to your personal denylist

---

## 8. Changes to This Policy

If this policy changes materially, the effective date above will be updated and a note will be added to the GitHub repository's changelog. Continued use of the extension after a policy update constitutes acceptance of the new terms.

---

## 9. Contact

Questions or concerns about this policy:  
Open an issue at [https://github.com/zrnge/navybrowser/issues](https://github.com/zrnge/navybrowser/issues)
