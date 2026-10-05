import { logger } from '@/server/observability/logger';

// Server-only: never import from src/lib or client components.
// Server-Sent Events response (§7.3). Frames are `event: <type>\ndata: <json>\n\n`, with a `: ping` heartbeat
// comment every 15 s so proxies keep the connection open.

export const SSE_HEARTBEAT_MS = 15_000;

export interface SseEvent {
  event: string;
  data: unknown;
}

export interface SseOptions {
  /** Aborts on client disconnect (request.signal). */
  signal?: AbortSignal;
}

const encoder = new TextEncoder();

export function formatSseEvent(e: SseEvent): string {
  return `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;
}

/**
 * Streams `source` as text/event-stream. Iteration starts as soon as the Response is created (so a source's
 * `finally` always runs, even if the client never reads). After a disconnect the source is still drained to
 * completion, discarding output, so its cleanup and persistence finish; sources should honour the same signal
 * to wind down promptly.
 */
export function sseResponse(source: AsyncIterable<SseEvent>, opts: SseOptions = {}): Response {
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const close = (): void => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed or cancelled
        }
      };
      const onAbort = (): void => close();
      if (opts.signal?.aborted) closed = true;
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      heartbeat = setInterval(() => write(': ping\n\n'), SSE_HEARTBEAT_MS);

      void (async () => {
        try {
          for await (const e of source) write(formatSseEvent(e));
        } catch (err) {
          logger.error({ err }, 'SSE source failed');
        } finally {
          clearInterval(heartbeat);
          opts.signal?.removeEventListener('abort', onAbort);
          close();
        }
      })();
    },
    cancel() {
      closed = true;
      clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
}
