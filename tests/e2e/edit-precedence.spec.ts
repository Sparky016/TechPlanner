import { expect, test } from '@playwright/test';
import { createSession, editSection, login, resetAll, section, sql, startMessage, waitForTurnEnd } from './support/helpers';

const USER_SCOPE = 'Facilitator scope: CSV and XLSX export.';
const AI_SCOPE = 'AI proposed scope: CSV export only.';

test.beforeEach(async ({ request }) => {
  await resetAll(request);
});

test('AC-5: a section edited by the facilitator is not overwritten by a later AI patch; a pending suggestion appears', async ({
  page,
}) => {
  await login(page);
  const sessionId = await createSession(page, 'ABC-123');

  // The scripted turn reads the working copy at turn start, pauses, then patches Scope. The facilitator edits Scope
  // while the turn is running, i.e. after the AI last read it (D-5).
  await startMessage(page, 'Let us settle the scope. #precedence');
  await expect(page.getByTestId('streaming-reply')).toContainText('Reviewing the scope while you edit.');
  await editSection(page, 'Scope', USER_SCOPE);
  await waitForTurnEnd(page);

  const scope = section(page, 'Scope');
  await expect(scope.getByText('1 pending')).toBeVisible();
  const suggestion = scope.locator('[data-suggestion]');
  await expect(suggestion).toContainText('AI suggestion (replace section)');
  await expect(suggestion.getByLabel('Suggested change')).toContainText(AI_SCOPE);
  // The facilitator's text is still the section body.
  await expect(scope.getByRole('textbox', { name: 'Scope content' })).toHaveText(USER_SCOPE);

  const [wc] = await sql<{ sections: Record<string, { body: string }> }>(
    'SELECT sections FROM working_copy WHERE session_id = $1',
    [sessionId],
  );
  expect(wc.sections.Scope.body).toBe(USER_SCOPE);

  // Rejecting keeps the facilitator's text and is audited.
  await suggestion.getByRole('button', { name: 'Reject' }).click();
  await expect(suggestion).toBeHidden();
  await expect(scope.getByRole('textbox', { name: 'Scope content' })).toHaveText(USER_SCOPE);
  await expect
    .poll(async () => (await sql('SELECT 1 FROM audit_record WHERE action = $1', ['ai.suggestion.rejected'])).length)
    .toBe(1);
});
