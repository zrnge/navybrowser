# Navy — Chrome Web Store Permission Justification

This document is the authoritative justification for every permission and host access requested by the Navy browser extension. It is intended for use in the Chrome Web Store submission form's "Permission Justification" and "Why does your extension need this permission?" fields.

---

## Extension Purpose (Single Purpose Statement)

Navy is a browser automation agent. The user types a natural-language goal ("fill this form", "find the cheapest flight", "click Accept on every cookie banner on this tab") and Navy carries out that goal autonomously by controlling the browser using the Chrome DevTools Protocol (CDP). All processing runs inside the browser's service worker — there is no remote server, no backend, and no installation required beyond loading the extension.

---

## Permission Justifications

### `debugger`

**Why it is needed:**
The `debugger` permission grants access to the Chrome DevTools Protocol (CDP). CDP is the only mechanism in Chrome that allows an extension to:

- Capture a screenshot of the current page viewport (`Page.captureScreenshot`)
- Read the page's full accessibility tree to identify interactive elements (`Accessibility.getFullAXTree`)
- Simulate precise mouse click coordinates (`Input.dispatchMouseEvent`)
- Simulate keyboard input (`Input.dispatchKeyEvent`)
- Inject Set-of-Marks visual overlays that number every interactive element on the screen so the AI can reference them by index
- Monitor network idle state to know when a navigation or form submission has completed

No alternative API (content scripts, `scripting`, `webNavigation`, `webRequest`) provides equivalent control over a tab's visual state and input simulation. Content scripts cannot take screenshots or read the full accessibility tree. The `chrome.tabs.captureVisibleTab` API does not provide accessibility data or input simulation. CDP is architecturally required.

**Scope of use:**
The debugger is attached only to the single tab currently being automated. It is detached immediately when:
- The task ends (success or failure)
- The user presses the panic-stop shortcut (`Ctrl+Shift+.`)
- The automated tab is closed
- The user stops the task from the control panel

The extension never attaches the debugger to more than one tab simultaneously and never attaches it passively (without an explicit user-initiated task).

---

### `<all_urls>` (host permission)

**Why it is needed:**
Navy is a general-purpose automation tool. The user can direct it to any website — an internal company dashboard, a public e-commerce site, a government form portal, a web application the user built themselves. There is no way to know in advance which URLs the user will automate, so the extension requires access to all origins to function.

