# Fix: icon-loading 404s and badge-text fail-safe

## CRITICAL — Output discipline

Your final report MUST follow the output format at the end of this document
EXACTLY. Every section listed must be present. Every section must contain the
content described. Previous workers ignored output formats and just dumped
diffs — don't be that worker.

If a step fails, stop and report the failure in NOTES — don't push through.

## Context

The Chrome extension icon (`chrome.action.setIcon`) is calling for
`icons/bug-orange-*.png` and `icons/bug-purple-*.png` and getting 404s in
Chrome's network tab. The gray and green icons load fine. This means the
toolbar icon never visually changes color when a dispatch is in flight
(should be orange) or when there's a pending result (should be purple).

The pending-result detection logic is working — the popup correctly shows
the pending state and the Retrieve button works — but the user has no
indication a result is waiting unless they happen to open the popup. This
is a serious UX bug because the entire point of the orphan-handling feature
is to surface that a result is waiting.

Goal: do TWO things in this dispatch.

1. Diagnose why the orange and purple icon PNGs are 404'ing, fix it if
   possible, and report findings.
2. Add badge-text fail-safe indicators using `chrome.action.setBadgeText`
   and `chrome.action.setBadgeBackgroundColor` so the user has a visual
   indicator regardless of whether the PNG icons load.

## Part 1: Icon 404 diagnostic

Investigate the actual state of the icon files. Run all of these and report
results in the report:

1. `ls -la extension/icons/` — list all icon files with sizes
2. `file extension/icons/bug-*.png` if `file` is available, OR
   `head -c 8 extension/icons/bug-orange-16.png | xxd` and same for
   bug-purple-16.png — to verify the PNG magic bytes (first 8 bytes should
   be 89 50 4e 47 0d 0a 1a 0a)
3. Check that `extension/icons/` is NOT in `.gitignore` and NOT in
   `extension/.gitignore` — `cat .gitignore extension/.gitignore`
4. `cat extension/manifest.json` — verify the manifest doesn't accidentally
   restrict which icons are accessible

If you find the cause (corrupted files, wrong path, etc.) fix it. If the
files look fine and you can't determine why Chrome is 404ing them from
static analysis, document what you checked and move on to Part 2 — the
badge-text fail-safe makes the system usable regardless.

## Part 2: Badge-text fail-safe

Modify `extension/src/background.ts` to set badge text alongside the icon
state, so the user has a visual indicator that survives even if icons are
broken.

Badge text mapping (set on the same tab that the icon would update):

- `orange` (dispatching): set badge text to `"..."` and badge background
  color to `#d97706` (amber/orange).
- `purple` (pending result): set badge text to `"!"` and badge background
  color to `#7c4dff` (purple).
- `green` / `gray`: clear badge text (empty string).

Implementation guidance:

- Add a helper `async function updateBadge(tabId: number, state: IconState)`
  that calls `chrome.action.setBadgeText({ tabId, text })` and
  `chrome.action.setBadgeBackgroundColor({ tabId, color })`.
- Call it from `updateIcon` right after `chrome.action.setIcon`, so badge
  and icon always stay in sync.
- The badge is a tiny overlay on the toolbar icon — distinct from the icon
  itself, doesn't depend on PNG files loading.

Keep the existing icon-setting code unchanged. The badge is additive,
belt-and-suspenders. Even if icons get fixed, badge text is still useful
because it conveys MORE information than color alone (e.g. "!" vs "..."
distinguishes dispatching from pending more clearly than orange vs purple
at a glance).

## Part 3: Verify

1. `npm run build` inside `extension/` — report full output.
2. `git status` and `git diff --stat`.
3. Reload the extension wouldn't help here since the worker can't drive a
   browser, so just confirm the build is clean.

## Output format

Report back with EXACTLY this structure. Every section present. Every
section filled with the content described.

```
SUMMARY: <one sentence describing what was done>

ICON FILE DIAGNOSTIC:
<paste of ls -la extension/icons/ output>

PNG MAGIC BYTES CHECK:
<results of file command or hex dump for bug-orange-16.png and bug-purple-16.png>

GITIGNORE CHECK:
<verbatim contents of .gitignore and extension/.gitignore>

MANIFEST.JSON ICON-RELATED ENTRIES:
<the action.default_icon and top-level icons blocks from manifest.json>

ICON DIAGNOSTIC CONCLUSION:
<your best theory on why Chrome is 404'ing the orange/purple icons.
 If you fixed it, describe the fix. If you couldn't determine the cause
 from static analysis, say so.>

FILES MODIFIED:
- <path>: <brief description>
- ...

BUILD OUTPUT:
<paste of npm run build output, verbatim>

GIT STATUS:
<paste of git status output, verbatim>

GIT DIFF STAT:
<paste of git diff --stat output, verbatim>

NOTES OR DEVIATIONS:
<anything you decided differently or anything notable. If nothing, write "none".>
```

Do not commit. Do not push. Leave the changes unstaged for review.
