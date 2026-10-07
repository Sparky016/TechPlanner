import { expect, test } from '@playwright/test';
import { MOCK_USER } from './support/env';
import {
  createSession,
  editSection,
  injectFault,
  login,
  publishPanel,
  resetAll,
  rightPanel,
  runScript,
  section,
  sendMessage,
  sql,
  startMessage,
  waitForTurnEnd,
} from './support/helpers';

// SR-12.1 event types.
const EVENT_TYPES = [
  'auth.login',
  'auth.logout',
  'auth.failure',
  'draft.created',
  'draft.updated',
  'draft.saved',
  'ai.suggestion',
  'ai.suggestion.accepted',
  'ai.suggestion.rejected',
  'user.edit',
  'readiness.evaluated',
  'readiness.override',
  'publish.started',
  'publish.completed',
  'publish.failed',
  'jira.updated',
  'confluence.updated',
  'downstream.triggered',
  'revision.restored',
  'error',
];
// What the flow below triggers.
const EXPECTED = EVENT_TYPES.filter((t) => !['ai.suggestion.rejected', 'error'].includes(t));

type AuditRow = {
  id: string;
  ts: Date | null;
  user_id: string | null;
  user_display_name: string | null;
  session_id: string | null;
  ticket_ids: string[] | null;
  action: string;
  result: string;
  details: unknown;
  prev_hash: Buffer | null;
  hash: Buffer | null;
};

test.beforeEach(async ({ request }) => {
  await resetAll(request);
});

test('AC-10: every SR-12.1 event of an E2E run has an Audit Record with all §14 fields; UPDATE on audit_record fails; the chain verifier passes', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);

  // auth.failure: a callback whose state does not match this browser's login.
  await page.goto('/auth/callback?code=forged&state=forged');
  await expect(page).toHaveURL(/\/login\?error=state$/);

  await login(page);
  const sessionId = await createSession(page, 'ABC-123');

  // user.edit and draft.updated (autosave), then ai.suggestion and ai.suggestion.accepted via edit precedence.
  await startMessage(page, 'Let us settle the scope. #precedence');
  await expect(page.getByTestId('streaming-reply')).toContainText('Reviewing the scope while you edit.');
  await editSection(page, 'Scope', 'Facilitator scope: CSV export.');
  await waitForTurnEnd(page);
  await section(page, 'Scope').getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(section(page, 'Scope').locator('[data-suggestion]')).toBeHidden();

  // draft.saved, then revision.restored.
  await page.getByRole('button', { name: 'Save Draft' }).click();
  await expect(page.getByText('Draft saved as revision 1')).toBeVisible();
  await sendMessage(page, 'Summarise the goal. #stream');
  await page.getByRole('button', { name: 'History' }).click();
  const history = page.getByRole('complementary', { name: 'Version history' });
  await history.getByRole('button', { name: 'Restore revision 1' }).click();
  await history.getByRole('dialog', { name: 'Confirm restore' }).getByRole('button', { name: 'Confirm restore' }).click();
  await expect(history.getByText('Revision 1 restored as revision 2')).toBeVisible();

  // readiness.evaluated.
  await rightPanel(page).getByRole('button', { name: 'Evaluate now' }).click();
  await expect(rightPanel(page).getByText('Score (informational): 0')).toBeVisible({ timeout: 30_000 });

  // readiness.override, publish.started, publish.failed (Confluence down), then retry: confluence.updated,
  // jira.updated, downstream.triggered, publish.completed.
  await injectFault(request, { method: 'POST', path: '/wiki/api/v2/pages$', status: 500, times: 1 });
  const panel = publishPanel(page);
  await panel.getByRole('button', { name: 'Publish', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Publish with override' });
  await dialog.getByLabel('Justification (at least 20 characters)').fill('Accepted for the E2E audit run.');
  await dialog.getByRole('checkbox', { name: /I confirm publishing/ }).check();
  await dialog.getByRole('button', { name: 'Publish with override' }).click();
  await expect(panel.getByRole('status')).toHaveText('Publish failed (revision 3)', { timeout: 60_000 });
  await panel.getByRole('button', { name: 'Retry failed steps' }).click();
  await expect(panel.getByRole('status')).toHaveText('Published (revision 3)', { timeout: 60_000 });

  // The audit trail view lists the session's records.
  await page.goto(`/sessions/${sessionId}/audit`);
  await expect(page.getByRole('row').filter({ hasText: 'publish.completed' })).toHaveCount(1);

  // auth.logout.
  await page.goto('/sessions');
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login/);

  const rows = await sql<AuditRow>('SELECT * FROM audit_record ORDER BY id');
  const actions = new Set(rows.map((r) => r.action));
  for (const type of EXPECTED) expect(actions, `missing ${type}`).toContain(type);
  for (const action of actions) expect(EVENT_TYPES, `unexpected ${action}`).toContain(action);

  for (const [i, row] of rows.entries()) {
    const label = `${row.id} ${row.action}`;
    expect(row.ts, label).toBeInstanceOf(Date);
    expect(['success', 'failure'], label).toContain(row.result);
    expect(typeof row.details, label).toBe('object');
    expect(row.hash?.length, label).toBe(32);
    if (i === 0) expect(row.prev_hash, label).toBeNull();
    else expect(row.prev_hash?.equals(rows[i - 1].hash as Buffer), label).toBe(true);
    // The forged callback has no user; every other record names the acting user.
    if (row.action !== 'auth.failure') {
      expect(row.user_id, label).toBe(MOCK_USER.accountId);
      expect(row.user_display_name, label).toBe(MOCK_USER.name);
    }
    if (!row.action.startsWith('auth.')) {
      expect(row.session_id, label).toBe(sessionId);
      expect(row.ticket_ids, label).toEqual(['ABC-123']);
    }
  }

  // Append-only at the database level (SR-12.3).
  await expect(sql("UPDATE audit_record SET result = 'failure' WHERE id = $1", [rows[0].id])).rejects.toThrow(
    /append-only/,
  );
  await expect(sql('DELETE FROM audit_record WHERE id = $1', [rows[0].id])).rejects.toThrow(/append-only/);

  // The chain verifier (npm run audit:verify) passes.
  // (A debounced background evaluation may append records after the query above.)
  const verified = /^OK (\d+)$/.exec(runScript('audit:verify').trim());
  expect(verified).not.toBeNull();
  expect(Number(verified![1])).toBeGreaterThanOrEqual(rows.length);
});
