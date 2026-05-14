import { randomUUID } from "node:crypto";
import { runClaudeCode } from "./claudeCode.js";
import { captureDiff } from "./gitDiff.js";
import { getConfig, getProjectPath } from "./config.js";

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

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
};

// NO PERSISTENCE — by design. All state below is in-memory and fresh on every
// daemon startup. See SPEC.md §"Job execution" and §"What's out of scope for v0".
// Future-us: don't add recovery here. The chat is the record of what was
// dispatched and what came back; a missing job after restart surfaces as
// "daemon unreachable" in the extension and the user retries.
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
  job.status = "running";
  job.startedAt = Date.now();
  console.log(`[job] start id=${job.id} project=${project}`);

  const cwd = getProjectPath(project);
  if (!cwd) {
    finishJob(job, { status: "failed", error: `project "${project}" no longer in config` });
    drainAndAdvance(project);
    return;
  }

  const apiKey = getConfig().anthropic_api_key;

  try {
    const result = await runClaudeCode({ cwd, prompt: job.prompt, apiKey });
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
