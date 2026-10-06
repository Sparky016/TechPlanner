import { expect, test } from '@playwright/test';
import { createSession, editSection, login, resetAll, sectionEditor, sendMessage, sql } from './support/helpers';

const REV1_PROBLEM = 'Revision one problem: analysts cannot export the report.';
const PATCH_TEXT = 'E2E live patch: users export the report as CSV.';

test.beforeEach(async ({ request }) => {
  await resetAll(request);
});

test('AC-9: Save Draft creates a revision; two revisions compare; restoring revision 1 creates a new revision with its content', async ({
  page,
}) => {
  await login(page);
  const sessionId = await createSession(page, 'ABC-123');
  const saveDraft = page.getByRole('button', { name: 'Save Draft' });

  await editSection(page, 'Problem Statement', REV1_PROBLEM);
  await saveDraft.click();
  await expect(page.getByText('Draft saved as revision 1')).toBeVisible();

  await sendMessage(page, 'Summarise the goal. #stream');
  await expect(sectionEditor(page, 'Executive Summary')).toHaveText(PATCH_TEXT);
  await saveDraft.click();
  await expect(page.getByText('Draft saved as revision 2')).toBeVisible();

  await page.getByRole('button', { name: 'History' }).click();
  const history = page.getByRole('complementary', { name: 'Version history' });
  const revisions = history.getByRole('list', { name: 'Revisions' }).getByRole('listitem');
  await expect(revisions).toHaveCount(2);
  await expect(revisions.filter({ hasText: 'Revision 1' })).toContainText('save');

  await history.getByLabel('Select revision 1').check();
  await history.getByLabel('Select revision 2').check();
  await history.getByRole('button', { name: 'Compare selected' }).click();
  const diff = history.getByLabel('Changes from revision 1 to revision 2');
  await expect(diff).toContainText('1 changed section');
  await expect(diff.locator('details[open]')).toContainText('Executive Summary');
  await expect(diff.locator('details[open]')).toContainText(`+ ${PATCH_TEXT}`);

  await history.getByRole('button', { name: 'Restore revision 1' }).click();
  await history.getByRole('dialog', { name: 'Confirm restore' }).getByRole('button', { name: 'Confirm restore' }).click();
  await expect(history.getByText('Revision 1 restored as revision 3')).toBeVisible();
  await expect(revisions).toHaveCount(3);
  await expect(revisions.filter({ hasText: 'Revision 3' })).toContainText('restore');

  // The working copy now holds revision 1's content.
  await expect(sectionEditor(page, 'Problem Statement')).toHaveText(REV1_PROBLEM);
  await expect(sectionEditor(page, 'Executive Summary')).toHaveText('');

  const rows = await sql<{ number: number; trigger: string; sections: Record<string, string> }>(
    'SELECT number, trigger, sections FROM revision WHERE session_id = $1 ORDER BY number',
    [sessionId],
  );
  expect(rows.map((r) => [r.number, r.trigger])).toEqual([
    [1, 'save'],
    [2, 'save'],
    [3, 'restore'],
  ]);
  expect(rows[2].sections).toEqual(rows[0].sections);
  expect(rows[1].sections['Executive Summary']).toBe(PATCH_TEXT);
});
