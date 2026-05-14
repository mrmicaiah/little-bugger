import * as http from "node:http";

export type RouteContext = {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  params: Record<string, string>;
  body: unknown;
};

export type Handler = (ctx: RouteContext) => Promise<void> | void;

type Route = {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
  needsBody: boolean;
};

const routes: Route[] = [];

export function addRoute(
  method: string,
  pathPattern: string,
  handler: Handler,
  opts: { needsBody?: boolean } = {},
): void {
  const paramNames: string[] = [];
  const regexStr =
    "^" +
    pathPattern.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, (m) => {
      paramNames.push(m.slice(1));
      return "([^/]+)";
    }) +
    "$";
  routes.push({
    method: method.toUpperCase(),
    pattern: new RegExp(regexStr),
    paramNames,
    handler,
    needsBody: !!opts.needsBody,
  });
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  // setHeader (not writeHead's header object) so CORS headers set earlier
  // in the request lifecycle aren't clobbered.
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(payload).toString());
  res.writeHead(status);
  res.end(payload);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return null;
  return JSON.parse(raw);
}

export function createServer(): http.Server {
  return http.createServer(async (req, res) => {
    // CORS headers on every response. The daemon is localhost-only (binds
    // 127.0.0.1), so * is acceptable — the network is the only attacker
    // surface and we exclude that by binding loopback.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
    if ((req.method ?? "").toUpperCase() === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathOnly = url.pathname;
      const method = (req.method ?? "GET").toUpperCase();
      for (const route of routes) {
        if (route.method !== method) continue;
        const m = route.pattern.exec(pathOnly);
        if (!m) continue;
        const params: Record<string, string> = {};
        for (let i = 0; i < route.paramNames.length; i++) {
          const name = route.paramNames[i]!;
          params[name] = decodeURIComponent(m[i + 1]!);
        }
        let body: unknown = null;
        if (route.needsBody) {
          try {
            body = await readJsonBody(req);
          } catch (err) {
            sendJson(res, 400, { error: `invalid JSON body: ${(err as Error).message}` });
            return;
          }
        }
        await route.handler({ req, res, params, body });
        return;
      }
      sendJson(res, 404, { error: `no route for ${method} ${pathOnly}` });
    } catch (err) {
      console.error(`[http] handler error: ${(err as Error).stack ?? (err as Error).message}`);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal error" });
      } else {
        res.end();
      }
    }
  });
}
