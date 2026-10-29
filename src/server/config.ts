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

// Origin-style base URL without a trailing slash (tests point these at a local mock).
const baseUrl = (fallback: string) =>
  z.preprocess(emptyToUndefined, z.string().url().default(fallback)).transform((s) => s.replace(/\/+$/, ''));

const encryptionKey = z.string().refine((s) => {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return false;
  return Buffer.from(s, 'base64').length === 32;
}, 'must be base64 decoding to exactly 32 bytes');

// mysql://user:password@host:port/database (docs/specs/mysql-migration.md §3).
const mysqlUrl = z.string().url().refine((s) => s.startsWith('mysql://'), 'must be a mysql:// URL');

// A MySQL account as GRANT takes it: 'user'@'host'. Substituted verbatim into migrations, hence the strict pattern.
const mysqlAccount = z.string().regex(/^'[A-Za-z0-9_.-]{1,32}'@'[A-Za-z0-9_.%:/-]{1,255}'$/, "must be 'user'@'host'");

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
    // Overrides for the Atlassian hosts; unset means the real auth.atlassian.com / api.atlassian.com.
    ATLASSIAN_AUTH_BASE_URL: baseUrl('https://auth.atlassian.com'),
    ATLASSIAN_API_BASE_URL: baseUrl('https://api.atlassian.com'),
    OAUTH_REDIRECT_URI: z.string().url(),
    TOKEN_ENCRYPTION_KEY: encryptionKey,
    // The app user (DML only). Migrations connect as the owner when MIGRATE_DATABASE_URL is set (§11a).
    DATABASE_URL: mysqlUrl,
    MIGRATE_DATABASE_URL: optional(mysqlUrl),
    // Pooled connections per process (web and worker each have one pool), and how long a request waits for a free
    // one before failing with 503. A streamed facilitator turn holds a connection for its whole duration.
    DB_POOL_SIZE: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(20)),
    DB_POOL_ACQUIRE_TIMEOUT_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(5000)),
    // Grantee of the per-table grants in db/migrations; production narrows the host to the bridge subnet.
    APP_DB_USER: z.preprocess(emptyToUndefined, mysqlAccount.default("'techplanner_app'@'%'")),
    COPILOT_GITHUB_TOKEN: required,
    COPILOT_CLI_PATH: optional(z.string().min(1)),
    FACILITATOR_MODEL: required,
    EVALUATOR_MODEL: required,
    // '1' swaps the Copilot client for FakeLlmClient (tests only).
    LLM_FAKE: optional(z.enum(['0', '1'])),
    // With LLM_FAKE=1: path to a JSON scenario file scripting the fake (tests/e2e/fixtures/llm-script.json).
    LLM_FAKE_SCRIPT: optional(z.string().min(1)),
    CONTEXT_TOKEN_BUDGET: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(150000)),
    CONFLUENCE_SPACE_KEY: required,
    CONFLUENCE_PARENT_PAGE_ID: required,
    CONFLUENCE_PROJECT_OVERRIDES: optional(jsonString(projectOverrides)),
    DOWNSTREAM_WEBHOOK_URL: optional(z.string().url()),
    DOWNSTREAM_WEBHOOK_SECRET: optional(z.string().min(1)),
    SECTION_WEIGHTS: optional(jsonString(sectionWeights)),
    APP_BASE_URL: z.string().url(),
    METRICS_TOKEN: optional(z.string().min(1)),
    // Optional Azure DevOps code investigation; the three below go together. The PAT needs Code (Read) only.
    AZURE_DEVOPS_ORG_URL: optional(z.string().url().transform((s) => s.replace(/\/+$/, ''))),
    AZURE_DEVOPS_PROJECT: optional(z.string().min(1)),
    AZURE_DEVOPS_PAT: optional(z.string().min(1)),
    // Optional comma-separated allow-list of repository names; unset means every repository in the project.
    AZURE_DEVOPS_REPOSITORIES: optional(
      z.string().transform((s) => s.split(',').map((r) => r.trim()).filter((r) => r !== '')),
    ),
    // Optional Code Search host override; unset derives it from AZURE_DEVOPS_ORG_URL.
    AZURE_DEVOPS_SEARCH_URL: optional(z.string().url().transform((s) => s.replace(/\/+$/, ''))),
  })
  .superRefine((env, ctx) => {
    if (env.DOWNSTREAM_WEBHOOK_URL && !env.DOWNSTREAM_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['DOWNSTREAM_WEBHOOK_SECRET'],
        message: 'required when DOWNSTREAM_WEBHOOK_URL is set',
      });
    }
    const ado = ['AZURE_DEVOPS_ORG_URL', 'AZURE_DEVOPS_PROJECT', 'AZURE_DEVOPS_PAT'] as const;
    if (ado.some((k) => env[k] !== undefined)) {
      for (const k of ado) {
        if (env[k] === undefined) {
          ctx.addIssue({ code: 'custom', path: [k], message: 'required when Azure DevOps is configured' });
        }
      }
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
