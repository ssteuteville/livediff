/**
 * Read an SSE stream as `{event, data}` objects. Node has no EventSource, and pulling in a
 * polyfill for one long-lived connection is not worth a dependency.
 */
export interface SseEvent {
  event: string;
  data: unknown;
}

export async function* sseEvents(
  url: Parameters<typeof fetch>[0],
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const init: RequestInit = signal ? { signal } : {};
  const res = await fetch(url, init);
  if (!res.body) throw new Error("SSE response has no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: (.+)$/m.exec(frame)?.[1];
      const raw = /^data: (.+)$/m.exec(frame)?.[1];
      if (!event || !raw) continue;
      try {
        const data: unknown = JSON.parse(raw);
        yield { event, data };
      } catch {
        /* keepalive or malformed frame */
      }
    }
  }
}
