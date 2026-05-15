import { VERSION } from "./version.js";
import { ensureConfigFile, getConfig, loadConfig, watchConfig } from "./config.js";
import { addRoute, createServer } from "./http.js";
import { healthHandler } from "./routes/health.js";
import { configHandler } from "./routes/config.js";
import { dispatchHandler } from "./routes/dispatch.js";
import { jobHandler, jobsClearHandler } from "./routes/jobs.js";
import { pingHandler } from "./routes/ping.js";
import { killAllActive } from "./claudeCode.js";

async function main(): Promise<void> {
  const { path: configPath, bootstrapped } = ensureConfigFile();
  if (bootstrapped) {
    console.log(
      `[startup] wrote bootstrap config to ${configPath} — edit anthropic_api_key and projects, no restart needed`,
    );
  } else {
    console.log(`[startup] config file: ${configPath}`);
  }

  try {
    await loadConfig();
  } catch (err) {
    console.error(`[startup] failed to load config: ${(err as Error).message}`);
    process.exit(1);
  }

  watchConfig();

  const projectCount = Object.keys(getConfig().projects).length;
  console.log(`[startup] loaded ${projectCount} project(s)`);

  if (!getConfig().anthropic_api_key) {
    console.log(
      `[startup] WARNING: anthropic_api_key is empty — dispatches will be rejected with 503 until you set it`,
    );
  }

  addRoute("GET", "/health", healthHandler);
  addRoute("GET", "/config", configHandler);
  addRoute("POST", "/dispatch", dispatchHandler, { needsBody: true });
  addRoute("GET", "/jobs/:id", jobHandler);
  addRoute("POST", "/jobs/clear", jobsClearHandler);
  addRoute("POST", "/ping", pingHandler, { needsBody: true });

  const port = getConfig().port;
  const server = createServer();

  server.listen(port, "127.0.0.1", () => {
    console.log(`[startup] Little Bugger daemon v${VERSION} listening on http://127.0.0.1:${port}`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received, killing active children and closing server`);
    killAllActive();
    server.close(() => {
      console.log(`[shutdown] server closed, exiting`);
      process.exit(0);
    });
    setTimeout(() => {
      console.log(`[shutdown] forced exit after 5s grace`);
      process.exit(0);
    }, 5000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  if (process.platform === "win32") {
    process.on("SIGBREAK" as NodeJS.Signals, () => shutdown("SIGBREAK"));
  }

  process.on("uncaughtException", (err) => {
    console.error(`[fatal] uncaught exception: ${err.stack ?? err.message}`);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    console.error(`[fatal] unhandled rejection: ${detail}`);
    process.exit(1);
  });
}

void main();
