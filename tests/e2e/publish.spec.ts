import { expect, test, type Page } from '@playwright/test';
import { SECTION_NAMES } from '../../src/lib/spec/sections';
import { CONFLUENCE_PARENT_PAGE_ID, MOCK_USER, SITE_URL } from './support/env';
import {
  adfText,
  callsTo,
  createSession,
  login,
  mockState,
  publishPanel,
  publishStep,
  resetAll,
  sendMessage,
  sql,
  webhookDeliveries,
  type MockState,
} from './support/helpers';

const KEYS = ['ABC-123', 'ABC-124'];
const STEP_LABELS = ['Confluence page', 'Jira attachment', 'Jira description', 'Jira comment', 'Jira label', 'Downstream notification'];

test.beforeEach(async ({ request }) => {
  await resetAll(request);
});

async function publishAndWait(page: Page, revision: number): Promise<void> {
  await publishPanel(page).getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(publishPanel(page).getByRole('status')).toHaveText(`Published (revision ${revision})`, { timeout: 60_000 });
  for (const label of STEP_LABELS) await expect(publishStep(page, label)).toContainText('Success');
}

function originalContent(state: MockState, key: string): unknown[] {
  return state.issues[key].description?.content ?? [];
}

test('AC-11: publish creates/updates the Confluence page, attaches, inserts the description block, comments, labels and fires a signed webhook', async ({
  page,
  request,
}) => {
  await login(page);
  const sessionId = await createSession(page, KEYS.join(', '));
  // The scripted evaluator reports every section Complete once this marker is in the specification.
  await sendMessage(page, 'Record the agreed specification. #fill-ready');
  const before = await mockState(request);

  await publishAndWait(page, 1);
  // A passing gate needs no Override.
  await expect(page.getByRole('dialog', { name: 'Publish with override' })).toBeHidden();

  const [session] = await sql<{ status: string; confluence_page_id: string; confluence_page_version: number }>(
    'SELECT status, confluence_page_id, confluence_page_version FROM planning_session WHERE id = $1',
    [sessionId],
  );
  expect(session.status).toBe('published');
  const [run] = await sql<{ id: string }>('SELECT id FROM publish_run WHERE session_id = $1', [sessionId]);

  const after = await mockState(request);
  // Confluence: one page created under the configured space/parent.
  const created = Object.values(after.pages).filter((p) => !(p.id in before.pages));
  expect(created).toHaveLength(1);
  const pageRow = created[0];
  expect(pageRow.id).toBe(session.confluence_page_id);
  expect(pageRow.parentId).toBe(CONFLUENCE_PARENT_PAGE_ID);
  expect(pageRow.title).toBe('ABC-123: Export report as CSV — Technical Specification');
  expect(pageRow.body).toContain('Agreed specification for CSV export.');
  const pageUrl = `${SITE_URL}/wiki/spaces/ENG/pages/${pageRow.id}`;

  const markdown = after.issues['ABC-123'].attachments.find((a) => a.filename === 'ABC-123-spec-r1.md')?.text ?? '';
  for (const key of KEYS) {
    const issue = after.issues[key];
    // Attachment on every ticket.
    expect(issue.attachments.filter((a) => a.filename === `${key}-spec-r1.md`)).toHaveLength(1);
    expect(issue.attachments.find((a) => a.filename === `${key}-spec-r1.md`)?.text).toBe(markdown);

    // Description: the original content is untouched and the delimited block is appended after it.
    const original = originalContent(before, key);
    const content = issue.description?.content ?? [];
    expect(content.slice(0, original.length)).toEqual(original);
    const block = adfText({ type: 'doc', content: content.slice(original.length) });
    expect(block).toContain('TECH-PLANNER-SPEC-START');
    expect(block).toContain('TECH-PLANNER-SPEC-END');
    expect(block).toContain(pageUrl);

    // One publish comment carrying this run's marker, the publisher and the Confluence link.
    const comments = issue.comments.filter((c) => adfText(c.body).includes(`tech-planner-run:${run.id}`));
    expect(comments).toHaveLength(1);
    // The publisher is a mention of the acting user.
    expect(JSON.stringify(comments[0].body)).toContain(`"id":"${MOCK_USER.accountId}"`);
    expect(adfText(comments[0].body)).toContain(pageUrl);

    // Label added, existing labels kept.
    expect(issue.labels).toEqual([...before.issues[key].labels, 'spec-published']);
  }

  // The published markdown carries the 27 sections in order (FR-5).
  const headings = [...markdown.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
  expect(headings).toEqual([...SECTION_NAMES]);

  // Downstream webhook: one delivery with a valid HMAC signature and the §7.4 payload.
  const deliveries = await webhookDeliveries(request);
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0].signatureValid).toBe(true);
  expect(deliveries[0].signature).toMatch(/^sha256=[0-9a-f]{64}$/);
  expect(deliveries[0].body).toMatchObject({
    event: 'spec.published',
    sessionId,
    primaryTicket: 'ABC-123',
    tickets: KEYS,
    revision: 1,
    readinessScore: 100,
    override: false,
    confluencePageUrl: pageUrl,
    attachmentName: 'ABC-123-spec-r1.md',
    specMarkdown: markdown,
    publishedBy: MOCK_USER.accountId,
  });

  // Republish (SR-13.5): a new revision updates the same page and replaces the description block in place.
  await page.reload();
  await publishAndWait(page, 2);
  const again = await mockState(request);
  expect(Object.keys(again.pages)).toHaveLength(Object.keys(after.pages).length);
  expect(again.pages[pageRow.id].version).toBe(2);
  expect(callsTo(again, 'PUT', `/wiki/api/v2/pages/${pageRow.id}`)).toHaveLength(1);
  for (const key of KEYS) {
    const issue = again.issues[key];
    expect(issue.attachments.map((a) => a.filename).filter((f) => f.startsWith(`${key}-spec-`))).toEqual([
      `${key}-spec-r1.md`,
      `${key}-spec-r2.md`,
    ]);
    const text = adfText(issue.description);
    expect(text.split('TECH-PLANNER-SPEC-START')).toHaveLength(2);
    expect((issue.description?.content ?? []).slice(0, originalContent(before, key).length)).toEqual(
      originalContent(before, key),
    );
    expect(issue.labels.filter((l) => l === 'spec-published')).toHaveLength(1);
  }
  expect(await webhookDeliveries(request)).toHaveLength(2);
});
