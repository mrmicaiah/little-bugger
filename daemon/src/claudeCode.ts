import crossSpawn from "cross-spawn";
import type { ChildProcess } from "node:child_process";
import type { JobPhase } from "./jobs.js";

export type RunResult = {
  output: string;
  exitCode: number;
  isError: boolean;
  errorText?: string;
};

export type PhaseUpdate = (phase: JobPhase, detail?: string) => void;

const active = new Set<ChildProcess>();

export function killAllActive(): void {
  for (const child of active) {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}

// Map a Claude Code tool_use event into a job phase + a short human detail
// (file basename, command preview, etc.). The phase strings match the JobPhase
// enum; the extension formats them for user display.
function derivePhaseFromTool(name: string, input: unknown): { phase: JobPhase; detail?: string } {
  const lname = (name ?? "").toLowerCase();
  const inputObj = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;

  const pickString = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = inputObj[k];
      if (typeof v === "string" && v.length > 0) return v;
    }
    return undefined;
  };
  const basename = (p: string): string => {
    const parts = p.replace(/\\/g, "/").split("/");
    return parts[parts.length - 1] || p;
  };
  const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);

  if (lname === "read") {
    const p = pickString("file_path");
    return { phase: "reading", detail: p ? basename(p) : undefined };
  }
  if (lname === "glob") {
    return { phase: "reading", detail: truncate(pickString("pattern") ?? "files", 40) };
  }
  if (lname === "grep") {
    return { phase: "reading", detail: truncate(pickString("pattern") ?? "files", 40) };
  }
  if (lname === "edit" || lname === "write" || lname === "multiedit") {
    const p = pickString("file_path");
    return { phase: "editing", detail: p ? basename(p) : undefined };
  }
  if (lname === "notebookedit") {
    const p = pickString("notebook_path", "file_path");
    return { phase: "editing", detail: p ? basename(p) : undefined };
  }
  if (lname === "bash") {
    const cmd = pickString("command");
    return { phase: "running_command", detail: cmd ? truncate(cmd, 40) : undefined };
  }
  // Unknown / agent / web tools all read as "thinking" — keeps the pill
  // honest about not knowing what's happening rather than pretending.
  return { phase: "thinking" };
}

function derivePhaseFromAssistant(msg: Record<string, unknown>): { phase: JobPhase; detail?: string } | null {
  const message = msg["message"] as Record<string, unknown> | undefined;
  const content = message?.["content"];
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block && typeof block === "object" && (block as Record<string, unknown>)["type"] === "tool_use") {
      const b = block as Record<string, unknown>;
      const name = typeof b["name"] === "string" ? b["name"] : "";
      return derivePhaseFromTool(name, b["input"]);
    }
  }
  // No tool use this turn — pure reasoning/text.
  return { phase: "thinking" };
}

export function runClaudeCode(opts: {
  cwd: string;
  prompt: string;
  apiKey: string;
  onPhase?: PhaseUpdate;
}): Promise<RunResult> {
  return new Promise((resolve) => {
    const args = [
      "--print",
      "--input-format",
      "text",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--max-turns",
      "50",
    ];

    const env = { ...process.env };
    if (opts.apiKey) env["ANTHROPIC_API_KEY"] = opts.apiKey;

    const child = crossSpawn("claude", args, {
      cwd: opts.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });

    active.add(child);

    let stdoutBuf = "";
    let stderrBuf = "";
    let finalOutput = "";
    let resultIsError = false;
    let resultErrorText: string | undefined;
    let sawResult = false;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      let idx: number;
      while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg["type"] === "system" && msg["subtype"] === "init") {
            opts.onPhase?.("started");
          } else if (msg["type"] === "assistant") {
            const update = derivePhaseFromAssistant(msg);
            if (update) opts.onPhase?.(update.phase, update.detail);
          } else if (msg["type"] === "result") {
            sawResult = true;
            const r = msg["result"];
            finalOutput = typeof r === "string" ? r : "";
            const subtype = msg["subtype"];
            resultIsError =
              msg["is_error"] === true ||
              (typeof subtype === "string" && subtype !== "success");
            if (resultIsError) {
              if (typeof subtype === "string" && subtype !== "success") {
                resultErrorText = `claude reported ${subtype}`;
              } else {
                resultErrorText = "claude returned is_error=true (see output)";
              }
            }
          }
        } catch (err) {
          // Don't crash on malformed lines; log and continue.
          console.error(`[claude] failed to parse stream-json line: ${(err as Error).message}`);
        }
      }
    });

    child.stderr?.on("data", (chunk: string) => {
      stderrBuf += chunk;
    });

    child.on("error", (err) => {
      active.delete(child);
      resolve({
        output: "",
        exitCode: -1,
        isError: true,
        errorText: `spawn failed: ${err.message}`,
      });
    });

    child.on("close", (code) => {
      active.delete(child);
      const exitCode = code ?? -1;
      if (!sawResult) {
        const tail = stderrBuf.split("\n").slice(-10).join("\n").trim();
        resolve({
          output: "",
          exitCode,
          isError: true,
          errorText: `claude exited (code=${exitCode}) without emitting a result${tail ? ": " + tail : ""}`,
        });
        return;
      }
      resolve({
        output: finalOutput,
        exitCode,
        isError: resultIsError || exitCode !== 0,
        errorText: resultErrorText,
      });
    });

    try {
      child.stdin?.write(opts.prompt);
      child.stdin?.end();
    } catch (err) {
      console.error(`[claude] stdin write failed: ${(err as Error).message}`);
    }
  });
}
