import { apiFetchResponse } from '@/lib/api/client';

// Browser-side Server-Sent Events reader for fetch() streams (the server side is src/server/http/sse.ts).
// Frames are `event: <type>\ndata: <json>\n\n`; lines starting with ':' (the `: ping` heartbeat) are comments.

export interface SseMessage {
  event: string;
  data: string;
}

function parseFrame(frame: string): SseMessage | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  // A frame with no data (e.g. only comments) dispatches nothing, per the SSE spec.
  if (data.length === 0) return null;
  return { event, data: data.join('\n') };
}

/** Parses an SSE byte stream into messages, buffering across chunk boundaries. */
export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n?/g, '\n');
      let end = buffer.indexOf('\n\n');
      while (end !== -1) {
        const msg = parseFrame(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (msg) yield msg;
        end = buffer.indexOf('\n\n');
      }
      if (done) break;
    }
    const tail = parseFrame(buffer);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

/** Facilitator turn events as sent by POST /api/sessions/:id/messages (FacilitatorEvent, task 23). */
export type TurnEvent =
  | { type: 'token'; text: string }
  | { type: 'patch'; section: string; version: number }
  | { type: 'suggestion'; suggestionId: string; section: string }
  | { type: 'question'; questionId: string; text: string; section: string | null }
  | { type: 'done'; messageSeq: number }
  | { type: 'error'; code: string; message: string; correlationId?: string };

const TURN_EVENTS = new Set(['token', 'patch', 'suggestion', 'question', 'done', 'error']);

/**
 * Sends a facilitator message and yields the streamed turn events. Request failures before the stream starts
 * (409 turn_in_progress, 423 session_locked, ...) throw ApiError.
 */
export async function* streamMessage(sessionId: string, text: string, signal?: AbortSignal): AsyncGenerator<TurnEvent> {
  const res = await apiFetchResponse(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST',
    json: { text },
    signal,
  });
  if (!res.body) return;
  for await (const msg of parseSse(res.body)) {
    if (!TURN_EVENTS.has(msg.event)) continue;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(msg.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    yield { ...data, type: msg.event } as TurnEvent;
  }
}
