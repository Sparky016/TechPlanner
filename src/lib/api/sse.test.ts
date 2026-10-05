import { describe, expect, it } from 'vitest';
import { parseSse, type SseMessage } from '@/lib/api/sse';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

async function collect(chunks: string[]): Promise<SseMessage[]> {
  const out: SseMessage[] = [];
  for await (const m of parseSse(streamOf(chunks))) out.push(m);
  return out;
}

describe('parseSse', () => {
  it('parses complete frames', async () => {
    expect(await collect(['event: token\ndata: {"text":"Hi"}\n\n'])).toEqual([{ event: 'token', data: '{"text":"Hi"}' }]);
  });

  it('reassembles an event split mid-line across chunks', async () => {
    const msgs = await collect(['event: tok', 'en\ndata: {"te', 'xt":"Hello"}\n\n']);
    expect(msgs).toEqual([{ event: 'token', data: '{"text":"Hello"}' }]);
  });

  it('handles a chunk boundary between the two newlines of the terminator', async () => {
    const msgs = await collect(['event: done\ndata: {"messageSeq":3}\n', '\nevent: token\ndata: {"text":"x"}\n\n']);
    expect(msgs).toEqual([
      { event: 'done', data: '{"messageSeq":3}' },
      { event: 'token', data: '{"text":"x"}' },
    ]);
  });

  it('ignores ping comments between and before events', async () => {
    const msgs = await collect([': ping\n\n', 'event: token\ndata: {"text":"a"}\n\n: ping\n\n', 'event: token\ndata: {"text":"b"}\n\n']);
    expect(msgs.map((m) => m.data)).toEqual(['{"text":"a"}', '{"text":"b"}']);
  });

  it('parses several events in one chunk and splits byte-by-byte', async () => {
    const raw = 'event: token\ndata: {"text":"é"}\n\nevent: error\ndata: {"code":"ai_unavailable"}\n\n';
    const bytes = new TextEncoder().encode(raw);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const b of bytes) controller.enqueue(new Uint8Array([b]));
        controller.close();
      },
    });
    const out: SseMessage[] = [];
    for await (const m of parseSse(stream)) out.push(m);
    expect(out).toEqual([
      { event: 'token', data: '{"text":"é"}' },
      { event: 'error', data: '{"code":"ai_unavailable"}' },
    ]);
  });

  it('joins multiple data lines and defaults the event name', async () => {
    expect(await collect(['data: a\ndata: b\n\n'])).toEqual([{ event: 'message', data: 'a\nb' }]);
  });

  it('flushes a trailing frame without a terminator at stream end', async () => {
    expect(await collect(['event: done\ndata: {}'])).toEqual([{ event: 'done', data: '{}' }]);
  });
});
