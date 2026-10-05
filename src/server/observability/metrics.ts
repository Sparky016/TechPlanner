import { Counter, Histogram, Registry } from 'prom-client';

// Server-only: never import from src/lib or client components.

export const registry = new Registry();

const SECONDS_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];
const SCORE_BUCKETS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['route', 'method', 'status'] as const,
  buckets: SECONDS_BUCKETS,
  registers: [registry],
});

export const llmRequestDuration = new Histogram({
  name: 'llm_request_duration_seconds',
  help: 'LLM request duration in seconds',
  labelNames: ['kind'] as const,
  buckets: SECONDS_BUCKETS,
  registers: [registry],
});

export const llmTokens = new Counter({
  name: 'llm_tokens_total',
  help: 'LLM tokens consumed',
  labelNames: ['kind', 'direction'] as const,
  registers: [registry],
});

export const llmErrors = new Counter({
  name: 'llm_errors_total',
  help: 'LLM request errors',
  labelNames: ['kind', 'code'] as const,
  registers: [registry],
});

export const atlassianApiErrors = new Counter({
  name: 'atlassian_api_errors_total',
  help: 'Atlassian API errors',
  labelNames: ['product', 'status'] as const,
  registers: [registry],
});

export const publishStepFailures = new Counter({
  name: 'publish_step_failures_total',
  help: 'Publish step failures',
  labelNames: ['step'] as const,
  registers: [registry],
});

export const readinessScore = new Histogram({
  name: 'readiness_score',
  help: 'Observed readiness scores',
  buckets: SCORE_BUCKETS,
  registers: [registry],
});

// Success-metric instrumentation (SPEC_DOC section 11); observed by tasks 27 and 29.
export const publishTotal = new Counter({
  name: 'publish_total',
  help: 'Publishes, by project and whether the readiness gate was overridden',
  labelNames: ['project', 'override'] as const,
  registers: [registry],
});

export const readinessScoreAtPublish = new Histogram({
  name: 'readiness_score_at_publish',
  help: 'Readiness score at the moment of publish',
  buckets: SCORE_BUCKETS,
  registers: [registry],
});

export const confluenceExternalEditTotal = new Counter({
  name: 'confluence_external_edit_total',
  help: 'External edits detected on published Confluence pages',
  labelNames: ['project'] as const,
  registers: [registry],
});

export function observeHttpRequest(route: string, method: string, status: number, seconds: number): void {
  httpRequestDuration.observe({ route, method, status: String(status) }, seconds);
}

export function observeLlmRequest(kind: string, seconds: number): void {
  llmRequestDuration.observe({ kind }, seconds);
}

export function countLlmTokens(kind: string, direction: 'input' | 'output', tokens: number): void {
  llmTokens.inc({ kind, direction }, tokens);
}

export function countLlmError(kind: string, code: string): void {
  llmErrors.inc({ kind, code });
}

export function countAtlassianApiError(product: string, status: number | string): void {
  atlassianApiErrors.inc({ product, status: String(status) });
}

export function countPublishStepFailure(step: string): void {
  publishStepFailures.inc({ step });
}

export function observeReadinessScore(score: number): void {
  readinessScore.observe(score);
}

export function countPublish(project: string, override: boolean): void {
  publishTotal.inc({ project, override: String(override) });
}

export function observeReadinessScoreAtPublish(score: number): void {
  readinessScoreAtPublish.observe(score);
}

export function countConfluenceExternalEdit(project: string): void {
  confluenceExternalEditTotal.inc({ project });
}
