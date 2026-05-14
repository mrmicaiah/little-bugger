# Little Bugger

A small tool that lets a Claude manager in a claude.ai browser tab dispatch work to Claude Code on the same machine, with results flowing back into the chat automatically.

Two pieces: a local daemon and a Chrome extension. Together they're "Little Bugger." Friendly name. Tiny scope. Real value.

---

## What it solves

You manage 3-4 projects at once. Each project has a manager (a claude.ai conversation in its own browser tab) and a worker (Claude Code running locally in that project's repo). Today you are the message bus: you copy prompts from manager to terminal, copy results back to manager, do that across four pairs. It works but it's exhausting and the terminals are ugly.

Little Bugger removes the message bus. Manager emits a dispatch block; the extension routes it to the daemon; the daemon runs Claude Code in the right repo; the result auto-appears in the manager's chat as a follow-up user message. Terminals stay minimized. You manage four managers from your browser.

---

## How it works

### The dispatch block

When a manager wants the worker to do something, it emits a fenced block with the language tag `bugger`:

````
```bugger
Run the test suite. Report failing tests with file paths.
```
````

That's it. No project name in the block — **the browser tab is already bound to a project**, so routing is implicit. The block is just the prompt to send.

### The extension

A Chrome extension watches the active claude.ai tab. Three responsibilities:

1. **Bind the tab to a project.** Click the bug icon in the toolbar. A small popup shows a dropdown of available projects (from the daemon's config) and a "Bind this tab to ___" button. Once bound, the tab stays bound until you close it or rebind.

2. **Show connection state.** The toolbar icon shows status at a glance:
   - 🐛 (gray): not bound, or daemon unreachable
   - 🐛 (green): bound, daemon reachable
   - 🐛 (orange, pulsing): a dispatch is in flight
   - Click the icon: opens a popup with current binding, ping button, and "rebind" option

3. **Detect dispatches and route results.**
   - Watches assistant messages for ```` ```bugger ```` blocks
   - On detect: extract prompt, POST to `http://localhost:8765/dispatch` with `{project, prompt}`
   - Poll `http://localhost:8765/jobs/:id` until terminal
   - On terminal: inject the result back into the manager's input box as a user message:
     > `Worker result:\n\n<output>\n\n<diff_summary if any>`
   - Submit the message automatically — manager sees it on its next turn

### The daemon

A small Node program running on the user's machine. Listens on `localhost:8765`. Responsibilities:

- `GET /health` — `{ ok: true, version: "..." }`
- `GET /config` — returns the configured project names (no paths leaked) so the extension can populate the dropdown
- `POST /dispatch` — body `{ project, prompt }` → creates a job, returns `{ jobId }`
- `GET /jobs/:id` — returns current status: `queued | running | succeeded | failed` plus `output`, `diff_summary`, `error` as appropriate
- `POST /ping` — body `{ project }` → dispatches a trivial "echo hello" to that project's worker and returns the round-trip time. For sanity-checking on each machine setup.

### Job execution

When a dispatch arrives:

1. Daemon looks up the project's repo path in config
2. Spawns a fresh Claude Code session: `claude code --no-confirm "<prompt>"` (or whatever the current CLI invocation is) with `cwd` set to the project's repo
3. Captures stdout/stderr
4. On completion: runs `git diff --stat` and `git diff` for context, captures both
5. Stores everything in memory keyed by jobId
6. Marks job terminal

**Per-project serialization:** if a dispatch arrives for a project that already has a job running, queue it. Run when the prior one terminates. Per-machine, this is enough — you're one human, you don't need cross-project locking.

**No persistence:** jobs live in memory. If the daemon restarts, in-flight jobs are lost (the extension will see a "daemon unreachable" state and the dispatch fails gracefully). Acceptable v0.

### Config

`~/.bugger/config.json` (or `%APPDATA%\bugger\config.json` on Windows):

```json
{
  "projects": {
    "the-big-brain": "C:\\Users\\mrmic\\Projects\\the-big-brain",
    "medi-vault": "C:\\Users\\mrmic\\Projects\\medi-vault",
    "softball-project": "C:\\Users\\mrmic\\Projects\\softball-project",
    "white-shovel-software": "C:\\Users\\mrmic\\Projects\\white-shovel-software"
  },
  "anthropic_api_key": "sk-ant-...",
  "port": 8765
}
```

`anthropic_api_key` is here so Claude Code inherits it via the daemon's spawned environment. The daemon never sends this anywhere over the network — Claude Code is the only consumer.

Per-machine. The laptop's config has its Windows paths; the Mac's has its `/Users/mrmic/...` paths. Same project names, different paths. Same skill works on both because the manager doesn't know or care about paths — it just dispatches by project name (which the extension bound the tab to).

### Discipline boundaries

**Little Bugger never touches your repos directly.** It only invokes Claude Code, which works in the repo on your behalf. The git-add/git-reset workflow stays whatever Claude Code does today — diffs land unstaged, you review with `git status` and `git diff` before committing.

**The browser tab is the source of truth for routing.** The manager's content can't misroute a dispatch even if it tries — the extension only knows the tab's bound project, not whatever the manager might claim.

**No cloud component.** Daemon is local. Extension is local. Your prompts and code never leave your machine via Little Bugger. Claude Code's connection to Anthropic's API is the only network egress.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Chrome / claude.ai tab                                  │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Manager conversation (this tab bound to:        │   │
│  │  medi-vault)                                      │   │
│  │                                                    │   │
│  │  Manager: "I'll run the test suite."             │   │
│  │  ```bugger                                        │   │
│  │  Run the test suite. Report failures.             │   │
│  │  ```                                              │   │
│  └──────────────────────────────────────────────────┘   │
│         │                                                │
│         │ extension detects fenced block                 │
│         ▼                                                │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Little Bugger Extension                          │   │
│  │  - Reads tab binding: medi-vault                 │   │
│  │  - POST localhost:8765/dispatch                  │   │
│  │  - Polls /jobs/:id                                │   │
│  │  - Injects result back as user message            │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
              │
              │ HTTP localhost:8765
              ▼
┌─────────────────────────────────────────────────────────┐
│  Bugger Daemon (Node, runs in background)                │
│  - Receives /dispatch { project: medi-vault, prompt }   │
│  - Looks up project path in config                       │
│  - spawn claude code in C:\...\medi-vault               │
│  - Captures stdout + git diff                            │
│  - Holds result in memory until extension polls          │
└─────────────────────────────────────────────────────────┘
              │
              │ spawn child process
              ▼
┌─────────────────────────────────────────────────────────┐
│  Claude Code (Anthropic CLI)                             │
│  cwd: C:\Users\mrmic\Projects\medi-vault                │
│  Reads CLAUDE.md, does the work, exits                   │
│  Working tree left modified, unstaged                    │
└─────────────────────────────────────────────────────────┘
```

---

## Cross-platform packaging

**The daemon ships as:**
- Windows: `.msi` installer (created with `electron-builder` or `pkg` + WiX). Installs to `%LOCALAPPDATA%\Bugger\`. Registers a startup task so the daemon auto-starts on login. Adds `bugger` to PATH for `bugger ping` etc.
- macOS: `.pkg` installer. Installs to `/usr/local/bin/bugger-daemon`. Registers a `LaunchAgent` plist so it auto-starts on login.
- Both: same daemon Node executable, packaged for each platform via `pkg` or `nexe`.

**The extension ships as:**
- Chrome Web Store listing (eventually) — single install link
- Or as an unpacked dev extension: zip released on GitHub, user enables Developer Mode in `chrome://extensions`, drags the folder in
- Works in Chrome, Edge, Brave, Arc, and any Chromium-based browser. Firefox would need a separate manifest — defer until anyone asks.

**Setup ritual on a new machine:**
1. Run installer (one-click)
2. Install extension (one-click)
3. Edit `~/.bugger/config.json` to set project paths and paste your `ANTHROPIC_API_KEY`
4. Restart daemon (or just reboot)
5. In Chrome, click the 🐛 icon, bind your first tab to a project
6. Done

---

## The manager skill

A skill document loaded into each Claude.ai Project teaches the manager how to use Little Bugger. See `skill/manager-skill.md`.

Highlights:
- The manager NEVER specifies a project name in the dispatch block — the tab binding handles routing
- The manager dispatches when execution is needed; doesn't dispatch for thinking, planning, or analysis it can do itself
- The manager waits for the worker's result before continuing — it reads the result as a tool response on its next turn
- The manager treats the worker as scoped: one task per dispatch, success criteria stated, files referenced explicitly
- The manager handles errors gracefully (worker returns a stack trace) and decides whether to retry or change approach

---

## Build phases

Same plan-review-build discipline as The Big Brain. Each phase ships a working state.

**Phase 1: Daemon foundation**
- Node project, TypeScript
- `/health`, `/config`, `/dispatch`, `/jobs/:id`, `/ping` endpoints
- Reads `~/.bugger/config.json`
- Spawns Claude Code, captures output + diff
- Per-project serialization queue
- Manual testing via curl

**Phase 2: Chrome extension**
- Manifest v3 extension
- Toolbar icon with status colors
- Popup UI with project dropdown, bind/rebind, ping, status display
- Detects fenced ```` ```bugger ```` blocks in claude.ai conversations
- Sends dispatch to daemon, polls for result
- Auto-injects result back into the chat input

**Phase 3: Cross-platform packaging**
- `pkg` or `nexe` builds for daemon → single binary per platform
- Installer scripts (MSI for Windows, PKG for macOS)
- Auto-start configuration on each platform
- Release workflow: tag → GitHub Actions → builds both platforms → uploads to release

**Phase 4: Manager skill + onboarding**
- Polish the skill document
- Write a setup guide for the user (`docs/getting-started.md`) with screenshots
- "First five minutes" walkthrough: install → configure → bind first tab → run first dispatch

**Phase 5: Polish and ship**
- Extension to Chrome Web Store
- Daemon auto-update mechanism (optional, v0 = manual reinstall)
- README, repo cleanup, public-facing if you want

---

## What's out of scope for v0

- **Multi-user.** Single human, single machine at a time. No accounts, no auth on the daemon (localhost only — the Chrome extension is the only legitimate caller).
- **Cross-machine sync.** Each machine is its own world. Repos sync via git push/pull. That's the only cross-machine glue.
- **Remote dispatching.** No phone access. No "dispatch from one machine to another." You're at the computer that has the daemon running.
- **Persistent job history.** Jobs live in daemon memory, lost on restart. The chat itself is the record of what was dispatched and what came back.
- **Auto-reconnect on disconnect.** If the daemon dies mid-dispatch, the extension shows an error and the user retries. Daemon restart is rare enough that recovery automation is overkill.
- **Multi-tab to one project.** Each tab binds to one project. Two tabs on the same project = two managers fighting over one worker (per-project serialization queues them, but the UX is weird). Don't do it.

---

## Principles

**Smaller than it sounds.** The whole daemon is probably 400 lines. The extension is similar. Tiny tool, tight scope.

**The repo is the source of truth.** Always pull at start of day, push at end of day. Little Bugger doesn't replicate state anywhere. Lose your machine, install on a new one, pull the repo, you're back.

**Discipline over features.** The manager skill enforces good behavior (one task per dispatch, success criteria, file references). The tool just routes messages.

**Local, fast, no cloud.** Everything happens on your machine. No deploys, no secrets in a Cloudflare worker, no auth tokens to rotate. The only thing the daemon needs is your Anthropic API key for Claude Code to use.

**Be honest about what it is.** Little Bugger is a courier. It carries messages between the manager (where you think) and the worker (where work happens). It is not a manager. It is not a brain. It is the pipe.

---

## Repo layout

```
little-bugger/
├── README.md
├── SPEC.md                       — this document
├── skill/
│   └── manager-skill.md          — load into claude.ai Projects
├── daemon/                       — Node TypeScript daemon
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts              — entry, HTTP server
│       ├── config.ts             — load + validate ~/.bugger/config.json
│       ├── jobs.ts               — in-memory job queue + execution
│       ├── claudeCode.ts         — spawn + capture
│       └── routes/
│           ├── health.ts
│           ├── config.ts
│           ├── dispatch.ts
│           ├── jobs.ts
│           └── ping.ts
├── extension/                    — Chrome Manifest v3
│   ├── manifest.json
│   ├── icons/
│   │   ├── bug-gray.png
│   │   ├── bug-green.png
│   │   └── bug-orange.png
│   └── src/
│       ├── background.ts         — service worker, listens for tab events
│       ├── content.ts            — injected into claude.ai, watches for blocks
│       ├── popup/                — the popup UI
│       │   ├── popup.html
│       │   ├── popup.ts
│       │   └── popup.css
│       └── lib/
│           ├── daemonClient.ts   — fetch wrappers for localhost:8765
│           └── tabBinding.ts     — chrome.storage glue for tab → project map
├── installers/
│   ├── windows/                  — WiX or NSIS sources
│   └── macos/                    — pkgbuild sources
└── docs/
    ├── getting-started.md
    └── architecture.md
```

---

## A note on building this

Same discipline as before. Plan each phase, push the plan as `docs/phase-N-plan.md`, review, refine, build, verify, commit. One phase at a time.

This one is small enough that all five phases together should fit in a weekend. Don't rush — the smallness is a feature, and the value is in getting the details right (the binding UX, the manager skill, the cross-platform packaging) rather than in shipping fast.
