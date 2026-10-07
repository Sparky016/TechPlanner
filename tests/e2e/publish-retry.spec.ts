import { expect, test } from '@playwright/test';
import {
  adfText,
  callsTo,
  createSession,
  injectFault,
  login,
  mockState,
  publishPanel,
  publishStep,
  resetAll,
  sendMessage,
  sql,
  webhookDeliveries,
} from './support/helpers';

const ISSUE = '/rest/api/3/issue/ABC-123';

test.beforeEach(async ({ request }) => {
  await resetAll(request);
});

test('AC-12: with Confluence failing, Jira results persist, the UI shows the failed step, and Retry completes it without duplicate attachments or comments', async ({
  page,
  request,
}) => {
  await login(page);
  const sessionId = await createSession(page, 'ABC-123');
  await sendMessage(page, 'Record the agreed specification. #fill-ready');

  // Run 1: Confluence page creation fails; the attachment upload takes effect but its response is lost.
  await injectFault(request, { method: 'POST', path: '/wiki/api/v2/pages$', status: 500, times: 1, message: 'Confluence is down' });
  await injectFault(request, { method: 'POST', path: `${ISSUE}/attachments$`, status: 500, times: 1, when: 'after' });

  const panel = publishPanel(page);
  await panel.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Publish failed (revision 1)', { timeout: 60_000 });
  await expect(publishStep(page, 'Confluence page')).toContainText('Failed');
  await expect(publishStep(page, 'Confluence page')).toContainText('Confluence is down');
  await expect(publishStep(page, 'Jira label')).toContainText('Success');
  await expect(publishStep(page, 'Jira description')).toContainText('Waiting');
  await expect(publishStep(page, 'Jira comment')).toContainText('Waiting');
  await expect(publishStep(page, 'Downstream notification')).toContainText('Pending');

  // Partial state is persisted and visible on reopening the session (SR-13.3).
  const [session] = await sql<{ status: string }>('SELECT status FROM planning_session WHERE id = $1', [sessionId]);
  expect(session.status).toBe('partially_published');
  const [run] = await sql<{ id: string; steps: { name: string; status: string }[] }>(
    'SELECT id, steps FROM publish_run WHERE session_id = $1',
    [sessionId],
  );
  expect(Object.fromEntries(run.steps.map((s) => [s.name, s.status]))).toMatchObject({
    confluence: 'failed',
    jira_label: 'success',
  });
  await page.reload();
  await expect(publishStep(page, 'Confluence page')).toContainText('Failed');
  await expect(publishStep(page, 'Jira label')).toContainText('Success');

  // Retry 1: Confluence and the attachment succeed; the publish comment is created but its response is lost.
  await injectFault(request, { method: 'POST', path: `${ISSUE}/comment$`, status: 500, times: 1, when: 'after' });
  await panel.getByRole('button', { name: 'Retry failed steps' }).click();
  // Wait on step states only this retry can produce before reading the run status.
  await expect(publishStep(page, 'Confluence page')).toContainText('Success', { timeout: 60_000 });
  await expect(publishStep(page, 'Jira comment')).toContainText('Failed', { timeout: 60_000 });
  await expect(panel.getByRole('status')).toHaveText('Publish failed (revision 1)', { timeout: 60_000 });
  await expect(publishStep(page, 'Jira attachment')).toContainText('Success');

  // Retry 2 completes the run.
  await panel.getByRole('button', { name: 'Retry failed steps' }).click();
  await expect(panel.getByRole('status')).toHaveText('Published (revision 1)', { timeout: 60_000 });

  const state = await mockState(request);
  const issue = state.issues['ABC-123'];
  // One upload attempt, one attachment: the retry found the file instead of uploading it again.
  expect(callsTo(state, 'POST', `${ISSUE}/attachments`)).toHaveLength(1);
  expect(issue.attachments.filter((a) => a.filename === 'ABC-123-spec-r1.md')).toHaveLength(1);
  // One comment POST, one comment: the second retry found this run's comment by its marker.
  expect(callsTo(state, 'POST', `${ISSUE}/comment`)).toHaveLength(1);
  expect(issue.comments.filter((c) => adfText(c.body).includes(`tech-planner-run:${run.id}`))).toHaveLength(1);
  // Successful steps never re-ran.
  expect(callsTo(state, 'POST', '/wiki/api/v2/pages')).toHaveLength(2);
  expect(issue.labels.filter((l) => l === 'spec-published')).toHaveLength(1);
  expect(adfText(issue.description).split('TECH-PLANNER-SPEC-START')).toHaveLength(2);

  const deliveries = await webhookDeliveries(request);
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0].signatureValid).toBe(true);
  const [finalSession] = await sql<{ status: string }>('SELECT status FROM planning_session WHERE id = $1', [sessionId]);
  expect(finalSession.status).toBe('published');
});
