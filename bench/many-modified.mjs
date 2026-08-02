/** 500 committed files, then all modified — the monorepo codemod case, as tracked changes. */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.argv[2];
const FILES = Number(process.argv[3] || 500);
const LINES = Number(process.argv[4] || 40);
const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8" });

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
git("init", "-q", "-b", "main");
git("config", "user.email", "t@example.com");
git("config", "user.name", "T");

const write = (rewritten) => {
  for (let f = 0; f < FILES; f++) {
    const dir = join(ROOT, "packages", `pkg-${f % 20}`, "src");
    mkdirSync(dir, { recursive: true });
    const body = Array.from({ length: LINES }, (_, i) =>
      rewritten && i % 2
        ? `  const value${i} = computeV2(${i}, "rewritten", { flag: false });`
        : `  const value${i} = compute(${i}, "some string payload here", { flag: true });`
    ).join("\n");
    writeFileSync(join(dir, `module-${f}.ts`), body + "\n");
  }
};

write(false);
git("add", ".");
git("commit", "-qm", "base");
write(true);
console.log("ready");
