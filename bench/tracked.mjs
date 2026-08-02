/** A committed 20k-line file, then rewritten — the realistic "huge tracked diff" case. */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.argv[2];
const N = Number(process.argv[3] || 20000);
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
git("init", "-q", "-b", "main");
git("config", "user.email", "t@example.com");
git("config", "user.name", "T");

const before = Array.from(
  { length: N },
  (_, i) => `  const value${i} = compute(${i}, "some string payload here", { flag: true });`
).join("\n");
writeFileSync(join(ROOT, "generated-client.ts"), before + "\n");
git("add", ".");
git("commit", "-qm", "base");

const after = Array.from({ length: N }, (_, i) =>
  i % 2 === 0
    ? `  const value${i} = compute(${i}, "some string payload here", { flag: true });`
    : `  const value${i} = computeV2(${i}, "rewritten payload", { flag: false, extra: true });`
).join("\n");
writeFileSync(join(ROOT, "generated-client.ts"), after + "\n");
console.log("ready");
