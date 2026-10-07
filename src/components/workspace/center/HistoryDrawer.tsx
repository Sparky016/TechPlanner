'use client';

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner } from '@/components/ErrorBanner';
import { ApiError, apiFetch } from '@/lib/api/client';
import { RevisionDiff, type SectionDiff } from './RevisionDiff';

// Version history drawer (§6, SR-11.2-SR-11.4): revisions newest first, compare any two, and non-destructive
// restore behind a confirmation. Restore is a mutating action, so it is disabled when readOnly.

interface RevisionItem {
  number: number;
  createdAt: string;
  author: { accountId: string | null; displayName: string | null };
  trigger: 'save' | 'restore' | 'publish';
  readinessScore: number | null;
  published: boolean;
}

interface Comparison {
  a: number;
  b: number;
  sections: SectionDiff[];
}

function toApiError(err: unknown, fallback: string): ApiError {
  return err instanceof ApiError ? err : new ApiError(fallback, 0, undefined, undefined, null);
}

export function HistoryDrawer({
  sessionId,
  readOnly,
  onClose,
  beforeRestore,
  onRestored,
}: {
  sessionId: string;
  readOnly: boolean;
  onClose: () => void;
  /** Runs before the restore request, e.g. to flush pending autosaves so they cannot overwrite the restore. */
  beforeRestore?: () => Promise<void>;
  /** Runs after a successful restore so the editor reloads the working copy. */
  onRestored: () => Promise<void> | void;
}) {
  const base = `/api/sessions/${encodeURIComponent(sessionId)}/revisions`;
  const [revisions, setRevisions] = useState<RevisionItem[] | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const loadRevisions = useCallback(async () => {
    try {
      const res = await apiFetch<{ revisions: RevisionItem[] }>(base);
      setRevisions([...res.revisions].sort((x, y) => y.number - x.number));
      setError(null);
    } catch (err) {
      setError(toApiError(err, 'Could not load the revision history'));
    }
  }, [base]);

  useEffect(() => {
    void loadRevisions();
  }, [loadRevisions]);

  function toggle(n: number) {
    setComparison(null);
    setSelected((cur) => (cur.includes(n) ? cur.filter((x) => x !== n) : cur.length >= 2 ? [cur[1], n] : [...cur, n]));
  }

  async function compare() {
    if (selected.length !== 2) return;
    const [a, b] = [...selected].sort((x, y) => x - y);
    setBusy(true);
    try {
      setComparison(await apiFetch<Comparison>(`${base}/compare?a=${a}&b=${b}`));
      setError(null);
    } catch (err) {
      setError(toApiError(err, 'Could not compare the revisions'));
    } finally {
      setBusy(false);
    }
  }

  async function restore(n: number) {
    setBusy(true);
    try {
      await beforeRestore?.();
      const res = await apiFetch<{ number: number }>(`${base}/${n}/restore`, { method: 'POST' });
      setConfirming(null);
      setError(null);
      setMessage(`Revision ${n} restored as revision ${res.number}`);
      await onRestored();
      await loadRevisions();
    } catch (err) {
      setConfirming(null);
      setError(toApiError(err, 'Could not restore the revision'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside aria-label="Version history" className="space-y-3 rounded border border-slate-300 bg-slate-50 p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Version history</h3>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy || selected.length !== 2}
            onClick={() => void compare()}
            className="rounded border border-slate-400 px-2 py-0.5 text-xs font-medium hover:bg-slate-100 disabled:opacity-60"
          >
            Compare selected
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-slate-400 px-2 py-0.5 text-xs font-medium hover:bg-slate-100"
          >
            Close
          </button>
        </div>
      </div>
      {message ? (
        <p role="status" className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-900">
          {message}
        </p>
      ) : null}
      {error ? <ErrorBanner message={error.message} correlationId={error.correlationId} /> : null}
      {revisions === null ? (
        error ? null : <p className="text-xs text-slate-600">Loading revisions...</p>
      ) : revisions.length === 0 ? (
        <p className="text-xs text-slate-600">No revisions yet.</p>
      ) : (
        <ul aria-label="Revisions" className="space-y-1">
          {revisions.map((r) => (
            <li key={r.number} className="flex items-center gap-2 rounded border border-slate-200 bg-white px-2 py-1 text-xs">
              <input
                type="checkbox"
                aria-label={`Select revision ${r.number}`}
                checked={selected.includes(r.number)}
                onChange={() => toggle(r.number)}
              />
              <span className="font-medium">Revision {r.number}</span>
              <time dateTime={r.createdAt}>{new Date(r.createdAt).toLocaleString()}</time>
              <span>{r.author.displayName ?? 'Unknown author'}</span>
              <span>{r.trigger}</span>
              <span>{r.readinessScore === null ? 'Score: n/a' : `Score: ${r.readinessScore}`}</span>
              {r.published ? <span className="rounded bg-blue-100 px-1.5 text-blue-900">Published</span> : null}
              <button
                type="button"
                disabled={readOnly || busy}
                aria-label={`Restore revision ${r.number}`}
                onClick={() => setConfirming(r.number)}
                className="ml-auto rounded border border-slate-400 px-2 py-0.5 font-medium hover:bg-slate-100 disabled:opacity-60"
              >
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}
      {comparison ? <RevisionDiff a={comparison.a} b={comparison.b} sections={comparison.sections} /> : null}
      {confirming !== null ? (
        <div role="dialog" aria-modal="true" aria-label="Confirm restore" className="space-y-2 rounded border border-amber-400 bg-amber-50 p-3 text-sm">
          <p>
            Restore revision {confirming}? This replaces the working copy with that revision and records the result as a new
            revision. Existing revisions are kept.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void restore(confirming)}
              className="rounded border border-slate-600 px-3 py-1 text-xs font-medium hover:bg-slate-100 disabled:opacity-60"
            >
              Confirm restore
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirming(null)}
              className="rounded border border-slate-400 px-3 py-1 text-xs font-medium hover:bg-slate-100"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
