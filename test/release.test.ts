import assert from "node:assert/strict";
import { test } from "vitest";
import { distTagFor, redactArgs } from "../scripts/release.js";

test("prereleases publish under next so they never become latest", () => {
  assert.equal(distTagFor("0.12.0-rc.1"), "next");
  assert.equal(distTagFor("0.12.0"), null);
});

test("redactArgs replaces the value after --otp with a placeholder", () => {
  const args = ["publish", "/tmp/livediff-0.11.2.tgz", "--otp", "123456"];
  assert.deepEqual(redactArgs(args), ["publish", "/tmp/livediff-0.11.2.tgz", "--otp", "***"]);
});

test("redactArgs leaves args without --otp untouched", () => {
  const args = ["publish", "/tmp/livediff-0.11.2.tgz"];
  assert.deepEqual(redactArgs(args), args);
});

test("redactArgs does not redact --otp itself, only the value that follows it", () => {
  const args = ["--otp", "111111", "--otp", "222222"];
  assert.deepEqual(redactArgs(args), ["--otp", "***", "--otp", "***"]);
});
