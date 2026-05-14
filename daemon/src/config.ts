import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export type Config = {
  projects: Record<string, string>;
  anthropic_api_key: string;
  port: number;
};

let currentConfig: Config | null = null;
let watcher: fs.FSWatcher | null = null;

export function getConfigPath(): string {
  if (process.platform === "win32") {
    const appData = process.env["APPDATA"];
    if (!appData) throw new Error("APPDATA environment variable not set");
    return path.join(appData, "bugger", "config.json");
  }
  return path.join(os.homedir(), ".bugger", "config.json");
}

const BOOTSTRAP_STUB = {
  _comment:
    "Little Bugger config. Set anthropic_api_key, then add projects as { name: absolute-path }. Edits are picked up live; no daemon restart needed. Unknown top-level keys (like this one) are ignored.",
  projects: {},
  anthropic_api_key: "",
  port: 8765,
};

export function ensureConfigFile(): { path: string; bootstrapped: boolean } {
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    return { path: configPath, bootstrapped: false };
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(BOOTSTRAP_STUB, null, 2) + "\n", "utf8");
  return { path: configPath, bootstrapped: true };
}

function parseAndValidate(raw: string, configPath: string): Config {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON in ${configPath}: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${configPath}: top level must be an object`);
  }
  const obj = parsed as Record<string, unknown>;

  const projects = obj["projects"];
  if (projects !== undefined && (typeof projects !== "object" || projects === null || Array.isArray(projects))) {
    throw new Error(`${configPath}: "projects" must be an object`);
  }
  const projectsValidated: Record<string, string> = {};
  if (projects) {
    for (const [name, value] of Object.entries(projects as Record<string, unknown>)) {
      if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${configPath}: project "${name}" must be a non-empty string path`);
      }
      if (!path.isAbsolute(value)) {
        throw new Error(`${configPath}: project "${name}" path must be absolute: ${value}`);
      }
      try {
        const st = fs.statSync(value);
        if (!st.isDirectory()) {
          throw new Error(`${configPath}: project "${name}" path is not a directory: ${value}`);
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          throw new Error(`${configPath}: project "${name}" path does not exist: ${value}`);
        }
        throw err;
      }
      projectsValidated[name] = value;
    }
  }

  const apiKey = obj["anthropic_api_key"];
  if (apiKey !== undefined && typeof apiKey !== "string") {
    throw new Error(`${configPath}: "anthropic_api_key" must be a string`);
  }

  const port = obj["port"];
  let portValidated = 8765;
  if (port !== undefined) {
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`${configPath}: "port" must be an integer between 1 and 65535`);
    }
    portValidated = port;
  }

  // Unknown top-level keys (e.g. `_comment`) are silently ignored.

  return {
    projects: projectsValidated,
    anthropic_api_key: typeof apiKey === "string" ? apiKey : "",
    port: portValidated,
  };
}

export async function loadConfig(): Promise<void> {
  const configPath = getConfigPath();
  const raw = await fs.promises.readFile(configPath, "utf8");
  currentConfig = parseAndValidate(raw, configPath);
}

export function watchConfig(): void {
  if (watcher) return;
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);
  const filename = path.basename(configPath);
  let debounceTimer: NodeJS.Timeout | null = null;

  // Watch the directory, not the file. Atomic-write editors (rename a temp file
  // over the original) break a file-level watcher because the inode changes.
  watcher = fs.watch(dir, (_event, changed) => {
    if (changed !== filename) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void reloadConfig(configPath);
    }, 150);
  });
}

async function reloadConfig(configPath: string): Promise<void> {
  try {
    const raw = await fs.promises.readFile(configPath, "utf8");
    const next = parseAndValidate(raw, configPath);
    const prev = currentConfig;
    currentConfig = next;
    logReloadDiff(prev, next);
  } catch (err) {
    console.error(`[config] reload failed, keeping previous config: ${(err as Error).message}`);
  }
}

function logReloadDiff(prev: Config | null, next: Config): void {
  const prevNames = new Set(prev ? Object.keys(prev.projects) : []);
  const nextNames = new Set(Object.keys(next.projects));
  const added = [...nextNames].filter((n) => !prevNames.has(n));
  const removed = [...prevNames].filter((n) => !nextNames.has(n));
  const parts: string[] = [];
  if (added.length) parts.push(`added: ${added.join(", ")}`);
  if (removed.length) parts.push(`removed: ${removed.join(", ")}`);
  const prevKey = prev?.anthropic_api_key ?? "";
  const nextKey = next.anthropic_api_key;
  if (!prevKey && nextKey) parts.push("api_key: set");
  if (prevKey && !nextKey) parts.push("api_key: cleared");
  console.log(`[config] reloaded${parts.length ? " — " + parts.join("; ") : ""}`);
}

export function getConfig(): Readonly<Config> {
  if (!currentConfig) throw new Error("config not loaded");
  return currentConfig;
}

export function getProjectPath(name: string): string | undefined {
  return getConfig().projects[name];
}

export function getProjectNames(): string[] {
  return Object.keys(getConfig().projects);
}
