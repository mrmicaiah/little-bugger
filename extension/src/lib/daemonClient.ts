// Fetch wrappers around the Little Bugger daemon (localhost:8765).
// Used by background.ts, content.ts, and popup.ts.

const BASE = "http://localhost:8765";

export type DaemonHealth = { ok: boolean; version: string };
export type DaemonConfig = { projects: string[] };

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export type JobPhase =
  | "started"
  | "reading"
  | "editing"
  | "running_command"
  | "thinking"
  | "done";

export type Job = {
  id: string;
  project: string;
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  output?: string;
  diffSummary?: string;
  error?: string;
  exitCode?: number;
  phase?: JobPhase;
  phaseDetail?: string;
};

export type DispatchOk = { jobId: string };
export type DaemonError = { error: string; status: number };
export type ClearOk = { ok: true; killed: number; cleared: number };

export async function health(): Promise<DaemonHealth | null> {
  try {
    const res = await fetch(`${BASE}/health`, { method: "GET" });
    if (!res.ok) return null;
    return (await res.json()) as DaemonHealth;
  } catch {
    return null;
  }
}

export async function getConfig(): Promise<DaemonConfig | null> {
  try {
    const res = await fetch(`${BASE}/config`, { method: "GET" });
    if (!res.ok) return null;
    return (await res.json()) as DaemonConfig;
  } catch {
    return null;
  }
}

export async function dispatch(
  project: string,
  prompt: string,
): Promise<DispatchOk | DaemonError> {
  try {
    const res = await fetch(`${BASE}/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project, prompt }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      return { error: typeof body["error"] === "string" ? body["error"] : "unknown error", status: res.status };
    }
    return { jobId: String(body["jobId"]) };
  } catch (err) {
    return { error: `daemon unreachable: ${(err as Error).message}`, status: 0 };
  }
}

export async function getJob(id: string): Promise<Job | DaemonError | null> {
  try {
    const res = await fetch(`${BASE}/jobs/${encodeURIComponent(id)}`, { method: "GET" });
    if (res.status === 404) {
      return { error: "job not found", status: 404 };
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { error: typeof body["error"] === "string" ? body["error"] : "unknown error", status: res.status };
    }
    return (await res.json()) as Job;
  } catch {
    return null;
  }
}

export async function ping(project: string): Promise<DispatchOk | DaemonError> {
  try {
    const res = await fetch(`${BASE}/ping`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      return { error: typeof body["error"] === "string" ? body["error"] : "unknown error", status: res.status };
    }
    return { jobId: String(body["jobId"]) };
  } catch (err) {
    return { error: `daemon unreachable: ${(err as Error).message}`, status: 0 };
  }
}

// POST /jobs/clear — ask the daemon to cancel all queued/running jobs and
// kill any active Claude Code child processes. Used by the popup's Stop
// button. Idempotent; calling on an empty queue is a no-op.
export async function clearJobs(): Promise<ClearOk | DaemonError> {
  try {
    const res = await fetch(`${BASE}/jobs/clear`, { method: "POST" });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      return { error: typeof body["error"] === "string" ? body["error"] : "unknown error", status: res.status };
    }
    return {
      ok: true,
      killed: typeof body["killed"] === "number" ? body["killed"] : 0,
      cleared: typeof body["cleared"] === "number" ? body["cleared"] : 0,
    };
  } catch (err) {
    return { error: `daemon unreachable: ${(err as Error).message}`, status: 0 };
  }
}

export function isDaemonError(x: unknown): x is DaemonError {
  return typeof x === "object" && x !== null && "error" in x && "status" in x;
}
