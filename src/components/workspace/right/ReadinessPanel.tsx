'use client';

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner } from '@/components/ErrorBanner';
import { useWorkspace, useWorkspaceEvents } from '@/components/workspace/WorkspaceProvider';
import { ApiError, apiFetch } from '@/lib/api/client';
import type { IssueSeverity, SectionStatus } from '@/lib/readiness/types';

// Readiness (§6 right panel, SR-6.5, SR-7.4, SR-8.2): gate status first (D-6), informational score, section
// statuses, issues by severity with Accept risk for non-critical issues, and open AI questions as action items.
// Polls every 5 s while an evaluation is pending and refreshes at the end of each AI turn.

export const READINESS_POLL_MS = 5_000;

interface Issue {
  id: string;
  severity: IssueSeverity;
  section: string;
  description: string;
  status: 'open' | 'accepted-risk' | 'resolved';
}

interface OpenQuestion {
  id: string;
  issueId: string | null;
  section: string | null;
  text: string;
}

export interface Readiness {
  score: number | null;
  statuses: Record<string, SectionStatus> | null;
  issues: Issue[];
  openQuestions: OpenQuestion[];
  gatePasses: boolean;
  clarificationEnded: boolean;
  evaluatedAt: string | null;
  evaluationPending: boolean;
}

const STATUS_CLASS: Record<SectionStatus, string> = {
  complete: 'bg-green-100 text-green-900',
  partial: 'bg-amber-100 text-amber-900',
  missing: 'bg-red-100 text-red-900',
};
const STATUS_LABEL: Record<SectionStatus, string> = { complete: 'Complete', partial: 'Partial', missing: 'Missing' };

function toApiError(err: unknown, fallback: string): ApiError {
  return err instanceof ApiError ? err : new ApiError(fallback, 0, undefined, undefined, null);
}

