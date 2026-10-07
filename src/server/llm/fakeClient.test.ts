import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTests } from '@/server/config';
import { FakeLlmClient } from './fakeClient';
import { getLlmClient, resetLlmClientForTests } from './index';
import type { LlmEvent, LlmRunOptions, LlmToolDefinition } from './types';

async function collect(it: AsyncIterable<LlmEvent>): Promise<LlmEvent[]> {
  const out: LlmEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function makeTool(handler = vi.fn(async (args: unknown) => `saved ${(args as { title: string }).title}`)) {
  const tool: LlmToolDefinition = {
    name: 'save_section',
    description: 'Saves a section',
    parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    handler,
  };
  return { tool, handler };
}

function opts(tools: LlmToolDefinition[], kind: LlmRunOptions['kind'] = 'facilitator'): LlmRunOptions {
  return { kind, model: 'model-a', system: 'sys', messages: [{ role: 'user', content: 'hi' }], tools };
}

describe('FakeLlmClient', () => {
  it('replays scripted text-delta and tool-call events and invokes tool handlers', async () => {
    const { tool, handler } = makeTool();
    const fake = new FakeLlmClient({
      scripts: [
        [
          { type: 'text-delta', text: 'Working' },
          { type: 'tool-call', name: 'save_section', args: { title: 'Scope' } },
          { type: 'text-delta', text: ' done' },
          { type: 'done', usage: { inputTokens: 3, outputTokens: 4 } },
        ],
      ],
    });
    const events = await collect(fake.run(opts([tool])));
    expect(handler).toHaveBeenCalledWith({ title: 'Scope' });
    expect(events).toEqual([
      { type: 'text-delta', text: 'Working' },
      { type: 'tool-call', name: 'save_section', args: { title: 'Scope' }, result: 'saved Scope' },
      { type: 'text-delta', text: ' done' },
      { type: 'done', usage: { inputTokens: 3, outputTokens: 4 } },
    ]);
    expect(fake.calls).toHaveLength(1);
  });

  it('validates tool arguments like the real client', async () => {
    const { tool, handler } = makeTool();
    const fake = new FakeLlmClient().enqueue([{ type: 'tool-call', name: 'save_section', args: {} }]);
    const events = await collect(fake.run(opts([tool])));
    expect(handler).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({ type: 'tool-call', result: expect.stringMatching(/^Invalid arguments: /) });
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('reports unknown tools, consumes scripts in order, supports per-run functions and a default', async () => {
    const fake = new FakeLlmClient()
      .enqueue([{ type: 'tool-call', name: 'nope', args: {} }])
      .enqueue((o) => [{ type: 'text-delta', text: o.kind }])
      .setDefaultScript([{ type: 'error', code: 'rate_limited', message: 'x', retryable: true }]);
    expect(await collect(fake.run(opts([])))).toEqual([
      { type: 'tool-call', name: 'nope', args: {}, result: 'Unknown tool: nope' },
      { type: 'done' },
    ]);
    expect(await collect(fake.run(opts([], 'evaluator')))).toEqual([
      { type: 'text-delta', text: 'evaluator' },
      { type: 'done' },
    ]);
    expect(await collect(fake.run(opts([])))).toEqual([
      { type: 'error', code: 'rate_limited', message: 'x', retryable: true },
    ]);
  });

  it('stops with an aborted error when the signal is aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const fake = new FakeLlmClient();
    expect(await collect(fake.run({ ...opts([]), signal: ctrl.signal }))).toEqual([
      { type: 'error', code: 'aborted', message: expect.any(String), retryable: false },
    ]);
  });
});

describe('getLlmClient', () => {
  const original = process.env;

  afterEach(() => {
    process.env = original;
    resetConfigForTests();
    resetLlmClientForTests();
  });

  it('returns a FakeLlmClient singleton when LLM_FAKE=1', async () => {
    process.env = {
      ATLASSIAN_CLIENT_ID: 'id',
      ATLASSIAN_CLIENT_SECRET: 'secret',
      ATLASSIAN_CLOUD_ID: 'cloud',
      OAUTH_REDIRECT_URI: 'http://localhost:3000/api/auth/callback',
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      COPILOT_GITHUB_TOKEN: 'ghp_x',
      FACILITATOR_MODEL: 'model-a',
      EVALUATOR_MODEL: 'model-b',
      CONFLUENCE_SPACE_KEY: 'ENG',
      CONFLUENCE_PARENT_PAGE_ID: '1',
      APP_BASE_URL: 'http://localhost:3000',
      LLM_FAKE: '1',
    } as unknown as NodeJS.ProcessEnv;
    resetConfigForTests();
    const client = getLlmClient();
    expect(client).toBeInstanceOf(FakeLlmClient);
    expect(getLlmClient()).toBe(client);
    await expect(client.listModels()).resolves.toEqual(['model-a', 'model-b']);
  });
});
