import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CopilotClient,
  RuntimeConnection,
  ToolSet,
  type CopilotSession,
  type MessageOptions,
  type PermissionHandler,
  type SessionEvent,
  type Tool,
  type ToolResultObject,
} from '@github/copilot-sdk';
import type { HealthCheckResult } from '@/server/observability/health';
import { logger } from '@/server/observability/logger';
import { countLlmError, countLlmTokens, observeLlmRequest } from '@/server/observability/metrics';
import { executeToolCall } from './toolCall';
import type { LlmClient, LlmEvent, LlmMessage, LlmRunOptions, LlmToolDefinition } from './types';

// Server-only: never import from src/lib or client components.
// The only module (with its test) that imports @github/copilot-sdk. API names: docs/adr/0015-copilot-sdk-api.md.

/** NFR-8: back-off before the first and second retry of a transient failure. */
export const RETRY_DELAYS_MS = [1000, 4000] as const;
/** LLM-9: CLI restarts allowed inside RESTART_WINDOW_MS before the client reports itself unavailable. */
export const MAX_RESTARTS = 3;
export const RESTART_WINDOW_MS = 5 * 60 * 1000;

const DEFAULT_LIVENESS_INTERVAL_MS = 15_000;
const DEFAULT_RUN_TIMEOUT_MS = 10 * 60 * 1000;
const PING_TIMEOUT_MS = 2000;

// Only what the runtime needs to start; app secrets (DATABASE_URL, Atlassian credentials, ...) are never inherited.
const RUNTIME_ENV_KEYS = [
  'PATH',
  'Path',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'SYSTEMROOT',
  'SystemRoot',
  'WINDIR',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'APPDATA',
  'LOCALAPPDATA',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
];

export interface CopilotLlmClientOptions {
  gitHubToken: string;
  cliPath?: string;
  /** Models that must be listed for the 'copilot' health check to pass (FACILITATOR_MODEL, EVALUATOR_MODEL). */
  requiredModels: string[];
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  livenessIntervalMs?: number;
  runTimeoutMs?: number;
}

interface Failure {
  code: string;
  message: string;
  retryable: boolean;
  /** The CLI process is gone; the client must be restarted. */
  crash?: boolean;
}

type QueueItem =
  | { kind: 'event'; event: Extract<LlmEvent, { type: 'text-delta' | 'tool-call' }> }
  | { kind: 'idle' }
  | { kind: 'failure'; failure: Failure };

interface AttemptResult {
  failure?: Failure;
  /** Whether text or tool calls were already yielded; such attempts are never replayed. */
  produced: boolean;
}

const CRASH_FAILURE: Failure = {
  code: 'cli_crashed',
  message: 'The Copilot CLI process exited unexpectedly',
  retryable: true,
  crash: true,
};
const UNAVAILABLE_EVENT: Extract<LlmEvent, { type: 'error' }> = {
  type: 'error',
  code: 'ai_unavailable',
  message: 'The AI service is unavailable',
  retryable: false,
};

/** Single-consumer queue bridging SDK callbacks to the run() generator. */
class Channel<T> {
  private items: T[] = [];
  private wake: (() => void) | undefined;

  push(item: T): void {
    this.items.push(item);
    this.wake?.();
    this.wake = undefined;
  }

