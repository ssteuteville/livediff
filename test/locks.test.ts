import { test } from "vitest";
import assert from "node:assert/strict";
import { withLock, lockCount } from "../server/locks.js";

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

test("two writers on one key do not interleave their read-modify-write", async () => {
  let shared = 0;
  const bump = async (): Promise<void> => {
    const read = shared;
    await tick(); // the window a bare async handler leaves open
    shared = read + 1;
  };
  await Promise.all([withLock("ws", bump), withLock("ws", bump)]);
  assert.equal(shared, 2);
});

test("writers on different keys are not serialized against each other", async () => {
  const order: string[] = [];
  const slow = async (): Promise<void> => {
    await tick();
    await tick();
    order.push("slow");
  };
  const fast = async (): Promise<void> => {
    order.push("fast");
  };
  await Promise.all([withLock("a", slow), withLock("b", fast)]);
  assert.deepEqual(order, ["fast", "slow"]);
});

test("a rejecting task does not poison the key for later writers", async () => {
  await assert.rejects(
    withLock("ws", () => Promise.reject(new Error("boom"))),
    /boom/,
  );
  assert.equal(await withLock("ws", () => Promise.resolve("ok")), "ok");
});

test("the caller of a rejecting task still sees its rejection", async () => {
  const first = withLock("ws", () => Promise.reject(new Error("mine")));
  const second = withLock("ws", () => Promise.resolve("fine"));
  await assert.rejects(first, /mine/);
  assert.equal(await second, "fine");
});

test("keys are released once their chain drains, so the map cannot grow without bound", async () => {
  await withLock("a", () => Promise.resolve());
  await withLock("b", () => Promise.resolve());
  await tick();
  assert.equal(lockCount(), 0);
});
