// Server-only: never import from src/lib or client components.

export const JOB_NAMES = {
  readinessEvaluate: 'readiness.evaluate',
  publishRun: 'publish.run',
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];
