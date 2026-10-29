import { expect, test } from '@playwright/test';
import { createSession, login, rightPanel, resetAll, sendMessage, sql } from './support/helpers';

const QUESTION = 'E2E question: what is the maximum export size?';

test.beforeEach(async ({ request }) => {
  await resetAll(request);
});

test('AC-13: ending clarification stops proactive AI questions', async ({ page }) => {
  await login(page);
  const sessionId = await createSession(page, 'ABC-123');
  const questions = page.getByRole('region', { name: 'AI questions' }).getByRole('listitem');

  // The scripted facilitator asks a question on every '#ask' turn.
  await sendMessage(page, 'What else do you need? #ask');
  await expect(questions).toHaveCount(1);
  await expect(questions.first()).toContainText(QUESTION);

  await rightPanel(page).getByRole('button', { name: 'End clarification' }).click();
  await expect(rightPanel(page).getByText('Clarification ended')).toBeVisible();

  // Same message after the loop ended: the AI still answers, but no question is asked.
  await sendMessage(page, 'Anything else? #ask');
  await expect(page.getByRole('list', { name: 'Messages' }).locator('[data-role="ai"]')).toHaveCount(2);
  await page.reload();
  await expect(page.getByRole('region', { name: 'AI questions' }).getByRole('listitem')).toHaveCount(1);

  const rows = await sql('SELECT 1 FROM ai_question WHERE session_id = $1', [sessionId]);
  expect(rows).toHaveLength(1);

  // The question is closed with Resolve (which replaced Dismiss): not relevant, with a reason.
  const open = page.getByRole('region', { name: 'AI questions' }).getByRole('listitem').first();
  await open.getByRole('button', { name: 'Resolve as not relevant' }).click();
  await open.getByLabel('Reason (optional)').fill('Out of scope for the first release');
  await open.getByRole('button', { name: 'Confirm resolve' }).click();
  await expect(page.getByRole('region', { name: 'AI questions' }).getByRole('button', { name: 'Resolved (1)' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'AI questions' }).getByRole('heading', { level: 2 })).toHaveText(
    'Questions · 0 open · 0 answered',
  );
  expect(await sql('SELECT status, resolution, dismiss_reason FROM ai_question WHERE session_id = $1', [sessionId])).toEqual([
    { status: 'resolved', resolution: 'not_relevant', dismiss_reason: 'Out of scope for the first release' },
  ]);
  const turns = await sql<{ details: { questions: string[]; clarificationEnded: boolean } }>(
    "SELECT details FROM audit_record WHERE action = 'ai.suggestion' AND session_id = $1 ORDER BY id",
    [sessionId],
  );
  expect(turns.map((t) => [t.details.clarificationEnded, t.details.questions.length])).toEqual([
    [false, 1],
    [true, 0],
  ]);
  const [session] = await sql<{ clarification_ended: boolean }>(
    'SELECT clarification_ended FROM planning_session WHERE id = $1',
    [sessionId],
  );
  expect(session.clarification_ended).toBe(true);
});
