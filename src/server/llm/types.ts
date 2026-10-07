import type { JSONSchema7 } from 'json-schema';

// Server-only: never import from src/lib or client components.
// The only path to a model. Tasks 23/24 depend on these shapes verbatim.

export interface LlmToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema7;
  /** Returns a short result message to the model. */
  handler: (args: unknown) => Promise<string>;
}

export interface LlmImage {
  mimeType: string;
  base64: string;
}

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
  images?: LlmImage[];
}

export interface LlmRunOptions {
  kind: 'facilitator' | 'evaluator';
  model: string;
  system: string;
  messages: LlmMessage[];
  tools: LlmToolDefinition[];
  signal?: AbortSignal;
}

export type LlmEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; name: string; args: unknown; result: string }
  | { type: 'done'; usage?: { inputTokens?: number; outputTokens?: number } }
  | { type: 'error'; code: string; message: string; retryable: boolean };

export interface LlmClient {
  run(opts: LlmRunOptions): AsyncIterable<LlmEvent>;
  listModels(): Promise<string[]>;
  readonly supportsImages: boolean;
}
