import { test } from "vitest";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { withTempXdg } from "./helpers.js";
import {
  parseLens,
  parseLensSet,
  listLenses,
  setLenses,
  upsertLens,
  removeLens,
  clearLenses,
  lensStorePath,
} from "../server/lenses.js";
import { filesMatching } from "../server/glob.js";

const retry = { name: "retry", why: "the actual change", paths: ["src/retry.ts"] };

const DIFF_FILES = [
  "README.md",
  "src/queue.ts",
  "src/retry.ts",
  "test/retry.test.ts",
  "test/unit/queue.test.ts",
];

test("a lens resolves to the diff files it matches, in the diff's order", () => {
  const lens = parseLens({ name: "core", paths: ["src/**", "README.md"] }, "lens 0");
  assert.deepEqual(filesMatching(lens.paths, DIFF_FILES), [
    "README.md",
    "src/queue.ts",
    "src/retry.ts",
  ]);
});

test("a lens mixing a glob and a literal resolves both", () => {
  const lens = parseLens({ name: "mixed", paths: ["test/**", "src/retry.ts"] }, "lens 0");
  assert.deepEqual(filesMatching(lens.paths, DIFF_FILES), [
    "src/retry.ts",
    "test/retry.test.ts",
    "test/unit/queue.test.ts",
  ]);
});

test("a lens matching nothing in the diff resolves to an empty list, not an error", () => {
  const lens = parseLens({ name: "gone", paths: ["docs/**"] }, "lens 0");
  assert.deepEqual(filesMatching(lens.paths, DIFF_FILES), []);
});

test("a lens resolves to nothing against an empty diff", () => {
  const lens = parseLens({ name: "core", paths: ["src/**"] }, "lens 0");
  assert.deepEqual(filesMatching(lens.paths, []), []);
});

test("a file matched by two of a lens's patterns is listed once", () => {
  const lens = parseLens({ name: "dup", paths: ["src/**", "src/retry.ts"] }, "lens 0");
  assert.deepEqual(filesMatching(lens.paths, DIFF_FILES), ["src/queue.ts", "src/retry.ts"]);
});

