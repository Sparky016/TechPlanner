'use client';

import { useState } from 'react';
import { ErrorBanner } from '@/components/ErrorBanner';
import { useWorkspace } from '@/components/workspace/WorkspaceProvider';
import { SourcesList } from '@/components/workspace/left/SourcesList';
import { ApiError, apiFetch } from '@/lib/api/client';

// Session tickets and sources, with Refresh sources (SR-2.6).
export function SessionHeader() {
  const { sessionId, detail, detailError, reloadDetail, readOnly, publish } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/refresh-sources`, { method: 'POST' });
      await reloadDetail();
      // Refresh records a system message in the conversation.
      publish({ type: 'conversation_changed' });
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError('Could not refresh sources', 0, undefined, undefined, null));
    } finally {
      setBusy(false);
    }
  }

  if (!detail) {
    return detailError ? (
      <ErrorBanner message={detailError.message} correlationId={detailError.correlationId} />
    ) : (
      <p className="text-sm text-slate-600">Loading session…</p>
    );
  }

  const { session, sources } = detail;
  return (
    <section aria-label="Session" className="space-y-2">
      <div>
        <h1 className="text-lg font-semibold">{session.primaryTicketKey}</h1>
        {session.ticketKeys.length > 1 ? (
          <p className="text-sm text-slate-600">Also: {session.ticketKeys.slice(1).join(', ')}</p>
        ) : null}
      </div>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Sources</h2>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={readOnly || busy}
          className="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-100 disabled:opacity-60"
        >
          {busy ? 'Refreshing…' : 'Refresh sources'}
        </button>
      </div>
      {error ? <ErrorBanner message={error.message} correlationId={error.correlationId} /> : null}
      <SourcesList sources={sources} />
    </section>
  );
}
