'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorBanner } from '@/components/ErrorBanner';
import { useWorkspace, useWorkspaceEvents } from '@/components/workspace/WorkspaceProvider';
import { ApiError, apiFetch } from '@/lib/api/client';

// AI questions as the main work queue (GI-12..GI-18): answer inline (the answer is worked into the specification by
// an AI turn), resolve, edit an answer, reopen. Refreshes on streamed question events and at the end of each turn.

interface Question {
  id: string;
  issueId: string | null;
  section: string | null;
  text: string;
  // 'dismissed' is the legacy status; it is shown as resolved / not relevant.
  status: 'open' | 'answered' | 'resolved' | 'dismissed';
  dismissReason: string | null;
  answerText?: string | null;
  answeredAt?: string | null;
  answeredVia?: 'facilitator' | 'ai' | null;
  resolution?: 'answered' | 'not_relevant' | null;
  resolvedAt?: string | null;
  createdAt: string;
}

interface AnswerResult {
  sections: string[];
  suggestions: number;
}

interface Editing {
  id: string;
  text: string;
}

const MAX_ANSWER = 10_000;
const AI_UNAVAILABLE_TEXT =
  'AI unavailable: your answer was saved but not yet worked into the specification. Use Edit answer to resend.';

function toApiError(err: unknown, fallback: string): ApiError {
  return err instanceof ApiError ? err : new ApiError(fallback, 0, undefined, undefined, null);
}

function isResolved(q: Question) {
  return q.status === 'resolved' || q.status === 'dismissed';
}

function resolutionLabel(q: Question) {
  return q.resolution === 'answered' ? 'Resolved — answered' : 'Resolved — not relevant';
}

interface ItemProps {
  q: Question;
  disabled: boolean;
  updating: boolean;
  result: AnswerResult | undefined;
  editing: Editing | null;
  onStartEdit: (q: Question) => void;
  onChangeEdit: (text: string) => void;
  onCancelEdit: (id: string) => void;
  onSend: (q: Question) => void;
  onResolve: (q: Question, reason?: string) => Promise<void>;
  onReopen: (q: Question) => Promise<void>;
}

