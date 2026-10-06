import { expect, test } from '@playwright/test';
import { APP_ENV, MOCK_USER } from './support/env';
import { callsTo, login, mockState, resetAll, sql } from './support/helpers';

test.beforeEach(async ({ request }) => {
  await resetAll(request);
});

test('AC-1: user logs in with Atlassian OAuth (PKCE) and no PAT or shared credential is used', async ({ page, request }) => {
  await page.goto('/sessions');
  await expect(page).toHaveURL(/\/login$/);

  await login(page);
  await expect(page.getByRole('banner').getByText(MOCK_USER.name)).toBeVisible();

  const state = await mockState(request);
  const authorize = callsTo(state, 'GET', '/authorize');
  expect(authorize).toHaveLength(1);
  const params = new URLSearchParams(authorize[0].query);
  expect(params.get('code_challenge_method')).toBe('S256');
  expect(params.get('code_challenge')).toBeTruthy();
  // The mock only issues a token when the PKCE verifier matches the challenge.
  expect(callsTo(state, 'POST', '/oauth/token')).toHaveLength(1);

  // Every Atlassian API call carried the token issued to this user by the OAuth flow (SR-1.2).
  const apiCalls = state.calls.filter((c) => !['/authorize', '/oauth/token'].includes(c.path));
  expect(apiCalls.length).toBeGreaterThan(0);
  for (const call of apiCalls) expect(call.account, `${call.method} ${call.path}`).toBe(MOCK_USER.accountId);

  // The only Atlassian settings are the OAuth app, the site and the host overrides: no PAT or shared account.
  expect(Object.keys(APP_ENV).filter((k) => k.startsWith('ATLASSIAN_')).sort()).toEqual([
    'ATLASSIAN_API_BASE_URL',
    'ATLASSIAN_AUTH_BASE_URL',
    'ATLASSIAN_CLIENT_ID',
    'ATLASSIAN_CLIENT_SECRET',
    'ATLASSIAN_CLOUD_ID',
  ]);

  const tokens = await sql<{ user_id: string }>('SELECT user_id FROM oauth_token');
  expect(tokens.map((t) => t.user_id)).toEqual([MOCK_USER.accountId]);
  const audits = await sql<{ action: string; result: string; user_id: string }>(
    "SELECT action, result, user_id FROM audit_record WHERE action LIKE 'auth.%'",
  );
  expect(audits).toEqual([{ action: 'auth.login', result: 'success', user_id: MOCK_USER.accountId }]);
});