  async next(): Promise<T> {
    while (this.items.length === 0) {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
    return this.items.shift() as T;
  }
}

/** Maps a session.error payload onto an LlmEvent error code (NFR-8: rate-limit/quota/transient are retryable). */
export function classifySessionError(data: {
  errorType: string;
  errorCode?: string;
  statusCode?: number;
  message: string;
}): Failure {
  const type = data.errorType.toLowerCase();
  const status = data.statusCode;
  if (type === 'rate_limit' || status === 429) {
    return { code: 'rate_limited', message: data.message, retryable: true };
  }
  if (type === 'quota') return { code: 'quota_exceeded', message: data.message, retryable: true };
  if (type === 'authentication' || type === 'authorization' || status === 401 || status === 403) {
    return { code: 'auth_failed', message: data.message, retryable: false };
  }
  if (type === 'context_limit') return { code: 'context_limit', message: data.message, retryable: false };
  if ((status !== undefined && status >= 500) || ['network', 'timeout', 'server_error', 'transient'].includes(type)) {
    return { code: 'transient', message: data.message, retryable: true };
  }
  return { code: 'model_error', message: data.message, retryable: false };
}

/** LLM-6: deny-by-default. Only application custom tools named in the run's allow-list are approved. */
export function createPermissionHandler(allowedToolNames: Iterable<string>): PermissionHandler {
  const allowed = new Set(allowedToolNames);
  return (request) => {
    if (request.kind === 'custom-tool' && allowed.has(request.toolName)) {
      return { kind: 'approve-once' };
    }
    logger.warn({ permissionKind: request.kind }, 'llm: denied non-allow-listed permission request');
    return { kind: 'reject', feedback: 'Only the application-provided tools are available.' };
  };
}

/**
 * LLM-4: stateless runs. The app DB is the source of truth, so every run sends the full history in one prompt.
 * Images from every message are attached as blob attachments.
 */
export function buildMessageOptions(messages: LlmMessage[]): MessageOptions {
  const last = messages.at(-1);
  const history = messages.slice(0, -1);
  const lastBlock = last ? last.content : '';
  const prompt =
    history.length === 0
      ? lastBlock
      : [
          'Conversation so far (oldest first):',
          ...history.map((m) => `[${m.role}]\n${m.content}`),
          `[${last?.role ?? 'user'}]\n${lastBlock}`,
        ].join('\n\n');
  const attachments: NonNullable<MessageOptions['attachments']> = [];
  messages.forEach((m, i) =>
    (m.images ?? []).forEach((img, j) =>
      attachments.push({
        type: 'blob',
        data: img.base64,
        mimeType: img.mimeType,
        displayName: `message-${i + 1}-image-${j + 1}`,
      }),
    ),
  );
  return attachments.length > 0 ? { prompt, attachments } : { prompt };
}

function runtimeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of RUNTIME_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

let workDirsPromise: Promise<{ cwd: string; home: string }> | undefined;

/** LLM-6: an empty temp working directory per process; no repository is ever visible to the CLI. */
function workDirs(): Promise<{ cwd: string; home: string }> {
  workDirsPromise ??= (async () => ({
    cwd: await mkdtemp(path.join(os.tmpdir(), 'tp-llm-')),
    home: await mkdtemp(path.join(os.tmpdir(), 'tp-llm-home-')),
  }))().catch((err: unknown) => {
    workDirsPromise = undefined;
    throw err;
  });
  return workDirsPromise;
}

export class CopilotLlmClient implements LlmClient {
  /** MessageOptions accepts blob attachments; per-model vision support is ModelInfo.capabilities.supports.vision. */
  readonly supportsImages = true;

  private clientPromise: Promise<CopilotClient> | undefined;
  private restarts: number[] = [];
  private exhausted = false;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly livenessIntervalMs: number;
  private readonly runTimeoutMs: number;

  constructor(private readonly options: CopilotLlmClientOptions) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.livenessIntervalMs = options.livenessIntervalMs ?? DEFAULT_LIVENESS_INTERVAL_MS;
    this.runTimeoutMs = options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  }

  async *run(opts: LlmRunOptions): AsyncGenerator<LlmEvent> {
    const startedAt = this.now();
    let retries = 0;
    try {
      for (;;) {
        if (this.isUnavailable()) {
          countLlmError(opts.kind, UNAVAILABLE_EVENT.code);
          yield UNAVAILABLE_EVENT;
          return;
        }
        const { failure, produced } = yield* this.attempt(opts);
        if (!failure) return;
        if (failure.crash) {
          this.recordCrash();
          if (this.isUnavailable()) {
            countLlmError(opts.kind, UNAVAILABLE_EVENT.code);
            yield UNAVAILABLE_EVENT;
            return;
          }
        }
        if (failure.retryable && !produced && retries < RETRY_DELAYS_MS.length && !opts.signal?.aborted) {
          const delay = RETRY_DELAYS_MS[retries];
          retries += 1;
          logger.warn({ kind: opts.kind, code: failure.code, retry: retries, delayMs: delay }, 'llm: retrying');
          await this.sleep(delay);
          continue;
        }
        countLlmError(opts.kind, failure.code);
        yield { type: 'error', code: failure.code, message: failure.message, retryable: failure.retryable };
        return;
      }
    } finally {
      observeLlmRequest(opts.kind, (this.now() - startedAt) / 1000);
    }
  }

  async listModels(): Promise<string[]> {
    const client = await this.getClient();
    return (await client.listModels()).map((m) => m.id);
  }

