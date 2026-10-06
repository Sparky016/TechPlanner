import { expect, test } from '@playwright/test';
import { createSession, login, resetAll, sql } from './support/helpers';

test.beforeEach(async ({ request }) => {
  await resetAll(request);
});

test('AC-2: creating a session with ABC-123 shows its description, comments, attachments and linked Confluence pages', async ({
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
