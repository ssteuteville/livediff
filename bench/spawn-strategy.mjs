/**
 * Compare three ways to get every file's patch: today's sequential per-file spawn, the same
 * spawns run concurrently, and a single whole-tree `git diff` split in JS.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const ROOT = process.argv[2];
const BIG = { maxBuffer: 1 << 28, cwd: ROOT, encoding: "utf8" };

const paths = (await exec("git", ["diff", "--name-only", "HEAD"], BIG)).stdout
  .split("\n")
  .filter(Boolean);

async function sequential() {
  const out = [];
  for (const p of paths) out.push((await exec("git", ["diff", "HEAD", "--", p], BIG)).stdout);
  return out;
}

async function concurrent(limit = 16) {
  const out = Array.from({ length: paths.length });
  let cursor = 0;
  async function worker() {
    while (cursor < paths.length) {
      const i = cursor++;
      out[i] = (await exec("git", ["diff", "HEAD", "--", paths[i]], BIG)).stdout;
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return out;
}

/** One spawn for the whole tree, split on the diff header — what git itself is optimized for. */
async function single() {
  const all = (await exec("git", ["diff", "HEAD"], BIG)).stdout;
  const parts = all.split(/^diff --git /m).filter(Boolean);
  return parts.map((p) => `diff --git ${p}`);
}

async function time(label, fn) {
  const t0 = performance.now();
  const out = await fn();
  return { label, ms: Math.round(performance.now() - t0), chunks: out.length };
}

const results = [];
results.push(await time("sequential (today)", sequential));
results.push(await time("concurrent x16", () => concurrent(16)));
results.push(await time("single whole-tree spawn", single));
console.log(JSON.stringify({ files: paths.length, results }, null, 2));
