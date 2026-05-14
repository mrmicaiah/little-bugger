import { sendJson, type Handler } from "../http.js";
import { getProjectNames } from "../config.js";

export const configHandler: Handler = ({ res }) => {
  sendJson(res, 200, { projects: getProjectNames() });
};
