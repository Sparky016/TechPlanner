'use client';

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner } from '@/components/ErrorBanner';
import { useWorkspace } from '@/components/workspace/WorkspaceProvider';
import { OverrideDialog, type OpenCriticalIssue } from '@/components/workspace/right/OverrideDialog';
import { ApiError, apiFetch } from '@/lib/api/client';

// Publish (SR-13.1, SR-13.3): starts a publish run, opens the Override dialog when the gate fails (409 gate_failed),
// shows per-step status polled every 2 s until the run finishes, and retries failed steps. A Confluence page edited
// outside Tech Planner (page_changed_externally) offers Overwrite or Cancel, passed on retry as confluenceAction.

export const PUBLISH_POLL_MS = 2_000;

type StepStatus = 'pending' | 'running' | 'success' | 'failed' | 'waiting' | 'cancelled';

interface StepState {
  name: string;
  status: StepStatus;
  attempts: number;
  lastError: { code: string; message: string } | null;
}

export interface PublishRun {
  id: string;
  revisionNumber: number;
  status: 'running' | 'completed' | 'failed';
  steps: StepState[];
}

const STEP_LABEL: Record<string, string> = {
  confluence: 'Confluence page',
  jira_attach: 'Jira attachment',
  jira_description: 'Jira description',
  jira_comment: 'Jira comment',
  jira_label: 'Jira label',
  downstream: 'Downstream notification',
};
const STEP_STATUS_LABEL: Record<StepStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  success: 'Success',
  failed: 'Failed',
  waiting: 'Waiting',
  cancelled: 'Cancelled',
};
const STEP_STATUS_CLASS: Record<StepStatus, string> = {
  pending: 'bg-slate-100 text-slate-700',
  running: 'bg-blue-100 text-blue-900',
  success: 'bg-green-100 text-green-900',
  failed: 'bg-red-100 text-red-900',
  waiting: 'bg-amber-100 text-amber-900',
  cancelled: 'bg-slate-200 text-slate-700',
};
const RUN_STATUS_LABEL: Record<PublishRun['status'], string> = {
  running: 'Publishing…',
  completed: 'Published',
  failed: 'Publish failed',
};

function toApiError(err: unknown, fallback: string): ApiError {
  return err instanceof ApiError ? err : new ApiError(fallback, 0, undefined, undefined, null);
}

function latestRunId(publish: unknown): string | null {
  const run = (publish as { latestRun?: { id?: unknown } | null } | null)?.latestRun;
  return typeof run?.id === 'string' ? run.id : null;
}

