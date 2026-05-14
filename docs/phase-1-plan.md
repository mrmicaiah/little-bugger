# Phase 1 plan — the daemon

This is the implementation plan for Phase 1 of Little Bugger: the local daemon. Per SPEC.md §"Build phases," Phase 1 ships:

- A Node + TypeScript HTTP server on `localhost:8765`
- Endpoints: `/health`, `/config`, `/dispatch`, `/jobs/:id`, `/ping`
- Config loading from `%APPDATA%\bugger\config.json` (Windows) or `~/.bugger/config.json` (POSIX), with hot-reload via file watching
- Per-project FIFO job queue; cross-project parallelism allowed
- Claude Code spawned per dispatch, output + git diff captured in memory
- Manual verification via curl

No extension, no packaging, no installer. Those are Phases 2 and 3.

---

## File layout under `daemon/`

```
daemon/
├── package.json
├── tsconfig.json
├── .gitignore                       — node_modules, dist, *.log
└── src/
    ├── index.ts                     — entrypoint: load config, start watcher, start HTTP server, wire shutdown
    ├── version.ts                   — exports VERSION constant (read from package.json at build time, or hardcoded "0.1.0" for v0)
    ├── config.ts                    — Config type, loadConfig(), watchConfig(), getConfig() getter
    ├── jobs.ts                      — Job type, JobStore (in-memory), enqueue(), getJob(), per-project queue runner
    ├── claudeCode.ts                — spawnClaudeCode(): cross-platform spawn, stream-json parse, returns { output, exitCode }
    ├── gitDiff.ts                   — captureDiff(cwd): runs git diff --stat HEAD and git diff HEAD, returns combined text
    ├── http.ts                      — tiny router on top of node:http; method+path → handler
    └── routes/
        ├── health.ts                — GET /health
        ├── config.ts                — GET /config
        ├── dispatch.ts              — POST /dispatch
        ├── jobs.ts                  — GET /jobs/:id
        └── ping.ts                  — POST /ping
```

One module per concern. `index.ts` is the only file with side effects at module load (other than `version.ts`). Everything else exports pure functions or factories.

I'm deliberately **not** using Express/Fastify. The daemon has five endpoints and no middleware needs (no auth, no CORS — localhost only, the extension is the only caller). Node's built-in `http` plus ~40 lines of hand-rolled routing keeps the dependency surface near zero, which matters for the eventual `pkg`/SEA single-binary packaging in Phase 3.

---

## `package.json` shape

```json
{
  "name": "little-bugger-daemon",
  "version": "0.1.0",
  "description": "Local daemon for Little Bugger — routes manager dispatches to Claude Code.",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "bugger-daemon": "dist/index.js"
  },
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "cross-spawn": "^7.0.6"
  },
  "devDependencies": {
    "@types/cross-spawn": "^6.0.6",
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0"
  },
  "engines": {
    "node": ">=20"
  }
}
```

Why `cross-spawn`: spawning `claude` on Windows requires resolving `claude.cmd` via `PATHEXT`, which Node's built-in `child_process.spawn` won't do with `shell: false`. `cross-spawn` is the de facto cross-platform shim — small, mature, transparent, no runtime overhead.

