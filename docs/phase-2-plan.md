# Phase 2 plan — the Chrome extension

This is the implementation plan for Phase 2: the Manifest V3 Chrome extension that detects ```` ```bugger ```` blocks on claude.ai, dispatches them to the local daemon (Phase 1), and injects the worker's result back into the chat as a user message.

The settled design decisions (from review) are baked in:

- **Detection:** DOM scraping with fallback selectors; MutationObserver on the message-stream container. Selector logic is the single highest-risk maintenance point and is structured to fail loudly with clear console signals when claude.ai changes.
- **Result submission:** programmatic textarea fill → `input` event → click Send button. Same defensive selector pattern.
- **Auto-submit by default**, with a `manual` mode toggle (type-but-don't-submit) in settings for sanity-checking.
- **Tab binding** via `chrome.storage.session` keyed by `tab.id`. Lives as long as the tab is open; cleared on browser restart.
- **Polling:** adaptive — 1s for the first 10s, 3s thereafter.
- **Service worker** does *not* try to stay alive. It handles popup wiring and daemon `/config` fetches only. The content script (alive as long as the tab is open) owns the polling loop.
- **Manifest permissions:** `activeTab`, `storage`, host permissions for `https://claude.ai/*` and `http://localhost:8765/*`. Nothing more.

---

## File layout under `extension/`

```
extension/
├── manifest.json                  — MV3 manifest, references dist/*.js
├── popup.html                     — popup chrome (references dist/popup.js + popup.css)
├── popup.css                      — popup styles (hand-written, ~50 lines)
├── icons/
│   ├── bug-gray.png               — 16/32/48/128 px exports; daemon unreachable OR unbound
│   ├── bug-green.png              — 16/32/48/128 px; bound, daemon reachable
│   └── bug-orange.png             — 16/32/48/128 px; dispatch in flight
├── .gitignore                     — node_modules/, dist/
├── package.json                   — devDeps: esbuild, typescript, @types/chrome
├── tsconfig.json
├── build.mjs                      — esbuild wrapper (~30 lines)
└── src/
    ├── background.ts              — service worker: icon updates, /config fetch, tab cleanup
    ├── content.ts                 — content script: detect blocks, dispatch, poll, inject
    ├── popup.ts                   — popup UI: bind/rebind, ping, status display
    └── lib/
        ├── daemonClient.ts        — fetch wrappers for daemon endpoints
        ├── selectors.ts           — selector strategies + fallbacks (the maintenance hotspot)
        └── tabBinding.ts          — chrome.storage.session glue
```

Build outputs land in `extension/dist/` (gitignored). To load as an unpacked extension: build, then point Chrome at `extension/`.

I'm using **esbuild** instead of vite/rollup because:
- Single dep, no plugin ecosystem to track
- Bundles content scripts as IIFE (MV3-friendly), service worker as ESM (MV3 supports this)
- ~30-line build script does everything

TypeScript matches the daemon's discipline and `@types/chrome` is excellent.

---

## `manifest.json` shape

```jsonc
{
  "manifest_version": 3,
  "name": "Little Bugger",
  "version": "0.1.0",
  "description": "Routes claude.ai manager dispatches to Claude Code on this machine.",

  "permissions": ["activeTab", "storage"],
  "host_permissions": [
    "https://claude.ai/*",
    "http://localhost:8765/*"
  ],

  "background": {
    "service_worker": "dist/background.js",
    "type": "module"
  },

  "content_scripts": [
    {
      "matches": ["https://claude.ai/*"],
      "js": ["dist/content.js"],
      "run_at": "document_idle"
    }
  ],

  "action": {
    "default_popup": "popup.html",
    "default_title": "Little Bugger",
    "default_icon": {
      "16": "icons/bug-gray-16.png",
      "32": "icons/bug-gray-32.png",
      "48": "icons/bug-gray-48.png",
      "128": "icons/bug-gray-128.png"
    }
  },

  "icons": {
    "16": "icons/bug-gray-16.png",
    "32": "icons/bug-gray-32.png",
    "48": "icons/bug-gray-48.png",
    "128": "icons/bug-gray-128.png"
  }
}
```

Notes:
- No `tabs` permission. We only need the active tab's URL/ID and what messages we get sent — `activeTab` covers that.
- No `<all_urls>`. Host permissions are explicit.
- `"type": "module"` lets background.ts import from lib/.
- Content script runs at `document_idle` so claude.ai's SPA has mounted before our observer attaches.

