import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { withTempXdg } from "./helpers.js";
import { writeJsonAtomic } from "../server/atomic.js";

test("writes JSON and creates missing parent directories", async () => {
  await withTempXdg(async ({ root }) => {
    const file = join(root, "nested", "deeper", "data.json");
    await writeJsonAtomic(file, { hello: "world" });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { hello: "world" });
  });
});

test("leaves no temp files behind", async () => {
  await withTempXdg(async ({ root }) => {
    const dir = join(root, "writes");
    const file = join(dir, "data.json");
    await writeJsonAtomic(file, { a: 1 });
    await writeJsonAtomic(file, { a: 2 });
    assert.deepEqual(await readdir(dir), ["data.json"]);
  });
});

test("overwrites an existing file completely, not partially", async () => {
  await withTempXdg(async ({ root }) => {
    const file = join(root, "data.json");
    await writeJsonAtomic(file, { padding: "x".repeat(5000) });
    await writeJsonAtomic(file, { small: true });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { small: true });
  });
});