  /** The 'copilot' health check: CLI reachable, authenticated, required models available. */
  async checkHealth(): Promise<HealthCheckResult> {
    if (this.isUnavailable()) return { ok: false, detail: 'Copilot CLI restart limit reached' };
    const client = await this.getClient();
    const auth = await client.getAuthStatus();
    if (!auth.isAuthenticated) return { ok: false, detail: 'Copilot CLI is not authenticated' };
    const available = new Set(await this.listModels());
    const missing = this.options.requiredModels.filter((m) => !available.has(m));
    if (missing.length > 0) return { ok: false, detail: `models unavailable: ${missing.join(', ')}` };
    return { ok: true };
  }

  /** Releases the CLI process (worker/server shutdown). */
  async stop(): Promise<void> {
    const pending = this.clientPromise;
    this.clientPromise = undefined;
    if (pending) await (await pending.catch(() => undefined))?.stop();
  }

  private async *attempt(opts: LlmRunOptions): AsyncGenerator<LlmEvent, AttemptResult> {
    if (opts.signal?.aborted) {
      return { failure: { code: 'aborted', message: 'The request was cancelled', retryable: false }, produced: false };
    }
    const channel = new Channel<QueueItem>();
    const usage = { inputTokens: 0, outputTokens: 0, seen: false };
    const streamedMessageIds = new Set<string>();
    let produced = false;
    let client: CopilotClient | undefined;
    let session: CopilotSession | undefined;
    let aborted = false;
    const timers: NodeJS.Timeout[] = [];
    const onAbort = () => {
      aborted = true;
      channel.push({ kind: 'failure', failure: { code: 'aborted', message: 'The request was cancelled', retryable: false } });
    };

    try {
      client = await this.getClient();
      const liveClient = client;
      logger.debug({ kind: opts.kind, model: opts.model, messages: opts.messages.length, tools: opts.tools.map((t) => t.name) }, 'llm: run');
      session = await client.createSession({
        model: opts.model,
        streaming: true,
        // The app owns the whole system prompt; built-in tools are disabled so the runtime's coding-agent prompt does not apply.
        systemMessage: { mode: 'replace', content: opts.system },
        tools: opts.tools.map((t) => this.toSdkTool(t, channel)),
        availableTools: opts.tools.reduce((set, t) => set.addCustom(t.name), new ToolSet()),
        excludedTools: new ToolSet().addBuiltIn('*').addMcp('*'),
        onPermissionRequest: createPermissionHandler(opts.tools.map((t) => t.name)),
        workingDirectory: (await workDirs()).cwd,
        infiniteSessions: { enabled: false },
      });
      session.on((event) => this.onSessionEvent(event, channel, usage, streamedMessageIds));
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      await session.send(buildMessageOptions(opts.messages));

      timers.push(
        setInterval(() => {
          void this.isCrashed(liveClient).then((crashed) => {
            if (crashed) channel.push({ kind: 'failure', failure: CRASH_FAILURE });
          });
        }, this.livenessIntervalMs),
        setTimeout(
          () => channel.push({ kind: 'failure', failure: { code: 'timeout', message: 'The model did not finish in time', retryable: false } }),
          this.runTimeoutMs,
        ),
      );

      for (;;) {
        const item = await channel.next();
        if (item.kind === 'event') {
          produced = true;
          yield item.event;
        } else if (item.kind === 'idle') {
          if (usage.seen) {
            countLlmTokens(opts.kind, 'input', usage.inputTokens);
            countLlmTokens(opts.kind, 'output', usage.outputTokens);
            yield { type: 'done', usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } };
          } else {
            yield { type: 'done' };
          }
          return { produced };
        } else {
          return { failure: item.failure, produced };
        }
      }
    } catch (err) {
      if (aborted) return { failure: { code: 'aborted', message: 'The request was cancelled', retryable: false }, produced };
      const crashed = await this.isCrashed(client);
      logger.warn({ kind: opts.kind, crashed, err: err instanceof Error ? err.message : String(err) }, 'llm: run failed');
      return {
        failure: crashed ? CRASH_FAILURE : { code: 'llm_error', message: 'The AI request failed', retryable: false },
        produced,
      };
    } finally {
      timers.forEach((t) => clearTimeout(t));
      opts.signal?.removeEventListener('abort', onAbort);
      if (session) {
        const s = session;
        if (aborted) await s.abort().catch(() => undefined);
        await s.disconnect().catch(() => undefined);
        // Stateless runs: drop on-disk session state so the temp home does not grow without bound.
        await client?.deleteSession(s.sessionId).catch(() => undefined);
      }
    }
  }

  private toSdkTool(tool: LlmToolDefinition, channel: Channel<QueueItem>): Tool {
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
      skipPermission: false,
      handler: async (args): Promise<string | ToolResultObject> => {
        const outcome = await executeToolCall(tool, args);
        channel.push({ kind: 'event', event: { type: 'tool-call', name: tool.name, args, result: outcome.result } });
        // A failure result keeps the agent loop running so the model can read the message and retry (LLM-5).
        return outcome.ok ? outcome.result : { textResultForLlm: outcome.result, resultType: 'failure' };
      },
    };
  }

  private onSessionEvent(
    event: SessionEvent,
    channel: Channel<QueueItem>,
    usage: { inputTokens: number; outputTokens: number; seen: boolean },
    streamedMessageIds: Set<string>,
  ): void {
    if (event.agentId) return; // sub-agent traffic; only the root agent's output is relayed
    switch (event.type) {
      case 'assistant.message_delta':
        streamedMessageIds.add(event.data.messageId);
        if (event.data.deltaContent) {
          channel.push({ kind: 'event', event: { type: 'text-delta', text: event.data.deltaContent } });
        }
        break;
      case 'assistant.message':
        // Fallback for models that do not stream: relay the whole message once.
        if (!streamedMessageIds.has(event.data.messageId) && event.data.content) {
          channel.push({ kind: 'event', event: { type: 'text-delta', text: event.data.content } });
        }
        break;
      case 'assistant.usage':
        usage.seen = true;
        usage.inputTokens += event.data.inputTokens ?? 0;
        usage.outputTokens += event.data.outputTokens ?? 0;
        break;
      case 'session.idle':
        channel.push({ kind: 'idle' });
        break;
      case 'session.error':
        channel.push({ kind: 'failure', failure: classifySessionError(event.data) });
        break;
      case 'model.call_failure':
        // Intermediate; the runtime reports terminal failures via session.error.
        logger.debug({ errorType: event.data.errorType, errorCode: event.data.errorCode }, 'llm: model call failure');
        break;
      default:
        break;
    }
  }

  private getClient(): Promise<CopilotClient> {
    this.clientPromise ??= this.startClient().catch((err: unknown) => {
      this.clientPromise = undefined;
      throw err;
    });
    return this.clientPromise;
  }

  private async startClient(): Promise<CopilotClient> {
    const dirs = await workDirs();
    const client = new CopilotClient({
      // 'empty': no ambient config, skills, plugins, instructions or session store; every session must declare its tools.
      mode: 'empty',
      connection: RuntimeConnection.forStdio(this.options.cliPath ? { path: this.options.cliPath } : {}),
      workingDirectory: dirs.cwd,
      baseDirectory: dirs.home,
      gitHubToken: this.options.gitHubToken,
      useLoggedInUser: false,
      env: runtimeEnv(),
      logLevel: 'error',
    });
    await client.start();
    logger.info('llm: copilot cli started');
    return client;
  }

  private async isCrashed(client: CopilotClient | undefined): Promise<boolean> {
    if (!client) return true; // the CLI could not be started
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        client.ping(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('ping timeout')), PING_TIMEOUT_MS);
        }),
      ]);
      return false;
    } catch {
      return true;
    } finally {
      clearTimeout(timer);
    }
  }

  /** LLM-9: discard the dead CLI so the next call restarts it, unless MAX_RESTARTS already happened in the window. */
  private recordCrash(): void {
    const dead = this.clientPromise;
    this.clientPromise = undefined;
    void dead?.then((c) => c.forceStop()).catch(() => undefined);
    this.pruneRestarts();
    if (this.restarts.length >= MAX_RESTARTS) {
      this.exhausted = true;
      logger.error({ restarts: this.restarts.length }, 'llm: copilot cli restart limit reached');
      return;
    }
    this.restarts.push(this.now());
    logger.warn({ restarts: this.restarts.length }, 'llm: copilot cli exited; restarting');
  }

  private pruneRestarts(): void {
    const cutoff = this.now() - RESTART_WINDOW_MS;
    this.restarts = this.restarts.filter((t) => t > cutoff);
  }

  /** Sliding window: becomes available again once the oldest restart leaves the 5-minute window. */
  private isUnavailable(): boolean {
    if (!this.exhausted) return false;
    this.pruneRestarts();
    if (this.restarts.length < MAX_RESTARTS) this.exhausted = false;
    return this.exhausted;
  }
}