Everything else is dev-only. No web framework, no logger, no validator, no test runner yet (manual curl in Phase 1; we'll add a test harness in Phase 2 or 3 when the API surface stabilizes).

ESM (`"type": "module"`) because TypeScript 5 + Node 20 ESM is clean and pkg/SEA tooling has caught up.

---

## `tsconfig.json` shape

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

Strict everything. `noUncheckedIndexedAccess` because we'll be indexing into `config.projects[name]` and a missing key needs to be a type error, not a runtime undefined.

---

## Config: loading, validation, hot-reload

### Location

```
Windows: %APPDATA%\bugger\config.json
POSIX:   $HOME/.bugger/config.json
```

Resolved once at startup via `process.platform === "win32"` check. Daemon creates the directory if it doesn't exist and writes an empty stub on first run:

```json
{
  "projects": {},
  "anthropic_api_key": "",
  "port": 8765
}
```

Then logs the path it wrote and continues — the user fills it in, file watcher picks up the change, no restart needed.

### Type and validation

```ts
type Config = {
  projects: Record<string, string>;  // name → absolute path
  anthropic_api_key: string;
  port: number;
};
```

Validation rules (hand-rolled, no schema library):

- Top-level must be an object
- `projects` must be a plain object; each value must be a non-empty string
- Each project path must be absolute (`path.isAbsolute`) and exist as a directory (`fs.statSync`)
- `anthropic_api_key` must be a string (empty allowed at startup — daemon starts with a warning, refuses dispatches until set)
- `port` must be an integer 1–65535

On invalid config:
- **At startup:** log the error, exit 1. The user has nothing useful to do yet.
- **On hot-reload:** log the error, keep the previously loaded config in memory. Don't crash. The user fixes the file and saves again.

### Hot-reload

`fs.watch` on the **parent directory** (not the file), filtering for `config.json` events. Watching the directory survives atomic-write editors (VSCode, Vim with `backupcopy=auto`) that rename a temp file over the original — these break a file-level watcher because the inode changes.

Debounce window: 150ms. Multiple events for one save are common on Windows.

On debounced event: re-read, re-validate, atomically swap an internal `currentConfig` reference. Log a one-line diff of project name additions/removals so the operator can see hot-reload happened.

Exposed API:

```ts
// config.ts
export function loadConfig(): Promise<void>;          // initial load, throws on invalid
export function watchConfig(): void;                  // starts the watcher (idempotent)
export function getConfig(): Readonly<Config>;        // snapshot accessor
export function getProjectPath(name: string): string | undefined;
export function getProjectNames(): string[];
```

Callers always go through `getConfig()` — never cache the result. The cost of one map lookup per request is irrelevant; getting hot-reload right matters more.

---

## Per-project job queue

### Job model

```ts
type JobStatus = "queued" | "running" | "succeeded" | "failed";

type Job = {
  id: string;                  // crypto.randomUUID()
  project: string;             // project name from config
  prompt: string;
  status: JobStatus;
  createdAt: number;           // Date.now()
  startedAt?: number;
  endedAt?: number;
  output?: string;             // final assistant text from Claude Code
  diffSummary?: string;        // combined git diff --stat HEAD + git diff HEAD
  error?: string;              // when status === "failed"
  exitCode?: number;
};
```

### Storage

Two in-memory maps:

```ts
const jobsById = new Map<string, Job>();
const perProjectQueue = new Map<string, Job[]>();    // FIFO per project; head = currently running (or about to run)
```

That's it. No persistence. Daemon restart loses everything; the SPEC explicitly accepts this.

### Scheduling rules

- **Per-project: strictly FIFO, one job at a time.** When `enqueue(job)` is called: append to `perProjectQueue.get(job.project)`. If the queue length was 0 before append, start the job immediately. Otherwise it waits.
- **Cross-project: parallel.** Project A's running job does not block Project B's queue from advancing. The SPEC's "you're one human" line implies parallelism is fine; the manager skill is the rate-limiter.
- **On job terminal:** mark the job (`succeeded` / `failed`), `shift()` it off the project's queue, then if there's a next job in that queue start it. Loop iteratively, not recursively (one project shouldn't blow the stack on a deep queue).

### Public API

```ts
// jobs.ts
export function enqueueJob(project: string, prompt: string): Job;   // returns the created job (status="queued" or "running")
export function getJob(id: string): Job | undefined;
```

`enqueueJob` is fire-and-forget from the route handler's perspective — the handler returns `{jobId}` immediately, the queue runner does the rest.

---

## Spawning Claude Code (the part I want to be authoritative about)

**Bottom line: use the `claude` CLI in `--print` mode with `--output-format stream-json` and pipe the prompt via stdin.**

### Today's authoritative invocation

The Claude Code CLI binary is `claude` (the SPEC's `claude code` is shorthand — there's no `code` subcommand). For non-interactive dispatch from a parent process, the flags I'd use today:

```ts
const args = [
  "--print",                                  // non-interactive: run, emit result, exit
  "--input-format", "text",                   // prompt arrives as plain text on stdin
  "--output-format", "stream-json",           // one JSON object per line on stdout
  "--verbose",                                // REQUIRED with stream-json — without it, stream-json only emits at the very end, defeating the point
  "--permission-mode", "bypassPermissions",   // unattended operation; no permission prompts
  "--max-turns", "30",                        // sanity cap; a runaway worker can't burn unbounded turns
];

const child = crossSpawn("claude", args, {
  cwd: projectPath,                           // THIS is what binds the worker to the right repo
  env: {
    ...process.env,
    ANTHROPIC_API_KEY: config.anthropic_api_key,
  },
  stdio: ["pipe", "pipe", "pipe"],
  shell: false,                               // cross-spawn handles Windows .cmd resolution; no shell needed
});

child.stdin.write(prompt);
child.stdin.end();
```

Notes on each choice:

- **Prompt via stdin, not as a positional arg.** Multi-line prompts and prompts with quotes/backticks/dollar signs break shell escaping. stdin sidesteps all of it.
- **`cwd` set via spawn options, not a `--cwd` flag.** More reliable across versions of the CLI. The child process's working directory determines which `CLAUDE.md` and which git repo it sees.
- **`--verbose` is mandatory with `stream-json`.** Without it the CLI buffers and only emits a single `result` message at the end. We want to see progress so future phases can stream status back to the extension.
- **`--permission-mode bypassPermissions`** is the right call for v0. The manager dispatches from a browser tab the user can't actively babysit; permission prompts have nowhere to go. The discipline boundary is enforced upstream (the manager skill says "one focused task per dispatch") and downstream (the user reviews the unstaged diff before committing). The alternative — `acceptEdits` — still prompts for Bash and other non-edit tools, so it doesn't work for general dispatches.
- **`--max-turns 30`** is a guess. Tune from real usage.
- **`cross-spawn` over `child_process.spawn`** because on Windows, `claude` is `claude.cmd` and Node's built-in spawn won't resolve `PATHEXT` without `shell: true`, and `shell: true` reintroduces quoting risk for args.

### Parsing stream-json output

Each line on stdout is a JSON object. The shapes we care about:

```jsonc
// init
{"type":"system","subtype":"init","session_id":"...","model":"...","tools":[...]}
// each assistant turn
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."},{"type":"tool_use",...}]}}
// each tool result
{"type":"user","message":{"role":"user","content":[{"type":"tool_result",...}]}}
// terminal — emitted exactly once
{"type":"result","subtype":"success"|"error_max_turns"|"error_during_execution","result":"<final assistant text>","is_error":false,"total_cost_usd":0.12,"duration_ms":34567,"num_turns":7,"session_id":"..."}
```

Parser strategy:

- Read stdout as a stream, split on `\n`, parse each non-empty line with `JSON.parse` inside a try/catch.
- On parse failure: log the offending line and continue. Don't crash on malformed output.
- Accumulate every line into a `transcript: any[]` for debugging (kept in memory, exposed via `job.transcript` if we want; trim from the public `/jobs/:id` response to keep responses small).
- The `result` line is the single source of truth for the `output` field — its `result` property is the final assistant text the manager wants to see.
- If the process exits without ever emitting a `result` line (crash, OOM), set `status = "failed"`, populate `error` with the last stderr lines + exit code.

### Capturing the diff

After the child exits with code 0, in the same `cwd`:

```ts
const stat = execFileSync("git", ["diff", "--stat", "HEAD"], { cwd, encoding: "utf8" });
const full = execFileSync("git", ["diff", "HEAD"], { cwd, encoding: "utf8" });
job.diffSummary = stat + (full ? "\n\n" + full : "");
```

`HEAD` (not bare `diff`) catches both staged and unstaged changes, which matters because the user's discipline boundary in the SPEC is "diff is unstaged" — but if Claude Code ever stages something by accident we want to surface it, not hide it.

If `git` exits non-zero (not a git repo, no commits yet): swallow the error and set `diffSummary = ""`. Not every project is git-tracked from day one.

### Fallback if stream-json has quirks

Two fallbacks ready in case stream-json output proves unstable across CLI versions:

1. **Plain text mode.** Drop `--output-format` (defaults to text) and just capture stdout as the result. Lose structured fields (cost, num_turns) but gain robustness. Diff capture stays identical.
2. **Claude Agent SDK (TypeScript).** `npm install @anthropic-ai/claude-code` and call `query({ prompt, options: { cwd, permissionMode: "bypassPermissions" } })`, async-iterating the returned `Query`. Skips child-process management entirely. Costs a runtime dep and ties our packaging more tightly to the SDK's version, but the message shapes are the same as stream-json so the rest of the code is unchanged.

I'd start with stream-json (option above), fall back to plain text if parsing turns out fragile, and only go to the SDK if the CLI itself becomes a blocker. Phase 1 picks one — stream-json — and the fallback is documented but not implemented preemptively.

### `claudeCode.ts` public API

```ts
type RunResult = {
  output: string;             // final assistant text from the result line
  exitCode: number;
  isError: boolean;           // true if result.is_error or non-zero exit
  errorText?: string;         // from stderr or result.subtype when isError
};

export function runClaudeCode(opts: {
  cwd: string;
  prompt: string;
  apiKey: string;
}): Promise<RunResult>;
```

Self-contained: spawns, pipes, parses, resolves. The job runner calls this, then calls `captureDiff(cwd)`, then marks the job.

---

## Endpoint handlers — concrete shape

All handlers return JSON. All error responses look like `{"error": "<message>"}` with a 4xx or 5xx status. Content-Type always `application/json; charset=utf-8`.

### `GET /health`

- 200 always (if the server is up at all).
- Body: `{"ok": true, "version": "0.1.0"}`
- No-ops: doesn't touch config, doesn't enqueue anything.

### `GET /config`

- 200.
- Body: `{"projects": ["my-project", "other-project"]}` — names only, paths stripped per SPEC §"The daemon."
- Source: `getProjectNames()`.

### `POST /dispatch`

- Request body: `{"project": "my-project", "prompt": "Run the tests."}`
- Validation:
  - Body must parse as JSON object → 400 `{"error":"invalid JSON body"}`
  - `project` must be a string and exist in config → 404 `{"error":"unknown project: <name>"}`
  - `prompt` must be a non-empty string → 400 `{"error":"prompt required"}`
  - If `anthropic_api_key` is empty in config → 503 `{"error":"daemon not configured: anthropic_api_key missing"}`
- On success: `enqueueJob(project, prompt)` → 200 `{"jobId": "<uuid>"}`. The job may already be running or queued; either way the response is the same.

### `GET /jobs/:id`

- Path param: job UUID.
- 404 if `getJob(id)` returns undefined.
- 200 with body:

```jsonc
{
  "id": "uuid",
  "project": "my-project",
  "status": "queued" | "running" | "succeeded" | "failed",
  "createdAt": 1715000000000,
  "startedAt": 1715000000123,                // omitted when status === "queued"
  "endedAt": 1715000045678,                  // omitted when not terminal
  "output": "Tests passed. 42 of 42 ok.",    // omitted when not terminal or no output captured
  "diffSummary": " src/foo.ts | 3 +++\n...", // omitted when no diff
  "error": "exit 1: ...",                    // present only when status === "failed"
  "exitCode": 0                              // present when terminal
}
```

Polling cadence is the extension's problem. The daemon returns whatever's current. No long-poll, no SSE in Phase 1.

### `POST /ping`

- Request body: `{"project": "my-project"}`
- Same validation as `/dispatch` for the project field.
- Behavior: enqueue a job with a hardcoded prompt — exact text:
  > `Respond with the single word: pong. Do not read any files, do not run any commands, do not edit anything. Just respond.`
- Returns: `{"jobId": "<uuid>"}` (same shape as `/dispatch`).
- The caller polls `/jobs/:id` for the result, computes round-trip time itself. Keeps the daemon's responsibilities symmetrical and avoids special-casing ping execution.

The SPEC says ping returns RTT directly, but doing it as a normal job is simpler and the extension can compute `endedAt - createdAt` from the job record. Worth flagging for the review — happy to switch to a synchronous-RTT response if you'd rather.

---

## Process lifecycle

### Startup (`index.ts`)

1. Resolve config path (platform-dependent).
2. If config file doesn't exist: create directory, write empty stub, log the path, **continue** (don't exit — the operator may want to test `/health` before configuring).
3. `loadConfig()` — exit 1 on invalid config (with the file path and the validation error in the log).
4. `watchConfig()` — starts the directory watcher.
5. Start HTTP server on `config.port` (default 8765), bound to `127.0.0.1` only (not `0.0.0.0` — localhost-only is a SPEC discipline boundary).
6. Log: `Little Bugger daemon listening on http://127.0.0.1:<port>`.

### Shutdown

- On `SIGINT` / `SIGTERM` (and `SIGBREAK` on Windows): stop accepting new connections, kill all in-flight Claude Code children (`child.kill("SIGTERM")` with a 2s grace then `SIGKILL`), close the server, exit 0.
- On uncaught exception: log + exit 1. No automatic restart in Phase 1 — that's an OS-level service concern in Phase 3.

### Concurrency

Single-process, single-threaded. Node's event loop handles everything. Child processes (Claude Code spawns) are the only OS-level concurrency. No worker threads, no cluster.

---

## Manual verification

PowerShell on Windows aliases `curl` to `Invoke-WebRequest`, which has different syntax. Use `curl.exe` explicitly (Windows 10+ ships real curl) or `Invoke-RestMethod`. Examples below use `curl.exe` for clarity.

### Smoke test

```powershell
# 1. Daemon up
curl.exe http://127.0.0.1:8765/health
# expect: {"ok":true,"version":"0.1.0"}

# 2. Config visible
curl.exe http://127.0.0.1:8765/config
# expect: {"projects":["little-bugger", ...]}  — whatever's in config.json

# 3. Hot-reload check: edit ~/.bugger/config.json, add a project, save.
#    Re-run /config — new project name should appear without daemon restart.

# 4. Dispatch
curl.exe -X POST http://127.0.0.1:8765/dispatch `
  -H "Content-Type: application/json" `
  -d '{\"project\":\"little-bugger\",\"prompt\":\"List the files in the repo root. Do not edit anything.\"}'
# expect: {"jobId":"<uuid>"}

# 5. Poll the job
curl.exe http://127.0.0.1:8765/jobs/<uuid>
# expect: status progresses queued -> running -> succeeded
#         final response has output (the file list) and an empty diffSummary

# 6. Ping
curl.exe -X POST http://127.0.0.1:8765/ping `
  -H "Content-Type: application/json" `
  -d '{\"project\":\"little-bugger\"}'
# expect: {"jobId":"<uuid>"} — poll the job, output should contain "pong"
```

### Edge cases to verify manually

- Unknown project name to `/dispatch` → 404
- Empty prompt → 400
- Two `/dispatch` calls in quick succession to the same project → second job stays `queued` until the first reaches a terminal status (check via two polling loops in parallel)
- Two `/dispatch` calls to **different** projects → both run concurrently (verify by dispatching a slow prompt to project A and a fast one to project B; B finishes first)
- Edit `config.json` to invalid JSON, save → daemon logs the parse error and keeps serving the previously valid config
- Edit `config.json` to remove a project, save → `/config` reflects the removal on next request; a job already running for that project completes uninterrupted (we don't kill in-flight work on config change)
- `Ctrl+C` while a job is running → daemon shuts down, child is killed, no orphan `claude` processes (check `Get-Process claude` after)

---

## Out of scope for Phase 1

Deliberately deferred — call out so review can confirm:

- **Chrome extension** — Phase 2.
- **Cross-platform packaging / installer / auto-start** — Phase 3.
- **`bugger` CLI** (`bugger ping`, `bugger reload`) — defer to Phase 3 alongside packaging. Manual curl is enough for Phase 1 verification.
- **Persistent job history** — SPEC §"What's out of scope for v0." Jobs live in memory.
- **Auth on the daemon** — SPEC §"Discipline boundaries": localhost only, extension is the only legitimate caller. Bind to `127.0.0.1`, no token, no CORS headers.
- **Auto-reconnect / job recovery on daemon restart** — SPEC §"What's out of scope for v0."
- **Project auto-discovery** — SPEC §"What's out of scope for v0."
- **Cross-machine sync** — SPEC §"What's out of scope for v0."
- **Streaming results to the extension (SSE / long-poll)** — Phase 1 has polling-only `/jobs/:id`. Streaming could be added in Phase 2 if the polling UX feels laggy, but it's not on the critical path.
- **Structured logging / log rotation** — `console.log` to stdout. The eventual installer (Phase 3) decides where to redirect that.
- **Tests** — manual curl in Phase 1. A test harness lands when the API surface stabilizes (probably Phase 3, before packaging).

---

## Open questions for review

1. **`--permission-mode bypassPermissions`** — confirm you're OK with the manager dispatching unattended writes/commands. The SPEC's discipline boundary ("diff lands unstaged, user reviews before committing") makes this safe, but worth eyes-open agreement.
2. **`--max-turns 30`** — a guess. Want a different cap? Or unbounded?
3. **`/ping` returns `{jobId}` like `/dispatch`** rather than synchronous RTT. Cleaner internally; the extension computes RTT from `createdAt`/`endedAt`. SPEC text suggests synchronous — happy to switch.
4. **Empty `anthropic_api_key` at startup** — currently I have the daemon start anyway and reject dispatches with 503 until the key is set. Alternative: refuse to start without a key. The "start anyway" version lets the user test `/health` before configuring; the strict version surfaces missing config sooner. Mild preference for "start anyway."
5. **ESM vs CommonJS** — picking ESM (`"type": "module"`). Slightly more friction with some older tooling; cleaner for Node 20+. Flag if Phase 3 packaging tooling (pkg / SEA) tilts the call the other way.
