import { randomUUID } from "node:crypto";
import { runClaudeCode } from "./claudeCode.js";
import { captureDiff } from "./gitDiff.js";
import { getConfig, getProjectPath } from "./config.js";
import { killAllActive } from "./claudeCode.js";

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

// Worker-activity phases derived from Claude Code's stream-json output.
// Updated live during job execution so the extension can show a status pill.
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
  prompt: string;
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

// NO PERSISTENCE — by design. All state below is in-memory and fresh on every
// daemon startup. See SPEC.md §"Job execution" and §"What's out of scope for v0".
const jobsById = new Map<string, Job>();
const perProjectQueue = new Map<string, Job[]>();

export function enqueueJob(project: string, prompt: string): Job {
  const job: Job = {
    id: randomUUID(),
    project,
    prompt,
    status: "queued",
    createdAt: Date.now(),
  };
  jobsById.set(job.id, job);
  let queue = perProjectQueue.get(project);
  if (!queue) {
    queue = [];
    perProjectQueue.set(project, queue);
  }
  queue.push(job);
  const aheadOf = queue.length - 1;
  console.log(
    `[dispatch] received job=${job.id} project=${project}${aheadOf > 0 ? ` queued (ahead=${aheadOf})` : ""}`,
  );
  if (queue.length === 1) {
    void runNext(project);
  }
  return job;
}

async function runNext(project: string): Promise<void> {
  const queue = perProjectQueue.get(project);
  if (!queue || queue.length === 0) return;
  const job = queue[0]!;
  // If the job was cancelled while queued, just advance past it.
  if (job.status === "failed") {
    drainAndAdvance(project);
    return;
  }
  job.status = "running";
  job.startedAt = Date.now();
  console.log(`[job] start id=${job.id} project=${project}`);

  const cwd = getProjectPath(project);
  if (!cwd) {
    finishJob(job, { status: "failed", error: `project "${project}" no longer in config` });
    drainAndAdvance(project);
    return;
  }

  const config = getConfig();
  const apiKey = config.anthropic_api_key;
  const maxTurns = config.max_turns;
  job.phase = "started";

  try {
    const result = await runClaudeCode({
      cwd,
      prompt: job.prompt,
      apiKey,
      maxTurns,
      onPhase: (phase, detail) => {
        job.phase = phase;
        job.phaseDetail = detail;
      },
    });
    if (result.isError) {
      finishJob(job, {
        status: "failed",
        output: result.output,
        error: result.errorText ?? `claude exited ${result.exitCode}`,
        exitCode: result.exitCode,
      });
    } else {
      const diff = captureDiff(cwd);
      finishJob(job, {
        status: "succeeded",
        output: result.output,
        diffSummary: diff,
        exitCode: result.exitCode,
      });
    }
  } catch (err) {
    finishJob(job, { status: "failed", error: (err as Error).message });
  }

  drainAndAdvance(project);
}

function finishJob(
  job: Job,
  fields: Partial<Job> & { status: "succeeded" | "failed" },
): void {
  Object.assign(job, fields);
  job.endedAt = Date.now();
  job.phase = "done";
  job.phaseDetail = undefined;
  const duration = job.endedAt - (job.startedAt ?? job.createdAt);
  const exit = job.exitCode !== undefined ? ` exit=${job.exitCode}` : "";
  console.log(`[job] ${job.status} id=${job.id} project=${job.project} duration_ms=${duration}${exit}`);
}

function drainAndAdvance(project: string): void {
  const queue = perProjectQueue.get(project);
  if (!queue) return;
  queue.shift();
  if (queue.length === 0) {
    perProjectQueue.delete(project);
    return;
  }
  void runNext(project);
}

export function getJob(id: string): Job | undefined {
  return jobsById.get(id);
}

// Clear all jobs across all projects. Kills any active Claude Code child
// processes, marks every queued and running job as failed (so polls return
// a clean error), and empties the per-project queues. Used by the Stop
// button in the popup.
export function clearAllJobs(): { killed: number; cleared: number } {
  let killed = 0;
  let cleared = 0;

  // Mark every non-terminal job as failed/cancelled so anyone polling them
  // gets a definitive answer.
  for (const job of jobsById.values()) {
    if (job.status === "queued" || job.status === "running") {
      job.status = "failed";
      job.error = "cancelled by user";
      job.endedAt = Date.now();
      job.phase = "done";
      job.phaseDetail = undefined;
      cleared++;
      if (job.status === "failed") killed++;
    }
  }

  // Drop all queues. Any runNext loops in flight will see queue.length===0
  // on their next drainAndAdvance and stop cleanly.
  perProjectQueue.clear();

  // Kill any live Claude Code child processes.
  killAllActive();

  console.log(`[clear] cancelled ${cleared} job(s), killed active children`);
  return { killed, cleared };
}