test("a lens parses with its optional fields defaulted", () => {
  const lens = parseLens({ name: "retry", paths: ["src/retry.ts"] }, "lens 0");
  assert.equal(lens.name, "retry");
  assert.equal(lens.why, null);
  assert.deepEqual(lens.highlights, []);
  assert.match(lens.createdAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("a supplied createdAt is preserved so a round trip is lossless", () => {
  const lens = parseLens({ ...retry, createdAt: "2026-01-01T00:00:00.000Z" }, "lens 0");
  assert.equal(lens.createdAt, "2026-01-01T00:00:00.000Z");
});

test("a name outside the pattern is rejected, at both ends of the range", () => {
  assert.throws(() => parseLens({ ...retry, name: "" }, "lens 0"), /name/);
  assert.throws(() => parseLens({ ...retry, name: "-leading" }, "lens 0"), /name/);
  assert.throws(() => parseLens({ ...retry, name: "Retry" }, "lens 0"), /name/);
  assert.throws(() => parseLens({ ...retry, name: "has space" }, "lens 0"), /name/);
  assert.throws(() => parseLens({ ...retry, name: "a".repeat(41) }, "lens 0"), /name/);
  assert.doesNotThrow(() => parseLens({ ...retry, name: "a" }, "lens 0"));
  assert.doesNotThrow(() => parseLens({ ...retry, name: "a".repeat(40) }, "lens 0"));
});

test("a lens with no paths is rejected — it could never be intended", () => {
  assert.throws(() => parseLens({ name: "retry", paths: [] }, "lens 0"), /paths/);
  assert.throws(() => parseLens({ name: "retry" }, "lens 0"), /paths/);
});

test("the error names where the bad lens was, so a set of ten is debuggable", () => {
  assert.throws(() => parseLens({ name: "BAD", paths: ["a"] }, "lens 7"), /lens 7/);
});

test("a highlight must have a sane range", () => {
  const withRange = (h: unknown) => () => parseLens({ ...retry, highlights: [h] }, "lens 0");
  assert.throws(withRange({ path: "src/retry.ts", start: 5, end: 4 }), /end/);
  assert.throws(withRange({ path: "src/retry.ts", start: 0, end: 4 }), /start/);
  assert.throws(withRange({ path: "src/retry.ts", start: 1.5, end: 4 }), /start/);
  assert.doesNotThrow(withRange({ path: "src/retry.ts", start: 4, end: 4 }));
});

test("a highlight outside the lens's own paths is rejected — it could never render", () => {
  assert.throws(
    () => parseLens({ ...retry, highlights: [{ path: "src/other.ts", start: 1, end: 2 }] }, "l"),
    /src\/other\.ts/,
  );
  assert.doesNotThrow(() =>
    parseLens(
      { name: "t", paths: ["test/**"], highlights: [{ path: "test/a.ts", start: 1, end: 2 }] },
      "l",
    ),
  );
});

test("a set rejects duplicate names rather than silently keeping one", () => {
  assert.throws(() => parseLensSet({ lenses: [retry, retry] }), /retry/);
});

test("a set accepts a bare array as well as the wrapped form", () => {
  assert.equal(parseLensSet([retry]).length, 1);
  assert.equal(parseLensSet({ lenses: [retry] }).length, 1);
});

test("an absent store reads as an empty set", async () => {
  await withTempXdg(async () => {
    assert.deepEqual(await listLenses("ws1"), []);
  });
});

test("setting replaces the whole set rather than merging into it", async () => {
  await withTempXdg(async () => {
    await setLenses("ws1", parseLensSet([retry, { name: "tests", paths: ["test/**"] }]));
    await setLenses("ws1", parseLensSet([{ name: "docs", paths: ["docs/**"] }]));
    assert.deepEqual(
      (await listLenses("ws1")).map((l) => l.name),
      ["docs"],
    );
  });
});

test("the stored order is the order given, because it is the order the picker shows", async () => {
  await withTempXdg(async () => {
    await setLenses(
      "ws1",
      parseLensSet([
        { name: "b", paths: ["b"] },
        { name: "a", paths: ["a"] },
      ]),
    );
    assert.deepEqual(
      (await listLenses("ws1")).map((l) => l.name),
      ["b", "a"],
    );
  });
});

test("the store is written with its version", async () => {
  await withTempXdg(async () => {
    await setLenses("ws1", parseLensSet([retry]));
    const raw: Record<string, unknown> = JSON.parse(await readFile(lensStorePath("ws1"), "utf8"));
    assert.equal(raw["version"], 1);
  });
});

test("upsert appends a new lens and replaces one whose name already exists", async () => {
  await withTempXdg(async () => {
    await setLenses("ws1", parseLensSet([retry]));
    await upsertLens("ws1", parseLens({ name: "tests", paths: ["test/**"] }, "lens"));
    assert.deepEqual(
      (await listLenses("ws1")).map((l) => l.name),
      ["retry", "tests"],
    );
    await upsertLens("ws1", parseLens({ name: "retry", paths: ["src/**"] }, "lens"));
    const stored = await listLenses("ws1");
    assert.deepEqual(
      stored.map((l) => l.name),
      ["retry", "tests"],
      "replacing kept the position",
    );
    assert.deepEqual(stored[0]?.paths, ["src/**"]);
  });
});

test("removing reports whether anything was removed", async () => {
  await withTempXdg(async () => {
    await setLenses("ws1", parseLensSet([retry]));
    assert.equal(await removeLens("ws1", "absent"), false);
    assert.equal(await removeLens("ws1", "retry"), true);
    assert.deepEqual(await listLenses("ws1"), []);
  });
});

test("clearing an empty store reports that nothing was cleared", async () => {
  await withTempXdg(async () => {
    assert.equal(await clearLenses("ws1"), false);
    await setLenses("ws1", parseLensSet([retry]));
    assert.equal(await clearLenses("ws1"), true);
  });
});

test("a store with one good lens and one structurally-invalid entry keeps only the good one", async () => {
  await withTempXdg(async () => {
    await setLenses("ws1", parseLensSet([retry]));
    const raw: { lenses: unknown[] } = JSON.parse(await readFile(lensStorePath("ws1"), "utf8"));
    raw.lenses.push({ name: "BAD", paths: [] });
    await writeFile(lensStorePath("ws1"), JSON.stringify(raw), "utf8");
    assert.deepEqual(
      (await listLenses("ws1")).map((l) => l.name),
      ["retry"],
    );
  });
});

test("a store file that is not valid JSON fails loudly, naming the path and the fix", async () => {
  await withTempXdg(async () => {
    await setLenses("ws1", parseLensSet([retry]));
    await writeFile(lensStorePath("ws1"), "{not json", "utf8");
    await assert.rejects(listLenses("ws1"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(lensStorePath("ws1")));
      assert.match(error.message, /lens clear/);
      return true;
    });
  });
});

test("clearing a corrupt store succeeds and leaves an empty set behind", async () => {
  await withTempXdg(async () => {
    await setLenses("ws1", parseLensSet([retry]));
    await writeFile(lensStorePath("ws1"), "{not json", "utf8");
    assert.equal(await clearLenses("ws1"), true);
    assert.deepEqual(await listLenses("ws1"), []);
  });
});

test("concurrent upserts do not drop one", async () => {
  await withTempXdg(async () => {
    await Promise.all([
      upsertLens("ws1", parseLens({ name: "one", paths: ["a"] }, "lens")),
      upsertLens("ws1", parseLens({ name: "two", paths: ["b"] }, "lens")),
    ]);
    assert.deepEqual((await listLenses("ws1")).map((l) => l.name).toSorted(), ["one", "two"]);
  });
});
