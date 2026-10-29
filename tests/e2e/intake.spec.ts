import { expect, test, type Page } from '@playwright/test';
import {
  createSession,
  ingestButton,
  login,
  openDiscussion,
  resetAll,
  section,
  sendMessage,
  sql,
  waitForIntakeIdle,
} from './support/helpers';

// Guided intake (task 51, spec docs/specs/guided-intake-and-question-answering.md §10): ingest on demand, the initial
// AI analysis, answering and resolving questions, Discuss with AI, and Create and ingest. The scripted LLM
// (fixtures/llm-script.json) answers the analysis turn with three questions, and the answer / discussion turns by
// markers in the facilitator's text.

const Q_SIZE = 'E2E analysis question: what is the maximum export size?';
const Q_COLUMNS = 'E2E analysis question: which columns are exported?';
const Q_ACCESS = 'E2E analysis question: who may export reports?';

test.beforeEach(async ({ request }) => {
  await resetAll(request);
});

const questionsRegion = (page: Page) => page.getByRole('region', { name: 'AI questions' });
const questionItem = (page: Page, text: string) => questionsRegion(page).getByRole('listitem').filter({ hasText: text });
const heading = (page: Page, text: string) => questionsRegion(page).getByRole('heading', { name: text, level: 2 });

async function auditCount(sessionId: string, action: string): Promise<number> {
  return (await sql('SELECT 1 FROM audit_record WHERE action = $1 AND session_id = $2', [action, sessionId])).length;
}

