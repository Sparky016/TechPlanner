import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmEvent, LlmRunOptions, LlmToolDefinition } from './types';

// The SDK is fully mocked: no CLI process and no Copilot token are needed.
const h = vi.hoisted(() => {
  type Handler = (event: unknown) => void;
  interface SessionConfig {
    tools: { name: string; handler: (args: unknown, inv?: unknown) => Promise<unknown> }[];
    onPermissionRequest: (req: unknown, inv: unknown) => unknown;
    availableTools: { toArray(): string[] };
    excludedTools: { toArray(): string[] };
    [key: string]: unknown;
  }

  class MockSession {
    readonly sessionId = `s-${Math.random()}`;
    handlers: Handler[] = [];
    sent: unknown[] = [];
    constructor(readonly config: SessionConfig) {}
    on(handler: Handler) {
      this.handlers.push(handler);
      return () => undefined;
    }
    emit(type: string, data: unknown) {
      this.handlers.forEach((fn) => fn({ type, data }));
    }
    async send(msg: unknown) {
      this.sent.push(msg);
      await state.onSend(this, msg);
      return 'msg-id';
    }
    abort = vi.fn(async () => undefined);
    disconnect = vi.fn(async () => undefined);
  }

  class MockClient {
    sessions: MockSession[] = [];
    constructor(readonly options: Record<string, unknown>) {
      state.clients.push(this);
    }
    start = vi.fn(async () => undefined);
    async createSession(config: SessionConfig) {
      const s = new MockSession(config);
      this.sessions.push(s);
      state.sessions.push(s);
      return s;
    }
    async ping() {
      if (!state.pingOk) throw new Error('Client not connected');
      return { message: 'pong', timestamp: '' };
    }
    async listModels() {
      return state.models.map((id) => ({ id, name: id }));
    }
    async getAuthStatus() {
      return { isAuthenticated: state.authenticated };
    }
    deleteSession = vi.fn(async () => undefined);
    forceStop = vi.fn(async () => undefined);
    stop = vi.fn(async () => []);
  }

  class MockToolSet {
    private items: string[] = [];
    addBuiltIn(name: string) {
      this.items.push(`builtin:${name}`);
      return this;
    }
    addCustom(name: string) {
      this.items.push(`custom:${name}`);
      return this;
    }
    addMcp(name: string) {
      this.items.push(`mcp:${name}`);
      return this;
    }
    toArray() {
      return [...this.items];
    }
  }

  const state = {
    clients: [] as MockClient[],
    sessions: [] as MockSession[],
    pingOk: true,
    authenticated: true,
    models: ['model-a', 'model-b'],
    onSend: (async () => undefined) as (s: MockSession, msg: unknown) => Promise<void>,
    MockClient,
    MockToolSet,
  };
  return state;
});

vi.mock('@github/copilot-sdk', () => ({
  CopilotClient: h.MockClient,
  ToolSet: h.MockToolSet,
  RuntimeConnection: { forStdio: (opts: unknown) => ({ kind: 'stdio', ...(opts as object) }) },
}));

const { CopilotLlmClient, MAX_RESTARTS, RESTART_WINDOW_MS, buildMessageOptions } = await import('./copilotClient');

type Session = (typeof h.sessions)[number];

function makeClient(extra: { now?: () => number } = {}) {
  const delays: number[] = [];
  const client = new CopilotLlmClient({
    gitHubToken: 'ghp_secret',
    requiredModels: ['model-a', 'model-b'],
    sleep: async (ms) => {
      delays.push(ms);
    },
    ...extra,
  });
  return { client, delays };
}

function runOpts(tools: LlmToolDefinition[] = []): LlmRunOptions {
  return {
    kind: 'facilitator',
    model: 'model-a',
    system: 'You are a planner.',
    messages: [{ role: 'user', content: 'Hello' }],
    tools,
  };
}

async function collect(it: AsyncIterable<LlmEvent>): Promise<LlmEvent[]> {
  const out: LlmEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const addTool = (handler = vi.fn(async (args: unknown) => `added ${JSON.stringify(args)}`)) => ({
  handler,
  tool: {
    name: 'add_item',
    description: 'Adds an item',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    },
    handler,
  } satisfies LlmToolDefinition,
});

beforeEach(() => {
  h.clients.length = 0;
  h.sessions.length = 0;
  h.pingOk = true;
  h.authenticated = true;
  h.models = ['model-a', 'model-b'];
  h.onSend = async (s: Session) => s.emit('session.idle', {});
});

