import { sendJson, type Handler } from "../http.js";
import { VERSION } from "../version.js";

export const healthHandler: Handler = ({ res }) => {
  sendJson(res, 200, { ok: true, version: VERSION });
};
