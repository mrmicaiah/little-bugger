# Changelog

## 2026-05-14

### Phase 1: Daemon foundation (`154f6be`)

- HTTP server on `localhost:8765` with `/health`, `/config`, `/dispatch`, `/jobs/:id`, `/ping`. Per-project FIFO queue; cross-project dispatches run in parallel.
- Claude Code spawned via `cross-spawn` with stream-json output parsing. In-memory job storage, no persistence across daemon restarts.
- Config hot-reloads via parent-directory `fs.watch` with 150ms debounce. First run bootstraps a config stub with an `_comment` helper.

### Phase 2: Chrome extension (`4e9c308`)

- Manifest V3 extension watches claude.ai tabs for `bugger` fenced blocks, dispatches to the daemon, polls `/jobs/:id`, and injects worker output back into the chat as an auto-submitted user message.
- Per-tab binding stored in `chrome.storage.session`, keyed by `tab.id`. Adaptive polling at 1s / 3s. Service worker stays thin — icon updates, `/config` fetch, tab cleanup.
- Selectors discovered via live DOM inspection on production claude.ai. Verified end-to-end.

### Phase 2 polish: duplicate-injection fix (`1e895b6`)

- Extension was firing both the modern `InputEvent` path and the `execCommand` fallback, so every worker result landed in the chat twice. Dropped the fallback in `content.ts`.
- The 75ms verification probe was misreading ProseMirror's inline-collapsed form as a failed insert, the fallback fired anyway, and the editor absorbed both copies into one doubled message.

### Phase 2 polish: worker status pill (`58e8883`)

- Small floating indicator in the bottom-right corner of the claude.ai viewport shows the worker's current phase as it cycles through reading, editing, running a command, thinking. Replaces the silent gap between dispatch and result.
- Daemon now emits `phase` + `phaseDetail` from every stream-json line; extension renders them inline.
