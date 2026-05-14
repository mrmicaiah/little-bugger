import { sendJson, type Handler } from "../http.js";
import { getJob } from "../jobs.js";

export const jobHandler: Handler = ({ res, params }) => {
  const id = params["id"];
  if (!id) {
    sendJson(res, 400, { error: "id required" });
    return;
  }
  const job = getJob(id);
  if (!job) {
    sendJson(res, 404, { error: "job not found" });
    return;
  }
  const out: Record<string, unknown> = {
    id: job.id,
    project: job.project,
    status: job.status,
    createdAt: job.createdAt,
  };
  if (job.startedAt !== undefined) out["startedAt"] = job.startedAt;
  if (job.endedAt !== undefined) out["endedAt"] = job.endedAt;
  if (job.output !== undefined) out["output"] = job.output;
  if (job.diffSummary !== undefined && job.diffSummary !== "") out["diffSummary"] = job.diffSummary;
  if (job.error !== undefined) out["error"] = job.error;
  if (job.exitCode !== undefined) out["exitCode"] = job.exitCode;
  if (job.phase !== undefined) out["phase"] = job.phase;
  if (job.phaseDetail !== undefined) out["phaseDetail"] = job.phaseDetail;
  sendJson(res, 200, out);
};