test('GI flow 1: Create session, Ingest (chained analysis), answer, resolve, resolve as not relevant, Discuss with AI', async ({
  page,
}) => {
  await login(page);
  const sessionId = await createSession(page, 'ABC-123', { ingest: false });

  // Not ingested: no snapshots, no AI, the repository section is available, and the discussion is disabled.
  expect(await sql('SELECT 1 FROM source_snapshot WHERE session_id = $1', [sessionId])).toHaveLength(0);
  await expect(page.getByText('Sources not ingested yet.')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Sources' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Code repository' })).toBeVisible();
  await expect(page.getByText('Ingest the ticket to start the discussion.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Discuss with AI', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Analyze after ingest')).toBeChecked();

  // Ingest with the analysis chained: sources are listed, then the analysis streams and drafts questions.
  await ingestButton(page).click();
  await expect(page.getByRole('list', { name: 'Sources' })).toBeVisible({ timeout: 30_000 });
  await expect(heading(page, 'Questions · 3 open · 0 answered')).toBeVisible({ timeout: 60_000 });
  await waitForIntakeIdle(page);
  await expect(page.getByRole('button', { name: 'Ingest ticket' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Analyze ticket' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Refresh sources' })).toBeEnabled();
  await expect(section(page, 'Executive Summary')).toContainText('E2E analysis draft: users export the report as CSV.');

  const [intake] = await sql<{ ingested_at: Date | null; analyzed_at: Date | null }>(
    'SELECT ingested_at, analyzed_at FROM planning_session WHERE id = $1',
    [sessionId],
  );
  expect(intake.ingested_at).not.toBeNull();
  expect(intake.analyzed_at).not.toBeNull();
  expect(
    await sql("SELECT 1 FROM conversation_message WHERE session_id = $1 AND role = 'system' AND content LIKE 'Sources ingested at %'", [
      sessionId,
    ]),
  ).toHaveLength(1);
  expect(await auditCount(sessionId, 'sources.ingested')).toBe(1);
  const [analysisTurn] = await sql<{ details: { turnKind: string } }>(
    "SELECT details FROM audit_record WHERE action = 'ai.suggestion' AND session_id = $1",
    [sessionId],
  );
  expect(analysisTurn.details.turnKind).toBe('analysis');

  const open = questionsRegion(page).getByRole('group', { name: 'Open (3)' });
  await expect(open.getByRole('listitem')).toHaveCount(3);
  await expect(open).toContainText(Q_SIZE);
  await expect(open).toContainText(Q_COLUMNS);
  await expect(open).toContainText(Q_ACCESS);

  // Answer one question: the AI works it into Scope and the question moves to Answered.
  const size = questionItem(page, Q_SIZE);
  await size.getByRole('button', { name: 'Answer', exact: true }).click();
  const answerBox = size.getByRole('textbox', { name: 'Your answer' });
  await expect(answerBox).toBeFocused();
  await answerBox.fill('The export is capped at 50000 rows. #answer-limit');
  await size.getByRole('button', { name: 'Send answer' }).click();
  await expect(size).toContainText('AI is updating the specification…');
  await expect(size).toContainText('Updated sections: Scope.', { timeout: 60_000 });
  await expect(section(page, 'Scope')).toContainText('E2E answered scope: exports are limited to 50000 rows.');
  await expect(heading(page, 'Questions · 2 open · 1 answered')).toBeVisible();
  const answered = questionsRegion(page).getByRole('group', { name: 'Answered — awaiting resolve (1)' });
  await expect(answered).toContainText('The export is capped at 50000 rows.');
  const [answerRow] = await sql<{ status: string; answer_text: string; answered_via: string }>(
    'SELECT status, answer_text, answered_via FROM ai_question WHERE session_id = $1 AND text = $2',
    [sessionId, Q_SIZE],
  );
  expect(answerRow).toMatchObject({ status: 'answered', answered_via: 'facilitator' });
  expect(answerRow.answer_text).toContain('50000 rows');

  // Resolve the answered question: it moves to Resolved (collapsed until opened) with resolution 'answered'.
  await answered.getByRole('button', { name: 'Resolve', exact: true }).click();
  const resolvedToggle = questionsRegion(page).getByRole('button', { name: 'Resolved (1)' });
  await expect(resolvedToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(questionItem(page, Q_SIZE)).toHaveCount(0);
  await resolvedToggle.click();
  await expect(resolvedToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(questionItem(page, Q_SIZE)).toContainText('Resolved — answered');

  // Resolve another one as not relevant, with a reason.
  const columns = questionItem(page, Q_COLUMNS);
  await columns.getByRole('button', { name: 'Resolve as not relevant' }).click();
  await columns.getByLabel('Reason (optional)').fill('The template fixes the columns');
  await columns.getByRole('button', { name: 'Confirm resolve' }).click();
  await expect(questionsRegion(page).getByRole('button', { name: 'Resolved (2)' })).toBeVisible();
  await expect(heading(page, 'Questions · 1 open · 0 answered')).toBeVisible();
  await expect(questionItem(page, Q_COLUMNS)).toContainText('Resolved — not relevant');
  await expect(questionItem(page, Q_COLUMNS)).toContainText('Reason: The template fixes the columns');
  const rows = await sql<{ text: string; status: string; resolution: string; dismiss_reason: string | null }>(
    'SELECT text, status, resolution, dismiss_reason FROM ai_question WHERE session_id = $1 ORDER BY text',
    [sessionId],
  );
  expect(rows.map((r) => [r.text, r.status, r.resolution])).toEqual([
    [Q_SIZE, 'resolved', 'answered'],
    [Q_COLUMNS, 'resolved', 'not_relevant'],
    [Q_ACCESS, 'open', null],
  ]);
  expect(rows[1].dismiss_reason).toBe('The template fixes the columns');
  expect(await auditCount(sessionId, 'question.answered')).toBe(1);
  expect(await auditCount(sessionId, 'question.resolved')).toBe(2);

  // Discuss with AI: the answer is shown as such, and a discussion turn updates a section.
  await openDiscussion(page);
  await expect(page.getByRole('list', { name: 'Messages' })).toContainText(`Answer to: ${Q_SIZE}`);
  await sendMessage(page, 'Only facilitators should be able to export. #discuss-security');
  await expect(section(page, 'Security')).toContainText('E2E discussion result: only facilitators may export reports.');
  await expect(page.getByRole('list', { name: 'Messages' })).toContainText('Security is updated.');
  const kinds = await sql<{ kind: string }>(
    "SELECT details->>'turnKind' AS kind FROM audit_record WHERE action = 'ai.suggestion' AND session_id = $1 ORDER BY id",
    [sessionId],
  );
  expect(kinds.map((k) => k.kind)).toEqual(['analysis', 'answer', 'message']);
});

test('GI flow 2: Create and ingest opens the workspace with sources and a streaming analysis; reload starts no second analysis', async ({
  page,
}) => {
  await login(page);
  const sessionId = await createSession(page, 'ABC-123', { ingest: 'create' });

  // Sources are listed and the analysis streams into the Discuss with AI panel.
  await expect(page.getByRole('list', { name: 'Sources' })).toContainText('Export report as CSV');
  await expect(page.getByTestId('streaming-reply')).toContainText('My understanding', { timeout: 30_000 });
  await expect(heading(page, 'Questions · 3 open · 0 answered')).toBeVisible({ timeout: 60_000 });
  await waitForIntakeIdle(page);
  await expect.poll(() => new URL(page.url()).search).toBe('');

  const analyses = () =>
    sql("SELECT 1 FROM audit_record WHERE action = 'ai.suggestion' AND session_id = $1 AND details->>'turnKind' = 'analysis'", [
      sessionId,
    ]);
  const notices = () =>
    sql("SELECT 1 FROM conversation_message WHERE session_id = $1 AND role = 'system' AND content LIKE 'Initial analysis requested by %'", [
      sessionId,
    ]);
  expect(await analyses()).toHaveLength(1);
  expect(await notices()).toHaveLength(1);

  // A reload, and even a stale ?analyze=1 link, start nothing: the session is analyzed. Wait for the lock first, which
  // is when the workspace would have started an analysis.
  for (const url of [`/sessions/${sessionId}`, `/sessions/${sessionId}?analyze=1`]) {
    await page.goto(url);
    await expect(page.getByRole('button', { name: 'Refresh sources' })).toBeEnabled({ timeout: 30_000 });
    await expect(heading(page, 'Questions · 3 open · 0 answered')).toBeVisible();
    await expect.poll(() => new URL(page.url()).search).toBe('');
    await expect(page.getByTestId('intake-status')).toHaveText('');
    expect(await analyses()).toHaveLength(1);
    expect(await notices()).toHaveLength(1);
  }
  expect(await sql('SELECT 1 FROM ai_question WHERE session_id = $1', [sessionId])).toHaveLength(3);
});