function QuestionItem({ q, disabled, updating, result, editing, onStartEdit, onChangeEdit, onCancelEdit, onSend, onResolve, onReopen }: ItemProps) {
  const [resolving, setResolving] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const reasonId = `resolve-reason-${q.id}`;
  const answerId = `answer-text-${q.id}`;
  const resolved = isResolved(q);
  const formOpen = editing?.id === q.id && !updating;
  const off = disabled || busy;

  useEffect(() => {
    if (formOpen) textareaRef.current?.focus();
  }, [formOpen]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  const badge = resolved ? 'Resolved' : q.status === 'answered' ? 'Answered' : 'Open';
  const badgeClass = resolved
    ? 'bg-slate-200 text-slate-700'
    : q.status === 'answered'
      ? 'bg-green-100 text-green-900'
      : 'bg-blue-100 text-blue-900';
  const actionBtn = 'rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-100 disabled:opacity-60';

  return (
    <li data-status={resolved ? 'resolved' : q.status} className="rounded border border-slate-200 bg-white px-2 py-1 text-sm">
      <div className="flex items-start justify-between gap-2">
        <p className="whitespace-pre-wrap break-words">{q.text}</p>
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${badgeClass}`}>{badge}</span>
      </div>
      {q.section ? <p className="text-xs text-slate-500">Section: {q.section}</p> : null}

      {q.status === 'answered' && q.answerText ? (
        <div className="mt-1 text-xs">
          <p className="font-medium text-slate-600">
            {q.answeredVia === 'ai' ? 'Answered in discussion (AI summary)' : 'Answer'}
          </p>
          <p className="whitespace-pre-wrap break-words text-slate-800">{q.answerText}</p>
        </div>
      ) : null}

      {resolved ? (
        <div className="mt-1 text-xs text-slate-600">
          <p>{resolutionLabel(q)}</p>
          {q.dismissReason ? <p>Reason: {q.dismissReason}</p> : null}
          {q.answerText ? <p className="whitespace-pre-wrap break-words">Answer: {q.answerText}</p> : null}
        </div>
      ) : null}

      {updating ? (
        <p className="mt-1 text-xs text-slate-700">AI is updating the specification…</p>
      ) : result ? (
        <p className="mt-1 text-xs text-slate-700">
          {result.sections.length > 0 ? `Updated sections: ${result.sections.join(', ')}. ` : ''}
          {result.suggestions > 0 ? `${result.suggestions} suggestion${result.suggestions === 1 ? '' : 's'} pending.` : ''}
          {result.sections.length === 0 && result.suggestions === 0 ? 'No section changes.' : ''}
        </p>
      ) : null}

      {formOpen ? (
        <form
          className="mt-1 space-y-1"
          onSubmit={(e) => {
            e.preventDefault();
            onSend(q);
          }}
        >
          <label htmlFor={answerId} className="block text-xs">
            Your answer
          </label>
          <textarea
            id={answerId}
            ref={textareaRef}
            value={editing.text}
            onChange={(e) => onChangeEdit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                if (!off && editing.text.trim()) onSend(q);
              }
            }}
            maxLength={MAX_ANSWER}
            rows={3}
            disabled={off}
            className="w-full rounded border border-slate-300 px-1 py-0.5 text-xs"
          />
          <div className="flex gap-2">
            <button type="submit" disabled={off || !editing.text.trim()} className={actionBtn}>
              Send answer
            </button>
            <button type="button" onClick={() => onCancelEdit(q.id)} className="px-1 text-xs underline">
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {!updating && !formOpen && !resolving ? (
        <div className="mt-1 flex flex-wrap gap-2">
          {q.status === 'open' ? (
            <>
              <button type="button" id={`question-action-${q.id}`} onClick={() => onStartEdit(q)} disabled={off} className={actionBtn}>
                Answer
              </button>
              <button type="button" onClick={() => setResolving(true)} disabled={off} className={actionBtn}>
                Resolve as not relevant
              </button>
            </>
          ) : null}
          {q.status === 'answered' ? (
            <>
              <button type="button" onClick={() => void run(() => onResolve(q))} disabled={off} className={actionBtn}>
                Resolve
              </button>
              <button type="button" id={`question-action-${q.id}`} onClick={() => onStartEdit(q)} disabled={off} className={actionBtn}>
                Edit answer
              </button>
            </>
          ) : null}
          {resolved ? (
            <button type="button" onClick={() => void run(() => onReopen(q))} disabled={off} className={actionBtn}>
              Reopen
            </button>
          ) : null}
        </div>
      ) : null}

      {q.status === 'open' && resolving ? (
        <form
          className="mt-1 flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await onResolve(q, reason.trim() ? reason : '');
              setResolving(false);
            });
          }}
        >
          <div className="flex-1">
            <label htmlFor={reasonId} className="block text-xs">
              Reason (optional)
            </label>
            <input
              id={reasonId}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              disabled={off}
              className="w-full rounded border border-slate-300 px-1 py-0.5 text-xs"
            />
          </div>
          <button type="submit" disabled={off} className={actionBtn}>
            Confirm resolve
          </button>
          <button type="button" onClick={() => setResolving(false)} className="px-1 text-xs underline">
            Cancel
          </button>
        </form>
      ) : null}
    </li>
  );
}

export function QuestionsList() {
  const { sessionId, readOnly, runTurn, turnInProgress } = useWorkspace();
  const [questions, setQuestions] = useState<Question[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [turnError, setTurnError] = useState<{ message: string; correlationId?: string } | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [answeringId, setAnsweringId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, AnswerResult>>({});
  const [showResolved, setShowResolved] = useState(false);
  const [status, setStatus] = useState('');
  const collecting = useRef<{ sections: Set<string>; suggestions: Set<string> } | null>(null);
  const focusAfter = useRef<string | null>(null);
  const base = `/api/sessions/${encodeURIComponent(sessionId)}/questions`;

  const load = useCallback(async () => {
    try {
      setQuestions((await apiFetch<{ questions: Question[] }>(base)).questions);
      setError(null);
    } catch (err) {
      setError(toApiError(err, 'Could not load questions'));
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  useWorkspaceEvents((e) => {
    if (e.type === 'question' || e.type === 'done') void load();
    const acc = collecting.current;
    if (!acc) return;
    if (e.type === 'patch') acc.sections.add(e.section);
    else if (e.type === 'suggestion') acc.suggestions.add(e.suggestionId);
  });

  // Return focus to the Answer / Edit answer button after Cancel (GI-13 accessibility).
  useEffect(() => {
    if (focusAfter.current && editing === null) {
      document.getElementById(`question-action-${focusAfter.current}`)?.focus();
      focusAfter.current = null;
    }
  });

  function startEdit(q: Question) {
    setTurnError(null);
    setEditing({ id: q.id, text: q.status === 'answered' ? (q.answerText ?? '') : '' });
  }

  function cancelEdit(id: string) {
    focusAfter.current = id;
    setEditing(null);
  }

  async function send(q: Question) {
    if (!editing || editing.id !== q.id) return;
    const text = editing.text.trim();
    if (!text) return;
    setTurnError(null);
    setAnsweringId(q.id);
    setStatus('Updating the specification with your answer.');
    collecting.current = { sections: new Set(), suggestions: new Set() };
    const result = await runTurn({ path: `/questions/${encodeURIComponent(q.id)}/answer`, body: { text }, label: 'Answer', prompt: text });
    const acc = collecting.current;
    collecting.current = null;
    setAnsweringId(null);
    if (result.error?.code === 'ai_unavailable') {
      setTurnError({ message: AI_UNAVAILABLE_TEXT, correlationId: result.error.correlationId });
      setStatus(AI_UNAVAILABLE_TEXT);
      setEditing(null);
    } else if (!result.started && !result.ok) {
      // Nothing was stored: keep the text in the form so it can be resent.
      setTurnError({ message: result.error?.message ?? 'Could not send the answer', correlationId: result.error?.correlationId });
      setStatus('The answer was not sent.');
    } else {
      if (result.error) {
        setTurnError({ message: result.error.message, correlationId: result.error.correlationId });
      }
      if (result.ok && acc) {
        setResults((r) => ({ ...r, [q.id]: { sections: [...acc.sections], suggestions: acc.suggestions.size } }));
        setStatus('Answer saved and the specification updated.');
      }
      setEditing(null);
    }
    await load();
  }

  async function resolve(q: Question, reason?: string) {
    try {
      const init: { method: 'POST'; json?: unknown } = { method: 'POST' };
      if (q.status === 'open') init.json = reason ? { reason } : {};
      await apiFetch(`${base}/${encodeURIComponent(q.id)}/resolve`, init);
      setError(null);
      setStatus('Question resolved.');
      await load();
    } catch (err) {
      setError(toApiError(err, 'Could not resolve the question'));
    }
  }

  async function reopen(q: Question) {
    try {
      await apiFetch(`${base}/${encodeURIComponent(q.id)}/reopen`, { method: 'POST' });
      setError(null);
      setStatus('Question reopened.');
      await load();
    } catch (err) {
      setError(toApiError(err, 'Could not reopen the question'));
    }
  }

  const all = questions ?? [];
  const byAge = (a: Question, b: Question) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);
  const open = all.filter((q) => q.status === 'open').sort(byAge);
  const answered = all.filter((q) => q.status === 'answered');
  const resolved = all.filter(isResolved);
  const disabled = readOnly || turnInProgress;

  function renderItem(q: Question) {
    return (
      <QuestionItem
        key={q.id}
        q={q}
        disabled={disabled}
        updating={answeringId === q.id}
        result={results[q.id]}
        editing={editing}
        onStartEdit={startEdit}
        onChangeEdit={(text) => setEditing((e) => (e ? { ...e, text } : e))}
        onCancelEdit={cancelEdit}
        onSend={(item) => void send(item)}
        onResolve={resolve}
        onReopen={reopen}
      />
    );
  }

  return (
    <section aria-label="AI questions" className="space-y-2">
      <h2 className="text-sm font-medium">
        Questions · {open.length} open · {answered.length} answered
      </h2>
      <div role="status" aria-live="polite" className="sr-only">
        {status}
      </div>
      {error ? <ErrorBanner message={error.message} correlationId={error.correlationId} /> : null}
      {turnError ? <ErrorBanner message={turnError.message} correlationId={turnError.correlationId} /> : null}
      {questions === null ? null : questions.length === 0 ? (
        <p className="text-sm text-slate-600">No questions yet.</p>
      ) : (
        <>
          {open.length > 0 ? (
            <div role="group" aria-labelledby="questions-open-heading" className="space-y-1">
              <h3 id="questions-open-heading" className="text-xs font-medium text-slate-700">
                Open ({open.length})
              </h3>
              <ul className="space-y-1">{open.map(renderItem)}</ul>
            </div>
          ) : null}
          {answered.length > 0 ? (
            <div role="group" aria-labelledby="questions-answered-heading" className="space-y-1">
              <h3 id="questions-answered-heading" className="text-xs font-medium text-slate-700">
                Answered — awaiting resolve ({answered.length})
              </h3>
              <ul className="space-y-1">{answered.map(renderItem)}</ul>
            </div>
          ) : null}
          {resolved.length > 0 ? (
            <div role="group" aria-labelledby="questions-resolved-heading" className="space-y-1">
              <h3 id="questions-resolved-heading" className="text-xs font-medium text-slate-700">
                <button
                  type="button"
                  aria-expanded={showResolved}
                  aria-controls="questions-resolved-list"
                  onClick={() => setShowResolved((v) => !v)}
                  className="underline"
                >
                  Resolved ({resolved.length})
                </button>
              </h3>
              {showResolved ? (
                <ul id="questions-resolved-list" className="space-y-1">
                  {resolved.map(renderItem)}
                </ul>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
