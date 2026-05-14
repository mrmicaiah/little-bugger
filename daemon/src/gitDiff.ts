import { execFileSync } from "node:child_process";

export function captureDiff(cwd: string): string {
  let stat = "";
  let full = "";
  try {
    stat = execFileSync("git", ["diff", "--stat", "HEAD"], { cwd, encoding: "utf8" });
  } catch {
    return "";
  }
  try {
    full = execFileSync("git", ["diff", "HEAD"], { cwd, encoding: "utf8" });
  } catch {
    full = "";
  }
  if (!stat && !full) return "";
  return stat + (full ? "\n" + full : "");
}