The `<all_urls>` permission is used exclusively to:
1. Attach the CDP debugger to the active tab (the debugger requires host permission for the tab's origin)
2. Inject the Set-of-Marks overlay via `chrome.scripting.executeScript`
3. Read form state from the active tab via `chrome.scripting.executeScript`

**Mitigations in place:**
- Navy operates on one tab at a time. It does not scan or inject into other tabs.
- A built-in sensitive-domain block list prevents automatic operation on banking, identity, and crypto sites. These sites require explicit per-session user confirmation before Navy attaches.
- Users can add their own denylist of domains in settings.
- The debugger is detached from any tab when the task ends.

---

### `scripting`

**Why it is needed:**
`chrome.scripting.executeScript` is used for two purposes:

1. **Set-of-Marks overlay injection:** Navy injects a visual overlay that draws numbered red boxes over every interactive element on the page. This gives the AI model a coordinate-free way to reference elements by index, improving accuracy significantly over pixel-coordinate-only targeting.

2. **Form state reading:** Navy reads current form field values so the AI can understand what has already been filled in and avoid re-entering data. This requires injecting a small function into the page context to enumerate `<input>`, `<select>`, and `<textarea>` elements.

Both uses are scoped to the single tab being automated, triggered only while a task is running, and not used passively.

---

### `tabs`

**Why it is needed:**
The `tabs` permission (which grants access to the `url` and `title` properties of tabs) is required for:

1. **Navigation awareness:** Knowing the current URL and page title so the AI can reason about where it is in a multi-step task.
2. **Tab management actions:** The user can ask Navy to open a new tab, switch between tabs (e.g., "go back to the previous tab"), or close a tab as part of a task.
3. **Tab group management:** Navy groups its working tab into a Chrome tab group so the user can visually distinguish automated tabs from their personal tabs.
4. **Listing tabs in scope:** When the user asks "what tabs are open?", Navy returns only the tabs in the current window or task group — not all tabs across all windows.

---

### `activeTab`

**Why it is needed:**
`activeTab` provides access to the currently focused tab. It is used to identify which tab the user wants to automate when they open the control panel and initiate a task. Without it, Navy cannot determine the starting tab for a new task.

---

### `storage`

**Why it is needed:**
`chrome.storage.local` stores:
- Provider settings (which AI provider, base URL, model name)
- The user's API key for cloud providers (never transmitted anywhere other than the configured API endpoint)
- Task audit logs (the last 1,000 step records for transparency)
- Debug logs (the last 500 log entries, exportable by the user)
- User's domain allowlist/denylist preferences

`chrome.storage.session` stores:
- The current conversation/task history (cleared when the browser closes)

No data is written to `chrome.storage.sync` — nothing is sent to Google's servers via Chrome Sync.

---

### `sidePanel`

**Why it is needed:**
Navy's entire user interface lives in Chrome's side panel (`chrome.sidePanel`). The side panel shows the task input field, the live step-by-step timeline of what the agent is doing, the settings drawer, and the stop/panic button. Without `sidePanel`, there is no UI surface for the extension.

---

### `tabCapture`

**Why it is needed:**
`tabCapture` captures the raw audio stream from the active tab. It is used exclusively for the `listen` action, which:
- Transcribes audio CAPTCHAs (the user can ask Navy to "solve the audio CAPTCHA")
- Reads spoken content from pages that use text-to-speech

Audio is never captured passively. It is only captured when the agent decides (or the user explicitly requests) to use the `listen` action as part of a running task. The audio clip is sent to a Whisper-compatible transcription endpoint that the user configures (e.g., a local Whisper server or a cloud speech API endpoint).

---

### `offscreen`

**Why it is needed:**
Chrome's Manifest V3 service workers do not have access to `MediaRecorder` or `AudioContext`, which are required to record and encode audio from a captured tab stream. The `offscreen` permission allows Navy to create an offscreen document (a hidden page context that runs in parallel with the service worker) where `MediaRecorder` can operate. This is the architecturally correct and Chrome-recommended way to handle audio recording from a service worker extension.

The offscreen document only runs while an active audio capture is in progress and is destroyed when the capture ends.

---

### `tabGroups`

**Why it is needed:**
When Navy starts a task, it moves the automated tab into a Chrome tab group labeled "Navy" so the user can visually distinguish it from their personal browsing. When the task ends, the group is cleaned up. This requires `tabGroups` to create, update, and remove tab group assignments. It is a UX quality-of-life feature with no security implications.

---

### `clipboardWrite`

**Why it is needed:**
When a task completes, the user can click a "Copy result" button in the side panel to copy the agent's final summary to the clipboard. `clipboardWrite` is required to write to the clipboard programmatically from the extension context. It is used only on explicit user action and never invoked during an automated task without user instruction.

---

### `downloads`

**Why it is needed:**
The Settings panel includes an "Export Debug Logs" button that saves the local debug log to a JSON file on the user's machine via `chrome.downloads.download`. This is the only use. The downloaded file goes to the browser's default downloads folder and is never sent to any server.

---

## Remote Code Execution Policy

Navy does not load, execute, or inject any remotely hosted code. All JavaScript runs from the locally installed extension package. The only network requests Navy makes are:

1. Calls to the AI provider API endpoint configured by the user (to send page state and receive the next action)
2. The `fetch` action, which runs inside the automated tab's page context using the tab's existing session credentials — and only with explicit user confirmation for any cross-origin request

The extension's Content Security Policy (`"script-src 'self'; object-src 'self';"`) enforces this at the browser level.

---

## Data Handling Summary

| Data type | Where it goes | Who can see it |
|---|---|---|
| Screenshots, page text, accessibility tree, form state | AI provider API endpoint configured by user | User + their chosen AI provider |
| API key | `chrome.storage.local` on user's device | User only |
| Audit log, debug log | `chrome.storage.local` on user's device | User only |
| Task history | `chrome.storage.session` on user's device (cleared on browser close) | User only |

The extension developer (Zrnge) receives no data of any kind from any user. There is no analytics, no telemetry, and no collection infrastructure.

Full privacy policy: [PRIVACY.md](PRIVACY.md)