describe('CopilotLlmClient streaming', () => {
  it('maps deltas and usage to text-delta and done events', async () => {
    h.onSend = async (s) => {
      s.emit('assistant.message_delta', { messageId: 'm1', deltaContent: 'Hel' });
      s.emit('assistant.message_delta', { messageId: 'm1', deltaContent: 'lo' });
      s.emit('assistant.message', { messageId: 'm1', content: 'Hello' });
      s.emit('assistant.usage', { model: 'model-a', inputTokens: 10, outputTokens: 2 });
      s.emit('session.idle', {});
    };
    const { client } = makeClient();
    const events = await collect(client.run(runOpts()));
    expect(events).toEqual([
      { type: 'text-delta', text: 'Hel' },
      { type: 'text-delta', text: 'lo' },
      { type: 'done', usage: { inputTokens: 10, outputTokens: 2 } },
    ]);
    const session = h.sessions[0];
    expect(session.config.streaming).toBe(true);
    expect(session.config.systemMessage).toEqual({ mode: 'replace', content: 'You are a planner.' });
    expect(session.disconnect).toHaveBeenCalled();
    expect(h.clients[0].deleteSession).toHaveBeenCalledWith(session.sessionId);
  });

  it('sends the full history in one prompt and attaches images as blobs', () => {
    const msg = buildMessageOptions([
      { role: 'user', content: 'First', images: [{ mimeType: 'image/png', base64: 'AAAA' }] },
      { role: 'assistant', content: 'Reply' },
      { role: 'user', content: 'Second' },
    ]);
    expect(msg.prompt).toContain('[user]\nFirst');
    expect(msg.prompt).toContain('[assistant]\nReply');
    expect(msg.prompt.endsWith('[user]\nSecond')).toBe(true);
    expect(msg.attachments).toEqual([
      { type: 'blob', data: 'AAAA', mimeType: 'image/png', displayName: 'message-1-image-1' },
    ]);
  });

  it('lists model ids', async () => {
    const { client } = makeClient();
    await expect(client.listModels()).resolves.toEqual(['model-a', 'model-b']);
  });
});

describe('CopilotLlmClient tool calls (LLM-5)', () => {
  it('rejects invalid arguments without calling the handler and returns the validation message to the model', async () => {
    const { tool, handler } = addTool();
    let modelSaw: unknown;
    h.onSend = async (s) => {
      modelSaw = await s.config.tools[0].handler({ title: 42 });
      s.emit('session.idle', {});
    };
    const { client } = makeClient();
    const events = await collect(client.run(runOpts([tool])));
    expect(handler).not.toHaveBeenCalled();
    expect(modelSaw).toMatchObject({ resultType: 'failure' });
    const text = (modelSaw as { textResultForLlm: string }).textResultForLlm;
    expect(text).toMatch(/^Invalid arguments: /);
    expect(text).toContain('must be string');
    expect(events[0]).toEqual({ type: 'tool-call', name: 'add_item', args: { title: 42 }, result: text });
  });

  it('invokes the handler for valid arguments and relays its result', async () => {
    const { tool, handler } = addTool();
    let modelSaw: unknown;
    h.onSend = async (s) => {
      modelSaw = await s.config.tools[0].handler({ title: 'Login' });
      s.emit('session.idle', {});
    };
    const { client } = makeClient();
    const events = await collect(client.run(runOpts([tool])));
    expect(handler).toHaveBeenCalledWith({ title: 'Login' });
    expect(modelSaw).toBe('added {"title":"Login"}');
    expect(events).toEqual([
      { type: 'tool-call', name: 'add_item', args: { title: 'Login' }, result: 'added {"title":"Login"}' },
      { type: 'done' },
    ]);
  });
});

describe('CopilotLlmClient lock-down (LLM-6)', () => {
  it('denies every permission request except the allow-listed custom tools', async () => {
    const { tool } = addTool();
    const { client } = makeClient();
    await collect(client.run(runOpts([tool])));
    const { onPermissionRequest } = h.sessions[0].config;
    const inv = { sessionId: 's' };
    const denied = [
      { kind: 'shell', fullCommandText: 'rm -rf /', commands: [] },
      { kind: 'write', fileName: '/etc/passwd', diff: '' },
      { kind: 'read', path: '/etc/passwd' },
      { kind: 'url', url: 'https://example.com' },
      { kind: 'mcp', serverName: 'github', toolName: 'list_issues' },
      { kind: 'custom-tool', toolName: 'delete_everything', toolDescription: '' },
    ];
    for (const req of denied) {
      expect(await onPermissionRequest(req, inv)).toMatchObject({ kind: 'reject' });
    }
    expect(await onPermissionRequest({ kind: 'custom-tool', toolName: 'add_item', toolDescription: '' }, inv)).toEqual({
      kind: 'approve-once',
    });
  });

  it('enables only the app tools, excludes all built-in and MCP tools, and runs in an empty temp dir', async () => {
    const { tool } = addTool();
    const { client } = makeClient();
    await collect(client.run(runOpts([tool])));
    const cfg = h.sessions[0].config;
    expect(cfg.availableTools.toArray()).toEqual(['custom:add_item']);
    expect(cfg.excludedTools.toArray()).toEqual(['builtin:*', 'mcp:*']);
    const opts = h.clients[0].options as { mode: string; workingDirectory: string; useLoggedInUser: boolean; env: Record<string, string> };
    expect(opts.mode).toBe('empty');
    expect(opts.useLoggedInUser).toBe(false);
    expect(path.basename(opts.workingDirectory)).toMatch(/^tp-llm-/);
    expect(path.dirname(opts.workingDirectory)).toBe(os.tmpdir());
    expect(cfg.workingDirectory).toBe(opts.workingDirectory);
    expect(Object.keys(opts.env)).not.toContain('COPILOT_GITHUB_TOKEN');
    expect(Object.keys(opts.env)).not.toContain('DATABASE_URL');
  });
});