export function PublishPanel() {
  const { sessionId, readOnly, detail, reloadDetail } = useWorkspace();
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<PublishRun | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [override, setOverride] = useState<OpenCriticalIssue[] | null>(null);
  const [overrideError, setOverrideError] = useState<ApiError | null>(null);
  const base = `/api/sessions/${encodeURIComponent(sessionId)}/publish`;

  // Show the session's latest run once the detail arrives (e.g. after a reload mid-publish).
  const initialRunId = latestRunId(detail?.publish);
  useEffect(() => {
    if (initialRunId) setRunId((current) => current ?? initialRunId);
  }, [initialRunId]);

  const loadRun = useCallback(
    async (id: string) => {
      try {
        const next = (await apiFetch<{ run: PublishRun }>(`${base}/${encodeURIComponent(id)}`)).run;
        setRun(next);
        setError(null);
        if (next.status !== 'running') void reloadDetail();
      } catch (err) {
        setError(toApiError(err, 'Could not load the publish status'));
      }
    },
    [base, reloadDetail],
  );

  useEffect(() => {
    if (runId) void loadRun(runId);
  }, [runId, loadRun]);

  const running = run?.status === 'running';
  useEffect(() => {
    if (!runId || !running) return;
    const timer = setInterval(() => void loadRun(runId), PUBLISH_POLL_MS);
    return () => clearInterval(timer);
  }, [runId, running, loadRun]);

  async function startPublish(body: Record<string, unknown>, fromDialog: boolean) {
    setBusy(true);
    try {
      const res = await apiFetch<{ runId: string }>(base, { method: 'POST', json: body });
      setError(null);
      setOverride(null);
      setOverrideError(null);
      setRun(null);
      setRunId(res.runId);
    } catch (err) {
      const apiErr = toApiError(err, 'Could not start publishing');
      if (apiErr.status === 409 && apiErr.code === 'gate_failed') {
        const issues = (apiErr.body as { openCriticalIssues?: OpenCriticalIssue[] } | null)?.openCriticalIssues ?? [];
        setOverride(issues);
        // A failed gate from inside the dialog means the justification was rejected or the issues changed.
        setOverrideError(fromDialog ? apiErr : null);
      } else if (fromDialog) {
        setOverrideError(apiErr);
      } else {
        setError(apiErr);
      }
    } finally {
      setBusy(false);
    }
  }

  async function retry(confluenceAction?: 'overwrite' | 'cancel') {
    if (!runId) return;
    setBusy(true);
    try {
      await apiFetch(`${base}/${encodeURIComponent(runId)}/retry`, {
        method: 'POST',
        json: confluenceAction ? { confluenceAction } : {},
      });
      setError(null);
      await loadRun(runId);
    } catch (err) {
      setError(toApiError(err, 'Could not retry publishing'));
    } finally {
      setBusy(false);
    }
  }

  const failed = run?.status === 'failed';
  const confluenceConflict = failed
    ? run.steps.find((s) => s.name === 'confluence' && s.status === 'failed' && s.lastError?.code === 'page_changed_externally')
    : undefined;

  return (
    <section aria-label="Publish" className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Publish</h2>
        <button
          type="button"
          disabled={readOnly || busy || running}
          onClick={() => void startPublish({}, false)}
          className="rounded bg-blue-700 px-3 py-1 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-60"
        >
          Publish
        </button>
      </div>
      {error ? <ErrorBanner message={error.message} correlationId={error.correlationId} /> : null}

      {run ? (
        <div className="space-y-2">
          <p role="status" className="text-sm">
            {RUN_STATUS_LABEL[run.status] ?? run.status} (revision {run.revisionNumber})
          </p>
          <ol aria-label="Publish steps" className="space-y-1">
            {run.steps.map((s) => (
              <li key={s.name} data-step={s.name} className="rounded border border-slate-200 bg-white px-2 py-1 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span>{STEP_LABEL[s.name] ?? s.name}</span>
                  <span className={`rounded px-1.5 py-0.5 text-xs ${STEP_STATUS_CLASS[s.status] ?? ''}`}>
                    {STEP_STATUS_LABEL[s.status] ?? s.status}
                  </span>
                </div>
                {s.status === 'failed' && s.lastError ? (
                  <p className="whitespace-pre-wrap break-words text-xs text-red-800">{s.lastError.message}</p>
                ) : null}
              </li>
            ))}
          </ol>

          {confluenceConflict ? (
            <div className="space-y-2 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
              <p>The Confluence page was changed outside Tech Planner. Overwrite it, or cancel the Confluence update?</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={readOnly || busy}
                  onClick={() => void retry('overwrite')}
                  className="rounded border border-amber-600 px-2 py-0.5 text-xs hover:bg-amber-100 disabled:opacity-60"
                >
                  Overwrite
                </button>
                <button
                  type="button"
                  disabled={readOnly || busy}
                  onClick={() => void retry('cancel')}
                  className="rounded border border-amber-600 px-2 py-0.5 text-xs hover:bg-amber-100 disabled:opacity-60"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : failed ? (
            <button
              type="button"
              disabled={readOnly || busy}
              onClick={() => void retry()}
              className="rounded border border-slate-400 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-60"
            >
              Retry failed steps
            </button>
          ) : null}
        </div>
      ) : null}

      {override ? (
        <OverrideDialog
          issues={override}
          busy={busy || readOnly}
          error={overrideError}
          onConfirm={(input) => void startPublish(input, true)}
          onClose={() => {
            setOverride(null);
            setOverrideError(null);
          }}
        />
      ) : null}
    </section>
  );
}
