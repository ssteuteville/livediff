import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "vitest";
import { checkPackage } from "../scripts/check-package.js";

const exec = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface FakePackage {
  packageJson: Record<string, unknown>;
  files?: Record<string, string>;
  binShebang?: boolean;
}

/** Builds a tiny fake npm tarball (the `package/` prefix layout `npm pack` produces) so
 * check-package's file/lifecycle/shebang checks can be exercised without a real `npm pack`. */
async function buildFakeTarball(spec: FakePackage): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "check-package-test-"));
  tempDirs.push(root);
  const pkgDir = join(root, "package");
  await mkdir(pkgDir, { recursive: true });
  await writeFile(join(pkgDir, "package.json"), JSON.stringify(spec.packageJson, null, 2), "utf8");

  for (const [relPath, content] of Object.entries(spec.files ?? {})) {
    const full = join(pkgDir, relPath);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content, "utf8");
  }

  const binPath = spec.packageJson["bin"];
  if (typeof binPath === "string") {
    const full = join(pkgDir, binPath);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(
      full,
      spec.binShebang === false
        ? "console.log('no shebang')\n"
        : "#!/usr/bin/env node\nconsole.log('ok')\n",
      "utf8",
    );
  }

  const tarballPath = join(root, "fake.tgz");
  await exec("tar", ["-czf", tarballPath, "-C", root, "package"]);
  return tarballPath;
}

const MINIMAL_RUNTIME_FILES = {
  "dist-server/server/cli.js": "#!/usr/bin/env node\n",
  "dist-server/server/index.js": "",
  "dist/index.html": "<html></html>",
  "schemas/config-v1.json": "{}",
  LICENSE: "MIT",
};

test("rejects a tarball missing dist/index.html", async () => {
  const tarballPath = await buildFakeTarball({
    packageJson: { name: "fake", version: "1.0.0", bin: "dist-server/server/cli.js" },
    files: {
      "dist-server/server/cli.js": "x",
      "dist-server/server/index.js": "x",
      "schemas/config-v1.json": "{}",
    },
  });
  const result = await checkPackage({ tarballPath });
  assert.ok(
    result.problems.some((p) => p.includes("dist\\/index\\.html")),
    `expected a missing dist/index.html problem, got: ${result.problems.join("; ")}`,
  );
});

test("rejects a tarball carrying developer-only files", async () => {
  const tarballPath = await buildFakeTarball({
    packageJson: { name: "fake", version: "1.0.0", bin: "dist-server/server/cli.js" },
    files: {
      ...MINIMAL_RUNTIME_FILES,
      "dist-server/scripts/release.js": "x",
      "test/foo.test.js": "x",
    },
  });
  const result = await checkPackage({ tarballPath });
  assert.ok(result.problems.some((p) => p.includes("dist-server/scripts/release.js")));
  assert.ok(result.problems.some((p) => p.includes("test/foo.test.js")));
});

test("rejects a tarball declaring a consumer lifecycle script", async () => {
  const tarballPath = await buildFakeTarball({
    packageJson: {
      name: "fake",
      version: "1.0.0",
      bin: "dist-server/server/cli.js",
      scripts: { postinstall: "node do-something.js" },
    },
    files: MINIMAL_RUNTIME_FILES,
  });
  const result = await checkPackage({ tarballPath });
  assert.ok(result.problems.some((p) => p.includes('"postinstall"')));
});

test("rejects a bin target with no shebang", async () => {
  const tarballPath = await buildFakeTarball({
    packageJson: { name: "fake", version: "1.0.0", bin: "dist-server/server/cli.js" },
    files: MINIMAL_RUNTIME_FILES,
    binShebang: false,
  });
  const result = await checkPackage({ tarballPath });
  assert.ok(result.problems.some((p) => p.includes("no shebang")));
});

test("accepts a tarball with every required file, no forbidden ones, and a valid bin", async () => {
  const tarballPath = await buildFakeTarball({
    packageJson: { name: "fake", version: "1.0.0", bin: "dist-server/server/cli.js" },
    files: MINIMAL_RUNTIME_FILES,
  });
  const result = await checkPackage({ tarballPath });
  const structuralProblems = result.problems.filter(
    (p) =>
      !p.startsWith("release version metadata") && !p.startsWith("release version check failed"),
  );
  assert.deepEqual(structuralProblems, []);
});