describe('CopilotLlmClient retry and restart (NFR-8, LLM-9)', () => {
  it('retries a transient error twice with 1 s and 4 s backoff, then yields an error event', async () => {
    h.onSend = async (s) => s.emit('session.error', { errorType: 'rate_limit', message: 'Too many requests', statusCode: 429 });
    const { client, delays } = makeClient();
    const events = await collect(client.run(runOpts()));
    expect(h.sessions).toHaveLength(3);
    expect(delays).toEqual([1000, 4000]);
    expect(events).toEqual([{ type: 'error', code: 'rate_limited', message: 'Too many requests', retryable: true }]);
  });

  it('succeeds when a retry succeeds', async () => {
    let n = 0;
    h.onSend = async (s) => {
      if (n++ === 0) s.emit('session.error', { errorType: 'quota', message: 'quota' });
      else {
        s.emit('assistant.message_delta', { messageId: 'm', deltaContent: 'ok' });
        s.emit('session.idle', {});
      }
    };
    const { client, delays } = makeClient();
    const events = await collect(client.run(runOpts()));
    expect(delays).toEqual([1000]);
    expect(events).toEqual([{ type: 'text-delta', text: 'ok' }, { type: 'done' }]);
  });

  it('does not retry non-transient errors', async () => {
    h.onSend = async (s) => s.emit('session.error', { errorType: 'authentication', message: 'bad token' });
    const { client, delays } = makeClient();
    const events = await collect(client.run(runOpts()));
    expect(delays).toEqual([]);
    expect(events).toEqual([{ type: 'error', code: 'auth_failed', message: 'bad token', retryable: false }]);
  });

  it(`fails the copilot health check after more than ${MAX_RESTARTS} CLI restarts in 5 minutes`, async () => {
    let now = 1_000_000;
    h.onSend = async () => {
      h.pingOk = false;
      throw new Error('CLI server exited unexpectedly with code 1');
    };
    const { client } = makeClient({ now: () => now });
    const restartClient = () => {
      h.pingOk = true; // the replacement process is healthy until it crashes again
    };
    const origPush = h.clients.push.bind(h.clients);
    h.clients.push = (...c) => {
      restartClient();
      return origPush(...c);
    };
    try {
      await expect(client.checkHealth()).resolves.toEqual({ ok: true });

      // One run: initial attempt + 2 retries, each crashing -> 3 restarts.
      const first = await collect(client.run(runOpts()));
      expect(first).toEqual([{ type: 'error', code: 'cli_crashed', message: expect.any(String), retryable: true }]);
      expect(h.clients[0].forceStop).toHaveBeenCalled();

      // The fourth crash inside the window exceeds the limit.
      now += 60_000;
      const second = await collect(client.run(runOpts()));
      expect(second).toEqual([{ type: 'error', code: 'ai_unavailable', message: expect.any(String), retryable: false }]);
      await expect(client.checkHealth()).resolves.toMatchObject({ ok: false });

      // Further runs fail fast without starting a CLI.
      const clientsBefore = h.clients.length;
      expect(await collect(client.run(runOpts()))).toEqual([expect.objectContaining({ code: 'ai_unavailable' })]);
      expect(h.clients.length).toBe(clientsBefore);

      // Once the restarts age out of the window the client recovers.
      now += RESTART_WINDOW_MS;
      h.onSend = async (s) => s.emit('session.idle', {});
      await expect(client.checkHealth()).resolves.toEqual({ ok: true });
    } finally {
      h.clients.push = origPush;
    }
  });
});

describe('CopilotLlmClient health check', () => {
  it('fails when not authenticated or a configured model is missing', async () => {
    h.authenticated = false;
    const { client } = makeClient();
    await expect(client.checkHealth()).resolves.toMatchObject({ ok: false, detail: expect.stringContaining('authenticated') });
    h.authenticated = true;
    h.models = ['model-a'];
    await expect(client.checkHealth()).resolves.toEqual({ ok: false, detail: 'models unavailable: model-b' });
  });
});