---

## Content script architecture

### Selector strategy

Lives in `lib/selectors.ts`. **This module is the single highest-risk maintenance point** — when claude.ai redesigns, this is the file that breaks. The design accepts that and makes failure obvious:

```ts
type SelectorAttempt = {
  description: string;   // human-readable: "data-testid based"
  selector: string;      // CSS selector
};

function firstMatch(root: ParentNode, attempts: SelectorAttempt[], label: string): Element | null {
  for (const attempt of attempts) {
    try {
      const el = root.querySelector(attempt.selector);
      if (el) return el;
    } catch (err) { /* invalid selector — skip */ }
  }
  console.warn(`[bugger] selector miss: ${label} (tried ${attempts.length} strategies)`);
  return null;
}
```

Each find function has 2–3 fallback strategies, ordered from most-specific to most-generic:

```ts
// Where messages stream into the DOM
export function findMessageStream(): Element | null {
  return firstMatch(document, [
    { description: "data-testid",      selector: "[data-testid='conversation-turn-list']" },
    { description: "aria-role main",   selector: "main [role='log']" },
    { description: "generic main",     selector: "main" },
  ], "message stream container");
}

// Within a message, find bugger code blocks
export function findBuggerBlocks(messageNode: Element): Element[] {
  // Strategy 1: language class
  const byClass = messageNode.querySelectorAll('pre code.language-bugger, code[class*="bugger"]');
  if (byClass.length) return [...byClass];
  // Strategy 2: pre with a sibling/preceding header showing "bugger"
  const allPre = messageNode.querySelectorAll("pre");
  const matched: Element[] = [];
  for (const pre of allPre) {
    const text = pre.textContent ?? "";
    // Heuristic: language label often sits as a header element near the pre
    const header = pre.previousElementSibling?.textContent?.trim().toLowerCase();
    if (header === "bugger") matched.push(pre);
  }
  return matched;
}

// The textarea where user types
export function findInputTextarea(): HTMLElement | null {
  return firstMatch(document, [
    { description: "ProseMirror",       selector: 'div[contenteditable="true"][role="textbox"]' },
    { description: "data-testid",       selector: "[data-testid='chat-input']" },
    { description: "fallback textarea", selector: "textarea" },
  ], "chat input") as HTMLElement | null;
}

export function findSendButton(): HTMLElement | null {
  return firstMatch(document, [
    { description: "aria-label send",   selector: 'button[aria-label*="Send" i]' },
    { description: "data-testid send",  selector: "[data-testid='send-button']" },
    { description: "submit type",       selector: 'button[type="submit"]' },
  ], "send button") as HTMLElement | null;
}
```

The console warnings give us a debugging breadcrumb when claude.ai changes. When all attempts fail, the action degrades gracefully (no dispatch happens, the popup can surface "selectors stale — extension needs an update"). It does not crash the page.

### MutationObserver target

Single observer attached to the result of `findMessageStream()`. Watches `childList: true, subtree: true` — captures new message turns and content inside them as they stream.

```ts
const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        scanForBlocks(node as Element);
      }
    }
  }
});
```

On `content.ts` init: find the stream container, scan the *existing* DOM once to mark all pre-existing `bugger` blocks as "seen, not dispatched" (no re-dispatch on page reload), then attach the observer for new additions.

If `findMessageStream()` returns null at init: retry every 500ms for up to 30s. If still null after that: surface via popup ("can't locate claude.ai message container; extension may need an update"). The content script stays loaded but does nothing.

### Block detection logic

```
content.ts initializes
   ↓
mark all currently-visible bugger blocks as { id, dispatched: false, seen: true }
   ↓
attach MutationObserver
   ↓
on mutation: scan added nodes for new bugger blocks
   ↓
for each new block:
   - extract prompt text
   - check if assistant message is "complete" (see streaming note below)
   - if complete and not already dispatched: dispatch
```

