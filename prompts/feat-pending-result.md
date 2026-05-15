# Feature: Pending Result Surfacing

## CRITICAL — Output discipline

Your final report MUST follow the output format at the end of this document
EXACTLY. Every section listed must be present. Every section must contain the
content described, verbatim where the format calls for verbatim. Do not skip
sections. Do not consolidate sections. Do not "summarize for brevity."
Previous workers on this exact task ignored the output format and gave us
only a raw diff dump, which left us without verification of build status,
git status, or icon generation. This time follow the format.

Whatever your implementation effort takes, save enough budget to assemble the
full structured report at the end. The structured report is the deliverable,
not just the code changes.

## Context

Current behavior: when a worker job finishes but the user has typed text in the
chat input, `injectText` in `extension/src/content.ts` aborts with a
`console.warn` and the result is silently lost. The job is still in daemon
memory but the user has no way to retrieve it.

Desired behavior: when the inject guard trips, store a "pending result"
reference and surface it via a new icon state and a Retrieve button in the
popup. If the user clicks Retrieve while the input still has text, refuse and
tell them to send or delete their text first.

## Requirements

### Data model
- "Pending result" = `{ jobId, project, timestamp }` stored in
  `chrome.storage.session` under key `pending:<tabId>`.
- Only one pending result per tab. New orphans overwrite older ones.

### Icon states
- Add a new state: `purple` for "pending result waiting."
- Precedence in `resolveIconState` (highest priority first):
  dispatching (orange) → pending (purple) → bound+reachable (green) →
  unbound/unreachable (gray).
- Need new icon files: `bug-purple-16.png`, `bug-purple-32.png`,
  `bug-purple-48.png`, `bug-purple-128.png`.

### Generating the purple icons
- Use `sharp` (preferred if available — check `extension/package.json` first)
  or ImageMagick (`magick` / `convert` command).
- Generate purple variants by recoloring the existing green icons.
  Source: `extension/icons/bug-green-{16,32,48,128}.png`.
- Target purple: roughly hex `#7c4dff` (medium purple, similar saturation to
  the green). Recolor preserving alpha.
- If neither `sharp` nor ImageMagick is available, fall back to a small
  Node.js script using `pngjs`. Pick the simplest working option.
- Write the four purple PNGs to `extension/icons/`.
- IF you cannot generate the icons (no tool available), say so clearly in the
  NOTES section of the report. Do NOT silently skip the icon generation.

### Code changes — `extension/src/lib/tabBinding.ts`

Add these helpers:

- `getPendingResult(tabId): Promise<{ jobId: string; project: string; timestamp: number } | null>`
- `setPendingResult(tabId, jobId, project): Promise<void>`
  (timestamp auto-set with `Date.now()`)
- `clearPendingResult(tabId): Promise<void>`

Storage key format: `pending:<tabId>`. Use the same `chrome.storage.session`
pattern as bindings.

Also: extend `clearBinding(tabId)` to also clear any pending result for that
tab — when a tab closes, pending results for it die too.

### Code changes — `extension/src/content.ts`

In `injectText`, at the existing guard `if (existing.length > 0)`:

- BEFORE the early return, if this injection came from `injectResult` (not
  `injectErrorMessage`), send a message to the service worker:
  `{ type: "pendingResult", jobId, project }` where `jobId` and `project`
  come from the job object.
- Easiest plumbing path: change `injectResult(job)` to pass `jobId` and
  `project` through. Make `injectText` accept an optional `pending`
  parameter `{ jobId, project }` that's only set when called from
  `injectResult`. The error-injection path passes nothing; no pending state
  is ever created on error.
- Keep the `console.warn` for visibility. Keep the early return.

The content script's existing `chrome.runtime.onMessage` listener currently
only handles `bindingChanged` and `settingsChanged` (fire-and-forget). Refactor
it to also handle two new request/response cases that DO need a response —
return `true` from the listener for async response on those cases.

- `case "checkInputClear"`: read the input via `findInputTextarea()` and
  `readEditorContent(input).trim().length === 0`. Respond `{ clear: true | false }`.
  If input element not found, respond `{ clear: false, error: "input not found" }`.

- `case "injectPending"`: take the `job` from `msg.job`, call `injectResult(job)`
  directly. Same path as the normal completion would have used. Respond
  `{ ok: true }` after the injection completes, or `{ ok: false, error: "..." }`
  on failure.

### Code changes — `extension/src/background.ts`

