'use client';

import { useState } from 'react';
import { ErrorBanner } from '@/components/ErrorBanner';
import { ApiError, apiFetch } from '@/lib/api/client';

// First-login data-handling notice (NFR-7). Shown until acknowledged; the acknowledgement is persisted.
// FOR REVIEW: wording is a placeholder pending sign-off (task 32 knowledge gap).
export function DataNotice({ acknowledged }: { acknowledged: boolean }) {
  const [done, setDone] = useState(acknowledged);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  if (done) return null;

  async function acknowledge() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/api/me/ack-data-notice', { method: 'POST' });
      setDone(true);
    } catch (err) {
      setError(
        err instanceof ApiError ? err : new ApiError('Could not save acknowledgement', 0, undefined, undefined, null),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="data-notice-title"
        className="w-full max-w-lg space-y-4 rounded bg-white p-6 shadow-lg"
      >
        <h2 id="data-notice-title" className="text-lg font-semibold">
          How your data is handled
        </h2>
        <p className="text-sm">
          Jira ticket and Confluence content you use in Tech Planner is sent to GitHub Copilot for processing, under
          your organisation&apos;s Copilot terms. Do not add content that you are not permitted to share with it.
        </p>
        {error ? <ErrorBanner message={error.message} correlationId={error.correlationId} /> : null}
        <button
          type="button"
          onClick={acknowledge}
          disabled={busy}
          autoFocus
          className="rounded bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-60"
        >
          I understand
        </button>
      </div>
    </div>
  );
}