**Block identity:** each block gets an in-memory id = SHA-1 of (content + nearest message container's DOM position or message ID). This dedupes:
- The same block firing MO multiple times due to re-renders
- Streaming updates where the block's container DOM node changes but content stabilizes

**Streaming completion:** assistant messages stream token by token. A premature dispatch (mid-stream, before the closing ` ``` ` arrives) would send a half-formed prompt. Detection rule:
- The block's content must contain a balanced opening + closing fence
- Heuristic: check if the message turn has a "streaming" indicator (claude.ai usually marks streaming turns with an aria-busy attribute or a visible "stop" button). Wait for that to clear before dispatching.
- Fallback: if we can't detect streaming state, debounce: dispatch only 500ms after the last mutation on this block. If the content changes within that window, reset the timer.

In-memory dispatched-block registry. Not persisted — page reload re-marks everything as seen-but-not-dispatched (correct behavior; we don't re-dispatch historical blocks).

### Polling loop

Per in-flight job, the content script runs:

```ts
async function pollJob(jobId: string): Promise<JobResult> {
  const start = Date.now();
  while (true) {
    const elapsed = Date.now() - start;
    const delay = elapsed < 10_000 ? 1000 : 3000;
    await sleep(delay);
    const job = await daemonClient.getJob(jobId);
    if (job.status === "succeeded" || job.status === "failed") return job;
    if (!job) throw new Error("job not found — daemon may have restarted");
  }
}
```

Each polling loop is independent. Multiple in-flight dispatches → multiple loops running in parallel.

The orange-pulsing icon: while *any* polling loop is active in *any* tab, the SW gets a message and updates the action icon to orange. When all loops settle (per tab), back to green. Pulsing implementation: alternate between two slightly-different orange variants on a 500ms timer; cheap, works.

### Result injection

When a job terminates:

```ts
function formatResult(job: JobResult): string {
  const parts = ["Worker result:", ""];
  if (job.status === "failed") {
    parts.push(`Status: FAILED (exit ${job.exitCode ?? "n/a"})`);
    if (job.error) parts.push(`Error: ${job.error}`);
    parts.push("");
  }
  if (job.output) parts.push(job.output);
  if (job.diffSummary) {
    parts.push("");
    parts.push("Diff:");
    parts.push(job.diffSummary);
  }
  return parts.join("\n");
}
```

Then:

```ts
async function injectResult(text: string): Promise<void> {
  const input = findInputTextarea();
  if (!input) { surfaceError("can't find input textarea"); return; }

  // claude.ai uses ProseMirror — setting .value or .innerText alone doesn't
  // notify the editor. Use the InputEvent path that ProseMirror listens for.
  input.focus();
  document.execCommand("insertText", false, text);
  // Belt-and-suspenders: also dispatch an input event in case execCommand
  // is deprecated/missing in some Chrome build.
  input.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));

  if (settings.autoSubmit) {
    await new Promise((r) => setTimeout(r, 100)); // let React reconcile
    const send = findSendButton();
    if (!send) { surfaceError("can't find send button"); return; }
    send.click();
  }
}
```

`execCommand("insertText")` is the most-compatible ProseMirror-friendly injection path on Chromium browsers today. If it stops working, the fallback is to dispatch synthetic keyboard events — gnarlier and more brittle, so save it for if/when needed.

---

## Service worker scope

Lean. Only what it must do:

1. **Icon updates per active tab.** On `chrome.tabs.onActivated` and `chrome.runtime.onMessage` (from content scripts signaling "dispatch start/end"), look up the active tab's binding + daemon reachability and call `chrome.action.setIcon`.
2. **Daemon `/config` fetch for the popup.** Popup asks SW: "what projects are available?" SW fetches `http://localhost:8765/config` and returns the list (or a "daemon unreachable" error).
3. **Tab cleanup.** On `chrome.tabs.onRemoved`: delete that tab's binding from `chrome.storage.session` so storage doesn't accumulate stale keys.
4. **Daemon reachability heartbeat.** Light: on SW wake, hit `/health` once and cache the result for 10s. Not a persistent loop — that would fight MV3's lifecycle.

What the SW does **not** do:
- Polling loops (content script owns those)
- Block detection (content script)
- Persistent state beyond `chrome.storage.session` (no IndexedDB needed)
- Listening for claude.ai DOM events

---

## Popup UI

Single-page, ~150 lines of TS, ~50 lines of CSS. Renders one of four states:

| State | Trigger | UI |
|---|---|---|
| **Daemon unreachable** | `/health` fails | Gray icon. "Daemon not running." Help text: how to start it. No bind controls. |
| **Unbound** | Daemon reachable, no binding for this tab | Gray-ish icon. Project dropdown (populated from `/config`), "Bind this tab to ___" button. |
| **Bound, idle** | Binding exists, no in-flight job | Green icon. "Bound to: `<project>`." Rebind button. Ping button. |
| **Bound, dispatching** | Binding exists, ≥1 in-flight job in this tab | Orange (pulsing). "Bound to: `<project>`. Dispatch in flight: 23s elapsed." Cancel button — see open question 1 below. |