- Add message handler `case "pendingResult"`: store via
  `setPendingResult(senderTabId, jobId, project)`, then call
  `updateIcon(senderTabId)`.
- Modify `resolveIconState`: between the dispatching check and the
  bound+reachable check, check for a pending result for that tab. If one
  exists, return `"purple"`.
- Update `updateIcon` to map `"purple"` to
  `icons/bug-purple-{16,32,48,128}.png`. The existing code templates the
  filename from the state string (`icons/bug-${state}-{size}.png`) so this
  may already work automatically — verify by reading the existing
  `updateIcon` function.
- Add a message handler `case "getPendingForTab"` (sent from popup, takes a
  `tabId` in `msg.tabId`): returns `await getPendingResult(tabId)`.
- Add a message handler `case "retrievePending"` (sent from popup, takes
  `tabId` in `msg.tabId`):
  - Get pending from storage. If none, return `{ error: "no pending result" }`.
  - Call `daemon.getJob(pending.jobId)`. If error or not found, clear pending,
    return `{ error: "..." }` describing what happened.
  - Return the job object to the popup, but DON'T clear pending yet — the
    popup will attempt injection first, and only confirm-clear if injection
    succeeds.
- Add a message handler `case "pendingRetrieved"` (sent from popup, takes
  `tabId` in `msg.tabId`): calls `clearPendingResult(tabId)` and
  `updateIcon(tabId)`. Popup sends this only after a successful inject.

### Code changes — `extension/src/popup.ts`

- Add a new render state for "pending result", shown when
  `getPendingForTab` returns non-null.
- Order in `refresh()`:
  settings → daemon unreachable → non-claude-tab → **pending result** →
  bound → unbound.
- The pending state renders:
  - Headline: "Pending worker result"
  - Muted line: "Result from `<project>`, ready to inject."
  - One button: "Retrieve and inject" (primary style).
- When user clicks Retrieve:
  1. Send `{ type: "retrievePending", tabId }` to SW. Get job back.
  2. If error, render an error banner inline (don't navigate away) with the
     message and a Retry button.
  3. If job retrieved successfully, ask the content script in this tab to
     check if the input has text: `chrome.tabs.sendMessage(tabId, { type: "checkInputClear" })`.
     Content script responds `{ clear: boolean }`.
  4. If input not clear, render an inline warning: "There's text in your
     chat input. Send it or delete it, then click Retrieve again." Don't
     clear pending state. User can click Retrieve again.
  5. If input is clear, send `{ type: "injectPending", job }` to the content
     script. Content script injects and auto-submits like the normal result
     path.
  6. On successful injection (content script responds `{ ok: true }`), send
     `{ type: "pendingRetrieved", tabId }` to SW. Close the popup with
     `window.close()`.

### Code changes — `extension/popup.html` and `extension/popup.css`

- HTML: no structural changes needed; new content rendered inside `#content`
  via `popup.ts`.
- CSS: add a `.banner.pending` variant. Purple-ish background, similar shape
  to `.banner.warn` and `.banner.ok`. Suggested: light purple background,
  slightly darker purple border. Light + dark mode variants both in `:root`
  and the `@media (prefers-color-scheme: dark)` block.

## Verification — required before declaring done

1. Run `npm run build` inside `extension/`. Report full output. If TypeScript
   errors, fix them before declaring done.
2. Run `git status` and `git diff --stat` to confirm changes are present.
3. Confirm the four purple icon PNGs exist with
   `ls -la extension/icons/bug-purple-*.png` and report their file sizes.

## Output format

Report back with EXACTLY this structure. Do not omit any section. Do not
summarize sections away. Do not say "for brevity, see the diff." The whole
point is the structured report — fill in every section.

```
SUMMARY: <one sentence describing what was done>

FILES MODIFIED:
- <path>: <brief description of change>
- ...

FILES CREATED:
- <path>
- ...

BUILD OUTPUT:
<paste of npm run build output, full, verbatim>

GIT STATUS:
<paste of git status output, verbatim>

GIT DIFF STAT:
<paste of git diff --stat output, verbatim>

PURPLE ICONS:
<paste of ls -la extension/icons/bug-purple-*.png output, verbatim>

NOTES OR DEVIATIONS:
<anything you decided differently from the spec, or anything notable. If you
departed from the spec for any reason, say so here clearly. If nothing
notable, write "none".>
```

If any step fails, stop and report what failed in NOTES. Don't push through
errors.
