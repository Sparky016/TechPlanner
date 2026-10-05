'use client';

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner } from '@/components/ErrorBanner';
import { useWorkspace, useWorkspaceEvents } from '@/components/workspace/WorkspaceProvider';
import { ApiError, apiFetch } from '@/lib/api/client';

// AI questions (open, answered, dismissed) with dismiss-with-reason (SR-3.6). Refreshes on streamed question
// events and at the end of each turn (answered transitions are not streamed).

interface Question {
  id: string;
  issueId: string | null;
  section: string | null;
  text: string;
  status: 'open' | 'answered' | 'dismissed';
  dismissReason: string | null;
  createdAt: string;
}

const STATUS_LABEL: Record<Question['status'], string> = { open: 'Open', answered: 'Answered', dismissed: 'Dismissed' };
const STATUS_CLASS: Record<Question['status'], string> = {
  open: 'bg-blue-100 text-blue-900',
  answered: 'bg-green-100 text-green-900',
  dismissed: 'bg-slate-200 text-slate-700',
};

function toApiError(err: unknown, fallback: string): ApiError {
  return err instanceof ApiError ? err : new ApiError(fallback, 0, undefined, undefined, null);
}

function QuestionItem({ q, onDismiss, readOnly }: { q: Question; onDismiss: (reason: string) => Promise<void>; readOnly: boolean }) {
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const reasonId = `dismiss-reason-${q.id}`;

  return (
    <li data-status={q.status} className="rounded border border-slate-200 bg-white px-2 py-1 text-sm">
      <div className="flex items-start justify-between gap-2">
        <p className="whitespace-pre-wrap break-words">{q.text}</p>
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${STATUS_CLASS[q.status] ?? ''}`}>
          {STATUS_LABEL[q.status] ?? q.status}
        </span>
      </div>
      {q.section ? <p className="text-xs text-slate-500">Section: {q.section}</p> : null}
      {q.status === 'dismissed' && q.dismissReason ? (
        <p className="text-xs text-slate-600">Reason: {q.dismissReason}</p>
      ) : null}
      {q.status === 'open' ? (
        dismissing ? (
          <form
            className="mt-1 flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              void onDismiss(reason).finally(() => setBusy(false));
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
                disabled={readOnly}
                className="w-full rounded border border-slate-300 px-1 py-0.5 text-xs"
              />
            </div>
            <button
              type="submit"
              disabled={readOnly || busy}
              className="rounded border border-slate-400 px-2 py-0.5 text-xs hover:bg-slate-100 disabled:opacity-60"
            >
              Confirm dismiss
            </button>
            <button type="button" onClick={() => setDismissing(false)} className="px-1 text-xs underline">
              Cancel
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setDismissing(true)}
            disabled={readOnly}
            className="mt-1 rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-100 disabled:opacity-60"
          >
            Dismiss
          </button>
        )
      ) : null}
    </li>
  );
}

export function QuestionsList() {
  const { sessionId, readOnly } = useWorkspace();
  const [questions, setQuestions] = useState<Question[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
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
  });

  async function dismiss(id: string, reason: string) {
    try {
      await apiFetch(`${base}/${encodeURIComponent(id)}/dismiss`, {
        method: 'POST',
        json: reason.trim() ? { reason } : {},
      });
      setError(null);
      await load();
    } catch (err) {
      setError(toApiError(err, 'Could not dismiss the question'));
    }
  }

  return (
    <section aria-label="AI questions" className="space-y-2">
      <h2 className="text-sm font-medium">AI questions</h2>
      {error ? <ErrorBanner message={error.message} correlationId={error.correlationId} /> : null}
      {questions === null ? null : questions.length === 0 ? (
        <p className="text-sm text-slate-600">No questions yet.</p>
      ) : (
        <ul className="space-y-1">
          {questions.map((q) => (
            <QuestionItem key={q.id} q={q} readOnly={readOnly} onDismiss={(reason) => dismiss(q.id, reason)} />
          ))}
        </ul>
      )}
    </section>
  );
}