UI controls:

- **Project dropdown:** populated from `/config`. If the bound project no longer appears (was removed from daemon's config mid-day), the dropdown shows the bound project at the top with a `(missing)` suffix and a warning.
- **Bind button:** writes `{tabId → projectName}` to `chrome.storage.session`. Notifies content script via `chrome.tabs.sendMessage`. Updates icon.
- **Rebind button:** opens the dropdown for re-selection. Doesn't immediately unbind — only commits on the new "Bind" click.
- **Ping button:** POSTs `/ping {project}` to daemon, polls the returned `jobId`, shows the RTT (`endedAt - createdAt`) when it completes. Just a smoke test for the operator.
- **Settings link:** small gear icon, opens an inline settings pane (still in the popup) with one toggle: **Auto-submit injected results** (default on; off = manual mode).

Layout sketch:

```
┌────────────────────────────┐
│  🐛  Little Bugger          │
├────────────────────────────┤
│  Bound to: my-project   ⚙  │
│                            │
│  Project: [my-project ▼]   │
│  [   Rebind this tab   ]   │
│                            │
│  Status: idle              │
│  Last dispatch: 12s ago    │
│                            │
│  [        Ping         ]   │
└────────────────────────────┘
```

When daemon unreachable:

```
┌────────────────────────────┐
│  🐛  Little Bugger          │
├────────────────────────────┤
│  ⚠ Daemon not reachable.   │
│                            │
│  Start it with:            │
│  node daemon/dist/index.js │
│                            │
│  [     Retry connect    ]  │
└────────────────────────────┘
```

---

## Tab binding flow

```
User opens claude.ai in a new tab
   ↓
content.ts loads → asks SW "what's the binding for me?"
   ↓
SW reads chrome.storage.session[tabId]
   ↓
   ├─ no binding → icon gray, popup will prompt for bind
   └─ binding present → icon green (if daemon reachable), content.ts records it

User clicks toolbar icon
   ↓
popup opens, asks SW for daemon reachability + project list + this tab's binding
   ↓
popup renders one of the four states

User clicks "Bind to my-project"
   ↓
popup writes chrome.storage.session[tabId] = "my-project"
   ↓
popup → SW: "binding changed for tab X"
   ↓
SW updates icon for tab X
   ↓
SW → content.ts (chrome.tabs.sendMessage): "your binding is now my-project"
   ↓
content.ts now dispatches blocks to my-project

User closes the tab
   ↓
chrome.tabs.onRemoved → SW deletes chrome.storage.session[tabId]
```

**Bound project removed from daemon config mid-day:**
- User clicks popup → SW fetches `/config` → project name no longer in list
- Popup shows the binding with `(missing)` warning
- New dispatches from this tab: extension's content.ts POSTs `/dispatch`, daemon returns 404 ("unknown project"), extension injects an error message into the chat: *"Worker dispatch failed — bound project no longer in daemon config. Rebind via 🐛 icon."*
- No silent rebinding. The user decides.

**Browser restart:**
- `chrome.storage.session` clears
- All tabs come up unbound
- User binds again — same projects/different projects, fresh decisions

---

## Defensive failure modes

| Failure | Detection | UX |
|---|---|---|
| Selector not found (claude.ai changed) | Console warn at miss site; popup checks via SW health probe | Popup banner: "Extension can't find chat elements. claude.ai may have updated — please file an issue." |
| Daemon unreachable | `/health` fetch fails | Icon gray. Popup shows daemon-unreachable state. In-flight polling loops surface the failure in the chat as an error injection. |
| `/dispatch` returns 404 (unknown project) | HTTP 404 from daemon | Error injection: "Worker dispatch failed — bound project not in daemon config. Rebind via 🐛 icon." |
| `/dispatch` returns 503 (no API key) | HTTP 503 | Error injection: "Worker dispatch failed — daemon has no Anthropic API key configured." |
| `/jobs/:id` returns 404 (daemon restarted mid-job) | HTTP 404 during poll | Error injection: "Worker dispatch lost — daemon restarted mid-job. Please retry." |
| Job ends in `failed` state | `status === "failed"` | Inject the result with the error context (the manager skill handles this gracefully — manager reads stack traces and decides whether to retry). |
| Input textarea not found at inject time | `findInputTextarea()` null | Surface in popup with the same selector-stale banner. The result is *not* lost — held in content.ts memory; user can manually paste from console if motivated, but the polite v0 fallback is "tell the user to update the extension." |
| Send button not found | `findSendButton()` null | Falls back to manual mode for this dispatch: textarea is filled, just not auto-submitted. User clicks Send. |
| Multiple dispatches in flight | by design | Each polls independently. Results inject in the order they complete (which may not match dispatch order if one prompt finishes faster). See open question 1 for ordering caveats. |

---

## Dispatch flow trace (end-to-end)

```
1. Manager assistant turn streams into the DOM
   |
   |  At some point, a `bugger` block appears in the message:
   |     ```bugger
   |     Run the test suite.
   |     ```
   |
2. MutationObserver fires; scanForBlocks() finds the new <pre> element
   |
   |  Block content extracted: "Run the test suite."
   |  Block id computed: sha1("Run the test suite." + messageElementPath)
   |  Streaming-complete check: assistant turn no longer has aria-busy → proceed
   |  Dispatch registry: id not seen → mark dispatched, fire request
   |
3. content.ts → POST http://localhost:8765/dispatch
   |     body: {"project": "my-project", "prompt": "Run the test suite."}
   |
4. Daemon → {"jobId": "uuid-1"}
   |
5. content.ts → chrome.runtime.sendMessage: "dispatch started in tab X"
   |     SW → chrome.action.setIcon: orange for tab X
   |
6. content.ts starts pollJob("uuid-1"):
   |     t+1s: GET /jobs/uuid-1 → {status: "running"}
   |     t+2s: GET /jobs/uuid-1 → {status: "running"}
   |     ...
   |     t+12s: GET /jobs/uuid-1 → {status: "succeeded", output: "...", diffSummary: "..."}
   |
7. content.ts formats result:
   |     "Worker result:
   |
   |      Tests passed. 42 of 42 ok.
   |
   |      Diff:
   |       src/foo.ts | 3 +++
   |       ..."
   |
8. content.ts → injectResult(text)
   |     - findInputTextarea() → ProseMirror div
   |     - focus, execCommand("insertText", ...)
   |     - if autoSubmit: findSendButton() → click
   |
9. claude.ai submits the message → manager sees the worker result on its next turn
   |
10. content.ts → chrome.runtime.sendMessage: "dispatch ended in tab X"
    |   SW → chrome.action.setIcon: green for tab X
```

Cleanest path: ~12 seconds from block detection to result visible. Mostly daemon + claude code time; extension overhead negligible.

---

## Manual verification

```
1. Build daemon (Phase 1, already done). Start it: `node daemon/dist/index.js`.
   Verify /health returns ok.

2. Build extension: `npm install && npm run build` in extension/.
   Confirm dist/ has background.js, content.js, popup.js.

3. Chrome: chrome://extensions → enable Developer Mode → "Load unpacked" → select extension/.
   Confirm 🐛 (gray) icon appears in the toolbar.

4. Open claude.ai in a tab. The icon should still be gray (unbound).

5. Click 🐛. Popup should show:
   - daemon reachable (because daemon is running)
   - the project dropdown populated from /config
   - a Bind button

6. Pick a project from the dropdown, click Bind. Icon should turn green.

7. In the claude.ai chat, paste this as a user message:
      Please dispatch a test. Emit:
      ```bugger
      Respond with the word: hello
      ```
   Submit it. The manager assistant will respond and include the bugger block.

8. Watch:
   - Icon turns orange (pulsing) when dispatch starts
   - After a few seconds, a user message "Worker result:\n\nhello" auto-appears
   - Icon returns to green

9. Edge cases to run by hand:
   - Stop the daemon mid-dispatch → polling loop surfaces "daemon unreachable" error injection
   - Remove the bound project from daemon config → next dispatch surfaces the rebind prompt
   - Open the popup during dispatch → status shows elapsed time
   - Toggle auto-submit off in settings → next dispatch fills the input but doesn't submit; you press Send
   - Refresh the tab → existing bugger blocks in history don't re-dispatch (regression check)
   - Close and reopen the tab → binding is gone (chrome.storage.session is tab-scoped within the session and cleared on tab close per our cleanup hook)
```

---

## Out of scope for Phase 2

- **Packaging / Chrome Web Store listing.** Loads as unpacked only. Phase 5.
- **Firefox support.** Different manifest. Defer.
- **A daemon `/jobs/:id/cancel` endpoint.** Tied to open question 1 below — if we decide we need it, it's a Phase 1.1 amendment, not Phase 2 work.
- **Multi-tab to one project.** SPEC §"What's out of scope": don't try to handle two tabs on the same project gracefully. They'll fight; the daemon's FIFO queue keeps state sane, but the UX is intentionally not polished.
- **Persistent dispatch history in the extension.** All state in `chrome.storage.session`. Page refresh clears in-flight job memory (the dispatched-block registry is in-memory). A dispatch that's running when the user closes the tab is lost from the extension's view — the daemon still finishes it, but the result has nowhere to go. Acceptable v0.
- **Streaming results to the chat as they arrive.** Current daemon design returns full result at job-end. Streaming would need SSE on daemon + a different injection model. Maybe Phase 5.

---

## Open questions for review

### 1. In-flight dispatch + new user message

The user types a new message while a previous dispatch is still running. What should happen?

**Concrete scenario.** Manager's turn N emits a `bugger` block → dispatch fires, polling runs. Before it completes, user types "wait, actually do X instead" and submits. Manager's turn N+1 begins. The original dispatch is now stale.

**Options:**

- **A. Let it complete (recommended for v0).** The extension's polling loop runs to completion and injects the result. The manager's next turn reconciles — it sees the stale worker result and acknowledges the user's redirect. The manager skill already handles "worker did something we didn't want" gracefully. Cost: tokens spent on a now-stale task; one user-visible "Worker result:" message the manager has to talk past.

- **B. Cancel the in-flight job.** Requires a new daemon endpoint `POST /jobs/:id/cancel` that calls `child.kill("SIGTERM")` on the spawned Claude Code. Extension watches for "user submitted" events on the claude.ai input and cancels any in-flight dispatches for that tab. Cleaner UX. Cost: Phase 1.1 daemon work, plus careful child-process lifecycle handling.

- **C. Block the new message.** Toast "Wait — dispatch in flight. Cancel?" Coercive. The user's flow demands they always have control of the input. Not recommended.

**Recommendation: A for v0.** It's honest (the worker's work isn't free; we shouldn't pretend cancellation is clean), keeps the daemon untouched, and the manager skill is already designed to read worker output critically. If it bites us in practice, B is a clean upgrade path — small daemon change, small extension change.