function IssueList({
  title,
  issues,
  readOnly,
  onAcceptRisk,
}: {
  title: string;
  issues: Issue[];
  readOnly: boolean;
  onAcceptRisk: (id: string) => Promise<void>;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  if (issues.length === 0) return null;
  return (
    <section aria-label={title} className="space-y-1">
      <h3 className="text-xs font-medium uppercase text-slate-600">
        {title} ({issues.length})
      </h3>
      <ul className="space-y-1">
        {issues.map((i) => (
          <li key={i.id} data-severity={i.severity} className="rounded border border-slate-200 bg-white px-2 py-1 text-sm">
            <p className="text-xs text-slate-500">{i.section}</p>
            <p className="whitespace-pre-wrap break-words">{i.description}</p>
            {i.severity === 'critical' ? null : i.status === 'accepted-risk' ? (
              <span className="mt-1 inline-block rounded bg-slate-200 px-1.5 py-0.5 text-xs text-slate-700">
                Accepted risk
              </span>
            ) : (
              <button
                type="button"
                disabled={readOnly || busyId === i.id}
                onClick={() => {
                  setBusyId(i.id);
                  void onAcceptRisk(i.id).finally(() => setBusyId(null));
                }}
                className="mt-1 rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-100 disabled:opacity-60"
              >
                Accept risk
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ReadinessPanel() {
  const { sessionId, readOnly, reloadDetail } = useWorkspace();
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<'evaluate' | 'end' | null>(null);
  const base = `/api/sessions/${encodeURIComponent(sessionId)}`;

  const load = useCallback(async () => {
    try {
      setReadiness(await apiFetch<Readiness>(`${base}/readiness`));
      setError(null);
    } catch (err) {
      setError(toApiError(err, 'Could not load readiness'));
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  const pending = readiness?.evaluationPending ?? false;
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void load(), READINESS_POLL_MS);
    return () => clearInterval(timer);
  }, [pending, load]);

  useWorkspaceEvents((e) => {
    if (e.type === 'done') void load();
  });

  async function run(kind: 'evaluate' | 'end', path: string, fallback: string) {
    setBusy(kind);
    try {
      await apiFetch(`${base}/${path}`, { method: 'POST' });
      setError(null);
      if (kind === 'end') void reloadDetail();
      await load();
    } catch (err) {
      setError(toApiError(err, fallback));
    } finally {
      setBusy(null);
    }
  }

  async function acceptRisk(id: string) {
    try {
      await apiFetch(`${base}/issues/${encodeURIComponent(id)}/accept-risk`, { method: 'POST' });
      setError(null);
      await load();
    } catch (err) {
      setError(toApiError(err, 'Could not accept the risk'));
    }
  }

  const issues = readiness?.issues ?? [];
  const openCritical = issues.filter((i) => i.severity === 'critical' && i.status === 'open');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const informational = issues.filter((i) => i.severity === 'informational');
  const statuses = Object.entries(readiness?.statuses ?? {});
  const missing = statuses.filter(([, s]) => s === 'missing').map(([name]) => name);

  return (
    <section aria-label="Readiness status" className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Readiness</h2>
        {readiness?.evaluationPending ? (
          <span role="status" className="text-xs text-slate-500">
            Evaluating…
          </span>
        ) : null}
      </div>
      {error ? <ErrorBanner message={error.message} correlationId={error.correlationId} /> : null}

      {readiness ? (
        <>
          <div data-testid="gate-status" className="space-y-1">
            {readiness.gatePasses ? (
              <p className="rounded bg-green-100 px-2 py-1 text-sm font-medium text-green-900">Ready</p>
            ) : (
              <p className="rounded bg-red-100 px-2 py-1 text-sm font-medium text-red-900">
                {openCritical.length} critical {openCritical.length === 1 ? 'issue' : 'issues'} open
              </p>
            )}
            <p className="text-xs text-slate-600">
              Score (informational): {readiness.score === null ? 'not evaluated' : readiness.score}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={readOnly || busy !== null}
              onClick={() => void run('evaluate', 'evaluate', 'Could not run the evaluation')}
              className="rounded border border-slate-400 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-60"
            >
              Evaluate now
            </button>
            {readiness.clarificationEnded ? (
              <span className="rounded bg-slate-200 px-2 py-1 text-xs text-slate-700">Clarification ended</span>
            ) : (
              <button
                type="button"
                disabled={readOnly || busy !== null}
                onClick={() => void run('end', 'end-clarification', 'Could not end clarification')}
                className="rounded border border-slate-400 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-60"
              >
                End clarification
              </button>
            )}
          </div>

          {missing.length > 0 ? (
            <section aria-label="Missing sections" className="space-y-1">
              <h3 className="text-xs font-medium uppercase text-slate-600">Missing sections ({missing.length})</h3>
              <p className="text-sm">{missing.join(', ')}</p>
            </section>
          ) : null}

          <IssueList title="Critical issues" issues={openCritical} readOnly={readOnly} onAcceptRisk={acceptRisk} />
          <IssueList title="Warnings" issues={warnings} readOnly={readOnly} onAcceptRisk={acceptRisk} />
          <IssueList title="Informational" issues={informational} readOnly={readOnly} onAcceptRisk={acceptRisk} />

          {readiness.openQuestions.length > 0 ? (
            <section aria-label="Action items" className="space-y-1">
              <h3 className="text-xs font-medium uppercase text-slate-600">
                Action items ({readiness.openQuestions.length})
              </h3>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {readiness.openQuestions.map((q) => (
                  <li key={q.id} className="whitespace-pre-wrap break-words">
                    {q.text}
                    {q.section ? <span className="text-xs text-slate-500"> ({q.section})</span> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {statuses.length > 0 ? (
            <section aria-label="Section status" className="space-y-1">
              <h3 className="text-xs font-medium uppercase text-slate-600">Sections</h3>
              <ul className="space-y-0.5">
                {statuses.map(([name, status]) => (
                  <li key={name} className="flex items-center justify-between gap-2 text-xs">
                    <span>{name}</span>
                    <span className={`rounded px-1.5 py-0.5 ${STATUS_CLASS[status] ?? ''}`}>
                      {STATUS_LABEL[status] ?? status}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            <p className="text-xs text-slate-600">No evaluation yet.</p>
          )}
        </>
      ) : null}
    </section>
  );
}
