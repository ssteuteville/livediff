import { test } from "vitest";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { sseEvents } from "../server/sse.js";
import { SSE_HEARTBEAT_MS } from "../server/constants.js";

async function serving(body: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("keepalive comment frames are skipped without dropping real events", async () => {
  const { url, close } = await serving(
    ':\n\nevent: diff\ndata: {"ws":"abcd1234"}\n\n:\n\nevent: review\ndata: {"state":"done"}\n\n',
  );
  const ac = new AbortController();
  const seen: string[] = [];
  try {
    for await (const { event } of sseEvents(url, ac.signal)) {
      seen.push(event);
      if (seen.length === 2) break;
    }
  } finally {
    ac.abort();
    await close();
  }
  assert.deepEqual(seen, ["diff", "review"]);
});

test("the heartbeat outpaces undici's 300s body-inactivity timeout", () => {
  assert.ok(
    SSE_HEARTBEAT_MS < 300_000,
    `a hub silent for 300s makes fetch() abort an idle \`livediff --wait\`; got ${SSE_HEARTBEAT_MS}ms`,
  );
});
