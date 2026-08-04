/** Time getDiff against an existing repo, without regenerating it. */
import { getDiff } from "../dist-server/server/git.js";

const ROOT = process.argv[2];
const t0 = performance.now();
const diff = await getDiff(ROOT, null);
console.log(
  JSON.stringify(
    { getDiffMs: Math.round(performance.now() - t0), files: diff.files.length },
    null,
    2,
  ),
);
