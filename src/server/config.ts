import { z } from 'zod';

// Server-only: never import from src/lib or client components.

// Empty strings (as in .env.example) are treated as unset.
const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);
const optional = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(emptyToUndefined, schema.optional());
const required = z.string().min(1);

const jsonString = <T extends z.ZodTypeAny>(schema: T) =>
  z.string().transform((s, ctx) => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'invalid JSON' });
      return z.NEVER;
    }
  }).pipe(schema);

const encryptionKey = z.string().refine((s) => {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return false;
  return Buffer.from(s, 'base64').length === 32;
}, 'must be base64 decoding to exactly 32 bytes');

const projectOverrides = z.record(
  z.string(),
  z.object({ spaceKey: z.string().min(1), parentPageId: z.string().min(1) }),
);
const sectionWeights = z.record(z.string(), z.number().positive());

const envSchema = z
  .object({
    ATLASSIAN_CLIENT_ID: required,
    ATLASSIAN_CLIENT_SECRET: required,
    ATLASSIAN_CLOUD_ID: required,
    OAUTH_REDIRECT_URI: z.string().url(),
    TOKEN_ENCRYPTION_KEY: encryptionKey,
    DATABASE_URL: z.string().url(),
    COPILOT_GITHUB_TOKEN: required,
    COPILOT_CLI_PATH: optional(z.string().min(1)),
    FACILITATOR_MODEL: required,
    EVALUATOR_MODEL: required,
    // '1' swaps the Copilot client for FakeLlmClient (tests only).
    LLM_FAKE: optional(z.enum(['0', '1'])),
    CONTEXT_TOKEN_BUDGET: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(150000)),
    CONFLUENCE_SPACE_KEY: required,
    CONFLUENCE_PARENT_PAGE_ID: required,
    CONFLUENCE_PROJECT_OVERRIDES: optional(jsonString(projectOverrides)),
    DOWNSTREAM_WEBHOOK_URL: optional(z.string().url()),
    DOWNSTREAM_WEBHOOK_SECRET: optional(z.string().min(1)),
    SECTION_WEIGHTS: optional(jsonString(sectionWeights)),
    APP_BASE_URL: z.string().url(),
    METRICS_TOKEN: optional(z.string().min(1)),
  })
  .superRefine((env, ctx) => {
    if (env.DOWNSTREAM_WEBHOOK_URL && !env.DOWNSTREAM_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['DOWNSTREAM_WEBHOOK_SECRET'],
        message: 'required when DOWNSTREAM_WEBHOOK_URL is set',
      });
    }
  });

export type AppConfig = z.infer<typeof envSchema>;

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (cached) return cached;
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    // Names only, never values or zod messages that might echo input.
    const names = [...new Set(result.error.issues.map((i) => String(i.path[0] ?? 'environment')))];
    throw new Error(`Invalid configuration: ${names.join(', ')}`);
  }
  cached = result.data;
  return cached;
}

export function resetConfigForTests(): void {
  cached = undefined;
}
