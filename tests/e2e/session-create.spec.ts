import { expect, test } from '@playwright/test';
import { createSession, ingestButton, login, resetAll, sql } from './support/helpers';

test.beforeEach(async ({ request }) => {
  await resetAll(request);
});

test('GI-2: creating a session ingests nothing; the workspace offers Ingest ticket', async ({ page }) => {
  await login(page);
  const sessionId = await createSession(page, 'ABC-123', { ingest: false });

  await expect(page.getByRole('heading', { name: 'ABC-123' })).toBeVisible();
  await expect(page.getByText('Sources not ingested yet.')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Sources' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Refresh sources' })).toHaveCount(0);
  await expect(ingestButton(page)).toBeEnabled();
  expect(await sql('SELECT 1 FROM source_snapshot WHERE session_id = $1', [sessionId])).toHaveLength(0);
  const [row] = await sql<{ ingested_at: Date | null; analyzed_at: Date | null }>(
    'SELECT ingested_at, analyzed_at FROM planning_session WHERE id = $1',
    [sessionId],
  );
  expect(row).toEqual({ ingested_at: null, analyzed_at: null });
  const created = await sql('SELECT 1 FROM audit_record WHERE action = $1 AND session_id = $2', ['draft.created', sessionId]);
  expect(created).toHaveLength(1);

  // The sources appear only after the facilitator ingests (Analyze after ingest unchecked: no AI turn is consumed).
  await page.getByLabel('Analyze after ingest').uncheck();
  await ingestButton(page).click();
  await expect(page.getByRole('list', { name: 'Sources' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Sources not ingested yet.')).toHaveCount(0);
  await expect(ingestButton(page)).toHaveCount(0);
});

test('AC-2: ingesting a session with ABC-123 shows its description, comments, attachments and linked Confluence pages', async ({
  page,
}) => {
  await login(page);
  const sessionId = await createSession(page, 'ABC-123');

  const header = page.getByRole('region', { name: 'Session', exact: true });
  await expect(header.getByRole('heading', { name: 'ABC-123' })).toBeVisible();
  const sources = header.getByRole('list', { name: 'Sources' });
  const source = (text: string) => sources.getByRole('listitem').filter({ hasText: text });

  await expect(source('Jira issue · Export report as CSV')).toContainText('Ingested');
  await expect(source('Confluence page · Export design notes')).toContainText('Ingested');
  // Ingested vs listed attachments (SR-2.4).
  await expect(source('Attachment · notes.txt')).toContainText('Ingested');
  await expect(source('Attachment · mock.png')).toContainText('Ingested');
  await expect(source('Attachment · archive.zip')).toContainText('Listed only (not ingested)');
  await expect(source('Attachment · archive.zip')).toContainText('Reason: unsupported_type');

  // The description and comments are snapshotted into the session as AI context (the UI lists sources by title).
  const [issue] = await sql<{ content_text: string }>(
    "SELECT content_text FROM source_snapshot WHERE session_id = $1 AND kind = 'jira_issue' AND ref = 'ABC-123'",
    [sessionId],
  );
  expect(issue.content_text).toContain('Users can export the report.');
  expect(issue.content_text).toContain('Exports must handle at least 10000 rows.');
  expect(issue.content_text).toContain('CSV must be UTF-8 with a header row.');
  const [page5001] = await sql<{ content_text: string }>(
    "SELECT content_text FROM source_snapshot WHERE session_id = $1 AND kind = 'confluence_page' AND ref = '5001'",
    [sessionId],
  );
  expect(page5001.content_text).toContain('Stream rows to the client to keep memory flat.');

  const created = await sql('SELECT 1 FROM audit_record WHERE action = $1 AND session_id = $2', ['draft.created', sessionId]);
  expect(created).toHaveLength(1);
});
