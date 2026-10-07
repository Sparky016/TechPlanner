import { expect, test } from '@playwright/test';
import { SECTION_NAMES } from '../../src/lib/spec/sections';
import { createSession, login, resetAll, sendMessage, sql } from './support/helpers';

test.beforeEach(async ({ request }) => {
  await resetAll(request);
});

test('AC-6: the Generated Specification always contains the 27 FR-5 sections in order', async ({ page }) => {
  expect(SECTION_NAMES).toHaveLength(27);
  await login(page);
  const sessionId = await createSession(page, 'ABC-123');

  const headings = page.getByRole('region', { name: 'Specification' }).getByRole('heading', { level: 3 });
  await expect(headings).toHaveText([...SECTION_NAMES]);

  // An AI patch and a Save Draft leave the template intact.
  await sendMessage(page, 'Summarise the goal. #stream');
  await page.getByRole('button', { name: 'Save Draft' }).click();
  await expect(page.getByText('Draft saved as revision 1')).toBeVisible();
  await page.reload();
  await expect(headings).toHaveText([...SECTION_NAMES]);

  const [wc] = await sql<{ sections: Record<string, unknown> }>('SELECT sections FROM working_copy WHERE session_id = $1', [
    sessionId,
  ]);
  expect(Object.keys(wc.sections).sort()).toEqual([...SECTION_NAMES].sort());
  const [rev] = await sql<{ sections: Record<string, unknown> }>(
    'SELECT sections FROM revision WHERE session_id = $1 AND number = 1',
    [sessionId],
  );
  expect(Object.keys(rev.sections).sort()).toEqual([...SECTION_NAMES].sort());
});
