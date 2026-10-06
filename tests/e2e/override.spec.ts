import { expect, test } from '@playwright/test';
import { adfText, createSession, login, mockState, publishPanel, resetAll, sql } from './support/helpers';

const JUSTIFICATION = 'Release deadline agreed with the product owner; gaps tracked in ABC-200.';
const CORE = ['Problem Statement', 'Scope', 'Functional Requirements', 'Technical Design', 'Acceptance Criteria'];

test.beforeEach(async ({ request }) => {
  await resetAll(request);
});

test('AC-8: publish with an open Critical Issue requires a justification (>= 20 chars) and confirmation; the Override is in the audit log, spec header and Jira comment', async ({
  page,
  request,
}) => {
  await login(page);
  const sessionId = await createSession(page, 'ABC-123');

  // The empty specification fails the gate: the scripted evaluator reports nothing, so core sections are Missing.
  await publishPanel(page).getByRole('button', { name: 'Publish', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Publish with override' });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  for (const name of CORE) await expect(dialog.getByRole('listitem').filter({ hasText: `${name} is missing` })).toHaveCount(1);

  const submit = dialog.getByRole('button', { name: 'Publish with override' });
  const justification = dialog.getByLabel('Justification (at least 20 characters)');
  const confirm = dialog.getByRole('checkbox', { name: /I confirm publishing/ });

  await justification.fill('Too short to count');
  await confirm.check();
  await expect(submit).toBeDisabled();
  await justification.fill(JUSTIFICATION);
  await confirm.uncheck();
  await expect(submit).toBeDisabled();
  await confirm.check();
  await expect(submit).toBeEnabled();
  await submit.click();

  await expect(dialog).toBeHidden();
  await expect(publishPanel(page).getByRole('status')).toHaveText('Published (revision 1)', { timeout: 60_000 });

  // Audit log: readiness.override with the justification and the open critical issues.
  const overrides = await sql<{ details: { justification: string; openCriticalIssues: { section: string }[] } }>(
    "SELECT details FROM audit_record WHERE action = 'readiness.override' AND session_id = $1",
    [sessionId],
  );
  expect(overrides).toHaveLength(1);
  expect(overrides[0].details.justification).toBe(JUSTIFICATION);
  expect(overrides[0].details.openCriticalIssues.map((i) => i.section).sort()).toEqual([...CORE].sort());
  await page.goto(`/sessions/${sessionId}/audit`);
  await expect(page.getByRole('row').filter({ hasText: 'readiness.override' })).toHaveCount(1);

  // Spec header (the published markdown and the Confluence page) and the Jira comment carry the justification.
  const state = await mockState(request);
  const markdown = state.issues['ABC-123'].attachments.find((a) => a.filename === 'ABC-123-spec-r1.md')?.text ?? '';
  const header = markdown.split('\n## ')[0];
  expect(header).toContain('Override justification');
  expect(header).toContain(JUSTIFICATION);
  const [{ confluence_page_id: pageId }] = await sql<{ confluence_page_id: string }>(
    'SELECT confluence_page_id FROM planning_session WHERE id = $1',
    [sessionId],
  );
  expect(state.pages[pageId].body).toContain(JUSTIFICATION);
  const comments = state.issues['ABC-123'].comments.map((c) => adfText(c.body));
  expect(comments.filter((c) => c.includes(`Override justification: ${JUSTIFICATION}`))).toHaveLength(1);

  // SR-9.3: the Override applied to that publish only; the next Publish re-checks the gate.
  await page.goto(`/sessions/${sessionId}`);
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeEnabled({ timeout: 30_000 });
  await publishPanel(page).getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(dialog).toBeVisible({ timeout: 30_000 });
});
