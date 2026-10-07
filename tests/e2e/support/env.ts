import { join } from 'node:path';

// Shared E2E settings: the ports, ids and secrets the app, the worker, the mocks and the specs all agree on.
// The app talks to the Atlassian mock and webhook receiver only; nothing here is a real credential.

export const APP_PORT = 3100;
export const APP_URL = `http://localhost:${APP_PORT}`;
// Overridable so the perf run (scripts/perf/run.ts) can run its own mock beside a running E2E suite.
export const ATLASSIAN_MOCK_PORT = Number(process.env.ATLASSIAN_MOCK_PORT ?? 4010);
export const ATLASSIAN_MOCK_URL = `http://localhost:${ATLASSIAN_MOCK_PORT}`;
export const WEBHOOK_PORT = 4020;
export const WEBHOOK_URL = `http://localhost:${WEBHOOK_PORT}`;

export const CLOUD_ID = 'e2e-cloud-id';
// Site URL the mock reports in accessible-resources; only used to build links, never fetched.
export const SITE_URL = 'https://e2e-site.atlassian.net';
export const CLIENT_ID = 'e2e-client-id';
export const CLIENT_SECRET = 'e2e-client-secret';
export const WEBHOOK_SECRET = 'e2e-webhook-secret';
export const CONFLUENCE_SPACE_KEY = 'ENG';
export const CONFLUENCE_SPACE_ID = '9001';
export const CONFLUENCE_PARENT_PAGE_ID = '7000';
/** The Atlassian user every E2E login authenticates as. */
export const MOCK_USER = { accountId: 'e2e-account-1', name: 'Erin Facilitator', email: 'erin@example.com' };
/** Confluence page linked from ABC-123's description. */
export const LINKED_PAGE_ID = '5001';

// Own database: every spec's resetDatabase() drops the whole public schema.
export const DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgres://techplanner:techplanner@localhost:5432/techplanner_e2e';

/** Environment for migrate, web and worker. No .env file is read; LLM is always the scripted fake. */
export const APP_ENV: Record<string, string> = {
  ATLASSIAN_CLIENT_ID: CLIENT_ID,
  ATLASSIAN_CLIENT_SECRET: CLIENT_SECRET,
  ATLASSIAN_CLOUD_ID: CLOUD_ID,
  ATLASSIAN_AUTH_BASE_URL: ATLASSIAN_MOCK_URL,
  ATLASSIAN_API_BASE_URL: ATLASSIAN_MOCK_URL,
  OAUTH_REDIRECT_URI: `${APP_URL}/auth/callback`,
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 39).toString('base64'),
  DATABASE_URL,
  APP_BASE_URL: APP_URL,
  // FakeLlmClient never uses the token; the schema still requires one.
  COPILOT_GITHUB_TOKEN: 'e2e-unused',
  FACILITATOR_MODEL: 'e2e-facilitator-model',
  EVALUATOR_MODEL: 'e2e-evaluator-model',
  LLM_FAKE: '1',
  LLM_FAKE_SCRIPT: join(process.cwd(), 'tests', 'e2e', 'fixtures', 'llm-script.json'),
  CONFLUENCE_SPACE_KEY,
  CONFLUENCE_PARENT_PAGE_ID,
  DOWNSTREAM_WEBHOOK_URL: `${WEBHOOK_URL}/hook`,
  DOWNSTREAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
};
