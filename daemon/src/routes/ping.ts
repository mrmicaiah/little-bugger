import { sendJson, type Handler } from "../http.js";
import { getConfig, getProjectPath } from "../config.js";
import { enqueueJob } from "../jobs.js";

const PING_PROMPT =
  "Respond with the single word: pong. Do not read any files, do not run any commands, do not edit anything. Just respond.";

export const pingHandler: Handler = ({ res, body }) => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    sendJson(res, 400, { error: "body must be a JSON object" });
    return;
  }
  const project = (body as Record<string, unknown>)["project"];
  if (typeof project !== "string" || project.length === 0) {
    sendJson(res, 400, { error: "project required" });
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
  const job = enqueueJob(project, PING_PROMPT);
  sendJson(res, 200, { jobId: job.id });
};
