import { executeToolCall } from './toolCall';
import type { LlmClient, LlmEvent, LlmRunOptions } from './types';

// Server-only: never import from src/lib or client components.
// Deterministic LlmClient for every non-eval test (LLM_FAKE=1).

/** A scripted step. tool-call steps carry no result: the fake validates args, invokes the handler and fills it in. */
export type FakeStep =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; name: string; args: unknown }
  | Extract<LlmEvent, { type: 'done' | 'error' }>;

/** A fixed list of steps, or a function choosing steps per run (e.g. by opts.kind). */
export type FakeScript = FakeStep[] | ((opts: LlmRunOptions) => FakeStep[]);

export interface FakeLlmClientOptions {
  /** Scripts consumed in order, one per run. */
  scripts?: FakeScript[];
  /** Used when the queue is empty. */
  defaultScript?: FakeScript;
  models?: string[];
  supportsImages?: boolean;
}

const DEFAULT_SCRIPT: FakeStep[] = [{ type: 'text-delta', text: 'OK' }, { type: 'done' }];

export class FakeLlmClient implements LlmClient {
  readonly supportsImages: boolean;
  /** Every run's options, in call order, for assertions. */
  readonly calls: LlmRunOptions[] = [];
  private queue: FakeScript[];
  private defaultScript: FakeScript;
  private models: string[];

  constructor(options: FakeLlmClientOptions = {}) {
    this.queue = [...(options.scripts ?? [])];
    this.defaultScript = options.defaultScript ?? DEFAULT_SCRIPT;
    this.models = options.models ?? [];
    this.supportsImages = options.supportsImages ?? true;
  }

  /** Queues scripts for the next runs. */
  enqueue(...scripts: FakeScript[]): this {
    this.queue.push(...scripts);
    return this;
  }

  setDefaultScript(script: FakeScript): this {
    this.defaultScript = script;
    return this;
  }

  setModels(models: string[]): this {
    this.models = [...models];
    return this;
  }

  /** Clears queued scripts, recorded calls and the default script. */
  reset(): void {
    this.queue = [];
    this.calls.length = 0;
    this.defaultScript = DEFAULT_SCRIPT;
  }

  async *run(opts: LlmRunOptions): AsyncGenerator<LlmEvent> {
    this.calls.push(opts);
    const script = this.queue.shift() ?? this.defaultScript;
    const steps = typeof script === 'function' ? script(opts) : script;
    for (const step of steps) {
      if (opts.signal?.aborted) {
        yield { type: 'error', code: 'aborted', message: 'The request was cancelled', retryable: false };
        return;
      }
      if (step.type === 'tool-call') {
        const tool = opts.tools.find((t) => t.name === step.name);
        const result = tool ? (await executeToolCall(tool, step.args)).result : `Unknown tool: ${step.name}`;
        yield { type: 'tool-call', name: step.name, args: step.args, result };
        continue;
      }
      yield step;
      if (step.type === 'done' || step.type === 'error') return;
    }
    yield { type: 'done' };
  }

  async listModels(): Promise<string[]> {
    return [...this.models];
  }
}