### 2. "Which message is the latest with a dispatch block?"

A few sub-cases:

**Initial page load (history).** When the content script starts, the conversation history may contain many old `bugger` blocks from prior dispatches. We must not re-dispatch them. *Resolution:* on init, scan the existing DOM once and mark every visible `bugger` block as `{ seen: true, dispatched: false }`. Only blocks added *after* init via MutationObserver are candidates for dispatch.

**Same block re-detected.** The MutationObserver may fire multiple times for the same logical block (re-render, scroll virtualization, etc.). *Resolution:* compute a block id = `sha1(content + nearestMessageContainerId)` and dedupe. Same id = same block, dispatch once.

**Streaming.** The assistant message streams token by token; the `bugger` block may be detected mid-stream with only the opening fence + partial content. Dispatching at that point sends a half-formed prompt. *Resolution:* (a) check claude.ai's "still streaming" indicator (the message turn has an aria-busy attribute or a "stop generating" button visible) and wait for it to clear; (b) fallback debounce — only dispatch if no mutation has touched this block in the last 500ms.

**Tab refresh.** All in-memory dispatch state is gone. Existing `bugger` blocks become "seen, not dispatched" again. *Resolution:* this is correct behavior — we don't want to re-dispatch historical blocks, and we accept that an in-flight dispatch is lost from the extension's view (the daemon completes it but the result has no destination).

**Multiple blocks in one assistant turn.** The manager skill discourages this ("one focused task per dispatch") but doesn't prevent it. *Resolution:* dispatch each block independently in the order they appear in the DOM. Results inject in completion order. Could result in interleaved "Worker result:" messages if the daemon happens to run them concurrently — but per-project FIFO at the daemon prevents that; they run in dispatch order.

Surfacing both of these because they're real edges; the recommended resolutions are baked into the architecture above, but you may want to push back before I implement.
