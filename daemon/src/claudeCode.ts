import crossSpawn from "cross-spawn";
import type { ChildProcess } from "node:child_process";

export type RunResult = {
  output: string;
  exitCode: number;
  isError: boolean;
  errorText?: string;
};

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

export function runClaudeCode(opts: {
  cwd: string;
  prompt: string;
  apiKey: string;
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
          if (msg["type"] === "result") {
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
