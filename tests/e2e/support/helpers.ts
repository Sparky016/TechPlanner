import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import { Pool } from 'pg';
import { APP_ENV, ATLASSIAN_MOCK_URL, DATABASE_URL, WEBHOOK_URL } from './env';

// Shared spec helpers: database reset, mock control, login and the workspace interactions every spec needs.

let pool: Pool | undefined;

function db(): Pool {
  pool ??= new Pool({ connectionString: DATABASE_URL, max: 2, allowExitOnIdle: true });
  return pool;
}

/** Runs SQL against the E2E database (assertions only; the app owns all writes). */
export async function sql<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await db().query<T>(text, params)).rows;
}

/** Runs an npm script against the E2E database with the app's environment; returns its stdout. */
export function runScript(script: string): string {
  return execSync(`npm run --silent ${script}`, { env: { ...process.env, ...APP_ENV }, encoding: 'utf8', stdio: 'pipe' });
}

/**
 * Destroys all data: drops and recreates schema public, then migrates (as tests/integration/setup.ts does).
 * scripts/migrate.ts runs as a child process because Playwright's loader cannot import it (import.meta).
 */
export async function resetDatabase(): Promise<void> {
  await db().query('DROP SCHEMA public CASCADE');
  await db().query('CREATE SCHEMA public');
  runScript('migrate');
}

/** Fresh database plus fresh Atlassian mock and webhook receiver state. Every spec starts here. */
export async function resetAll(request: APIRequestContext): Promise<void> {
  await resetDatabase();
  expect((await request.post(`${ATLASSIAN_MOCK_URL}/__mock/reset`)).ok()).toBe(true);
  expect((await request.post(`${WEBHOOK_URL}/__mock/reset`)).ok()).toBe(true);
}

export interface MockCall {
  method: string;
  path: string;
  query: string;
  account: string | null;
}

export interface MockIssue {
  description: { content?: unknown[] } | null;
  labels: string[];
  comments: { id: string; body: unknown }[];
  attachments: { id: string; filename: string; mimeType: string; text: string }[];
}

export interface MockState {
  calls: MockCall[];
  issues: Record<string, MockIssue>;
  pages: Record<string, { id: string; title: string; parentId: string | null; version: number; body: string }>;
}

export async function mockState(request: APIRequestContext): Promise<MockState> {
  return (await request.get(`${ATLASSIAN_MOCK_URL}/__mock/state`)).json() as Promise<MockState>;
}

/**
 * Makes the Atlassian mock answer matching requests with `status`, `times` times (default: until cleared).
 * when 'after': the request still takes effect and only the response is an error.
 */
export async function injectFault(
  request: APIRequestContext,
  fault: { method?: string; path: string; status: number; times?: number; message?: string; when?: 'before' | 'after' },
): Promise<void> {
  expect((await request.post(`${ATLASSIAN_MOCK_URL}/__mock/faults`, { data: fault })).ok()).toBe(true);
}

export async function clearFaults(request: APIRequestContext): Promise<void> {
  expect((await request.delete(`${ATLASSIAN_MOCK_URL}/__mock/faults`)).ok()).toBe(true);
}

export interface WebhookDelivery {
  signature: string | null;
  signatureValid: boolean;
  deliveryId: string | null;
  body: Record<string, unknown> | null;
}

export async function webhookDeliveries(request: APIRequestContext): Promise<WebhookDelivery[]> {
  return ((await (await request.get(`${WEBHOOK_URL}/__mock/state`)).json()) as { deliveries: WebhookDelivery[] })
    .deliveries;
}

/** Mock calls whose method matches and whose path ends with `suffix`. */
export function callsTo(state: MockState, method: string, suffix: string): MockCall[] {
  return state.calls.filter((c) => c.method === method && c.path.endsWith(suffix));
}

/** Plain text of an ADF node: text nodes joined within a block, blocks on separate lines. */
export function adfText(node: unknown): string {
  if (typeof node !== 'object' || node === null) return '';
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.type === 'text') return n.text ?? '';
  const children = n.content ?? [];
  const inline = children.every((c) => (c as { type?: string }).type === 'text');
  return children.map(adfText).join(inline ? '' : '\n');
}

/** Signs in through the mocked Atlassian OAuth flow and dismisses the first-login data notice. */
export async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Sign in with Atlassian' }).click();
  await page.waitForURL('**/sessions');
  const notice = page.getByRole('dialog', { name: 'How your data is handled' });
  await notice.getByRole('button', { name: 'I understand' }).click();
  await expect(notice).toBeHidden();
}

/** Creates a session from the New session form and waits until this tab holds the session lock. Returns its id. */
export async function createSession(page: Page, keys: string): Promise<string> {
  await page.goto('/sessions/new');
  await page.getByLabel('Jira ticket keys').fill(keys);
  await page.getByRole('button', { name: 'Create session' }).click();
  await page.waitForURL(/\/sessions\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeEnabled({ timeout: 30_000 });
  return page.url().split('/').pop() as string;
}

/** Sends a facilitator message and waits for the AI turn to finish. */
export async function sendMessage(page: Page, text: string): Promise<void> {
  await startMessage(page, text);
  await waitForTurnEnd(page);
}

export async function startMessage(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('button', { name: 'AI is responding…' })).toBeVisible();
}

export async function waitForTurnEnd(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'AI is responding…' })).toBeHidden({ timeout: 60_000 });
}

/** The Working Copy section card in the center panel. */
export function section(page: Page, name: string) {
  return page.getByRole('region', { name: 'Specification' }).getByRole('region', { name, exact: true });
}

/** The CodeMirror editor of one section. */
export function sectionEditor(page: Page, name: string) {
  return page.getByRole('textbox', { name: `${name} content`, exact: true });
}

/** Replaces a section's text in its editor and waits for the autosave to complete. */
export async function editSection(page: Page, name: string, text: string): Promise<void> {
  const editor = sectionEditor(page, name);
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(text);
  await expect(section(page, name).getByText('Saved', { exact: true })).toBeVisible({ timeout: 15_000 });
}

export function rightPanel(page: Page) {
  return page.getByRole('region', { name: 'Readiness', exact: true });
}

export function publishPanel(page: Page) {
  return page.getByRole('region', { name: 'Publish', exact: true });
}

/** A publish step row by its UI label, e.g. "Confluence page". */
export function publishStep(page: Page, label: string) {
  return publishPanel(page).getByRole('listitem').filter({ hasText: label });
}
