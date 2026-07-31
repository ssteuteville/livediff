import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { withTempXdg } from "./helpers.js";
import { registryPath, readRegistry } from "../server/registry.js";

test("registryPath follows XDG_CONFIG_HOME set after import", async () => {
  await withTempXdg(async ({ config }) => {
    assert.equal(registryPath(), join(config, "livediff", "workspaces.json"));
  });
});

test("readRegistry returns an empty list when no registry exists", async () => {
  await withTempXdg(async () => {
    assert.deepEqual(await readRegistry(), []);
  });
});
