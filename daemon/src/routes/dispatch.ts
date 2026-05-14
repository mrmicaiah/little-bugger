import { sendJson, type Handler } from "../http.js";
import { getConfig, getProjectPath } from "../config.js";
import { enqueueJob } from "../jobs.js";

export const dispatchHandler: Handler = ({ res, body }) => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    sendJson(res, 400, { error: "body must be a JSON object" });
    return;
  }
  const b = body as Record<string, unknown>;
  const project = b["project"];
  const prompt = b["prompt"];
  if (typeof project !== "string" || project.length === 0) {
    sendJson(res, 400, { error: "project required" });
    return;
  }
  if (typeof prompt !== "string" || prompt.length === 0) {
    sendJson(res, 400, { error: "prompt required" });
    return;
  }
  if (!getProjectPath(project)) {
    sendJson(res, 404, { error: `unknown project: ${project}` });
    return;
  }
  if (!getConfig().anthropic_api_key) {
    sendJson(res, 503, { error: "daemon not configured: anthropic_api_key missing" });
    return;
  }
  const job = enqueueJob(project, prompt);
  sendJson(res, 200, { jobId: job.id });
};
