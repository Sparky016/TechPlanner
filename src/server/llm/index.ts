import { getConfig } from '@/server/config';
import { registerHealthCheck } from '@/server/observability/health';
import { CopilotLlmClient } from './copilotClient';
import { FakeLlmClient, loadFakeScriptFile } from './fakeClient';
import type { LlmClient } from './types';

// Server-only: never import from src/lib or client components.

export type { LlmClient, LlmEvent, LlmRunOptions, LlmToolDefinition } from './types';
export { FakeLlmClient, type FakeScript, type FakeStep } from './fakeClient';

let instance: LlmClient | undefined;

/**
 * The process-wide LlmClient. With LLM_FAKE=1 this is a FakeLlmClient singleton that tests script via
 * `(getLlmClient() as FakeLlmClient).enqueue(...)` or, across processes, via the LLM_FAKE_SCRIPT scenario file;
 * otherwise the Copilot client, created lazily so that importing this module never starts the CLI.
 */
export function getLlmClient(): LlmClient {
  if (instance) return instance;
  const cfg = getConfig();
  if (cfg.LLM_FAKE === '1') {
    instance = new FakeLlmClient({
      models: [cfg.FACILITATOR_MODEL, cfg.EVALUATOR_MODEL],
      ...(cfg.LLM_FAKE_SCRIPT ? { defaultScript: loadFakeScriptFile(cfg.LLM_FAKE_SCRIPT) } : {}),
    });
    return instance;
  }
  const client = new CopilotLlmClient({
    gitHubToken: cfg.COPILOT_GITHUB_TOKEN,
    cliPath: cfg.COPILOT_CLI_PATH,
    requiredModels: [cfg.FACILITATOR_MODEL, cfg.EVALUATOR_MODEL],
  });
  registerHealthCheck('copilot', () => client.checkHealth());
  instance = client;
  return instance;
}

export function resetLlmClientForTests(): void {
  instance = undefined;
}
