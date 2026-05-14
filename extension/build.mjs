import { build, context } from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";

const watch = process.argv.includes("--watch");
const outdir = "dist";

fs.mkdirSync(outdir, { recursive: true });

const common = {
  bundle: true,
  format: "iife",
  target: "chrome120",
  sourcemap: "inline",
  logLevel: "info",
  legalComments: "none",
};

const builds = [
  { entryPoints: ["src/background.ts"], outfile: `${outdir}/background.js`, ...common },
  { entryPoints: ["src/content.ts"], outfile: `${outdir}/content.js`, ...common },
  { entryPoints: ["src/popup.ts"], outfile: `${outdir}/popup.js`, ...common },
];

if (watch) {
  const contexts = await Promise.all(builds.map((b) => context(b)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log("[build] watching...");
} else {
  await Promise.all(builds.map((b) => build(b)));
  // Report sizes
  for (const b of builds) {
    const stats = fs.statSync(b.outfile);
    console.log(`[build] ${b.outfile}: ${(stats.size / 1024).toFixed(1)} KB`);
  }
}
