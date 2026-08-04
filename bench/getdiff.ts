/** Time getDiff against an existing repo, without regenerating it. */
import type { WorkingTreeDiff } from "../server/git.ts";

const ROOT = process.argv[2];
if (!ROOT) throw new Error("Expected repository path argument");
type GetDiff = (cwd: string, base?: string | null) => Promise<WorkingTreeDiff>;
const compiledGitModulePath = "../dist-server/server/git.js";
const module: unknown = await import(compiledGitModulePath);
if (!hasGetDiff(module)) throw new Error("compiled git module does not export getDiff");
const { getDiff } = module;
const t0 = performance.now();
const diff = await getDiff(ROOT, null);
console.log(
  JSON.stringify(
    { getDiffMs: Math.round(performance.now() - t0), files: diff.files.length },
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
