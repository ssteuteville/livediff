/**
 * Build a repo whose working tree contains a diff of a requested shape, then report what
 * livediff's own getDiff produces for it. Shapes are the realistic ways a diff gets big.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { WorkingTreeDiff } from "../server/git.ts";

function requiredArg(index: number, name: string): string {
  const value = process.argv[index];
  if (!value) throw new Error(`Expected ${name} argument`);
  return value;
}

const ROOT = requiredArg(2, "repository path");
const SHAPE = requiredArg(3, "shape");

const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });

function line(i: number): string {
  return `  const value${i} = compute(${i}, "some string payload here", { flag: true });`;
}

function reset() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  writeFileSync(join(ROOT, "seed.txt"), "seed\n");
  git("add", ".");
  git("commit", "-qm", "init");
}

const SHAPES: Record<string, () => void> = {
  // One enormous file — a generated client, a migration, a lockfile.
  "one-huge-file"() {
    const body = Array.from({ length: 20000 }, (_, i) => line(i)).join("\n");
    writeFileSync(join(ROOT, "generated-client.ts"), body + "\n");
  },
  // Many small files — a rename sweep or a codemod across a monorepo.
  "many-small-files"() {
    for (let f = 0; f < 500; f++) {
      const dir = join(ROOT, "packages", `pkg-${f % 20}`, "src");
      mkdirSync(dir, { recursive: true });
      const body = Array.from({ length: 40 }, (_, i) => line(i)).join("\n");
      writeFileSync(join(dir, `module-${f}.ts`), body + "\n");
    }
  },
  // Modifications rather than additions: every other line changed in committed files.
  "modified-not-added"() {
    for (let f = 0; f < 40; f++) {
      const body = Array.from({ length: 500 }, (_, i) => line(i)).join("\n");
      writeFileSync(join(ROOT, `mod-${f}.ts`), body + "\n");
    }
    git("add", ".");
    git("commit", "-qm", "base");
    for (let f = 0; f < 40; f++) {
      const body = Array.from({ length: 500 }, (_, i) =>
        i % 2 === 0 ? line(i) : `  // rewritten ${i}`,
      ).join("\n");
      writeFileSync(join(ROOT, `mod-${f}.ts`), body + "\n");
    }
  },
  // The pathological one: a minified bundle, all on a handful of gigantic lines.
  "minified-single-line"() {
    const chunk = Array.from({ length: 20000 }, (_, i) => `f${i}(${i}),`).join("");
    writeFileSync(join(ROOT, "bundle.min.js"), `!function(){${chunk}}();\n`);
  },
  // A lockfile: huge, uninteresting, and present in a great many real diffs.
  lockfile() {
    const body = Array.from({ length: 20000 }, (_, i) =>
      i % 4 === 0
        ? `  "package-${i}@^1.0.0":`
        : `    resolved "https://registry.example.com/package-${i}/-/package-${i}-1.0.0.tgz"`,
    ).join("\n");
    writeFileSync(join(ROOT, "pnpm-lock.yaml"), body + "\n");
  },
};

reset();
const shape = SHAPES[SHAPE];
if (!shape) throw new Error(`Unknown shape: ${SHAPE}`);
shape();

type GetDiff = (cwd: string, base?: string | null) => Promise<WorkingTreeDiff>;
const compiledGitModulePath = "../dist-server/server/git.js";
const module: unknown = await import(compiledGitModulePath);
if (!hasGetDiff(module)) throw new Error("compiled git module does not export getDiff");
const { getDiff } = module;

const t0 = performance.now();
const diff = await getDiff(ROOT, null);
const elapsed = performance.now() - t0;

const json = JSON.stringify(diff);
const patchBytes = diff.files.reduce((n, f) => n + (f.patch?.length ?? 0), 0);
const patchLines = diff.files.reduce((n, f) => n + (f.patch?.split("\n").length ?? 0), 0);
const biggest = diff.files.toSorted((a, b) => (b.patch?.length ?? 0) - (a.patch?.length ?? 0))[0];

console.log(
  JSON.stringify(
    {
      shape: SHAPE,
      getDiffMs: Math.round(elapsed),
      files: diff.files.length,
      payloadMB: +(json.length / 1024 / 1024).toFixed(2),
      patchMB: +(patchBytes / 1024 / 1024).toFixed(2),
      patchLines,
      additions: diff.files.reduce((n, f) => n + (f.additions ?? 0), 0),
      biggestFile: biggest
        ? { path: biggest.path, kb: Math.round(biggest.patch.length / 1024) }
        : null,
    },
    null,
    2,
  ),
);

function hasGetDiff(value: unknown): value is { getDiff: GetDiff } {
  return (
    value !== null &&
    typeof value === "object" &&
    "getDiff" in value &&
    typeof value.getDiff === "function"
  );
}
