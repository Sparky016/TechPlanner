'use client';

import { type FormEvent, useState } from 'react';
import { ErrorBanner } from '@/components/ErrorBanner';
import { ApiError, apiFetch } from '@/lib/api/client';

function parseKeys(input: string): string[] {
  return input
    .split(/[\s,]+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

function bodyField(err: ApiError, field: string): string[] {
  const value = (err.body as Record<string, unknown> | null)?.[field];
  return Array.isArray(value) ? value.map(String) : [];
}

export default function NewSessionPage() {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [duplicateIds, setDuplicateIds] = useState<string[] | null>(null);

  async function submit(confirmDuplicate: boolean) {
    setBusy(true);
    setError(null);
    try {
      const { session } = await apiFetch<{ session: { id: string } }>('/api/sessions', {
        method: 'POST',
        json: { ticketKeys: parseKeys(input), ...(confirmDuplicate ? { confirmDuplicate: true } : {}) },
      });
      window.location.assign(`/sessions/${session.id}`);
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : new ApiError('Could not create the session', 0, undefined, undefined, null);
      if (apiErr.status === 409) {
        setDuplicateIds(bodyField(apiErr, 'existingSessionIds'));
      } else {
        setDuplicateIds(null);
        setError(apiErr);
      }
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setDuplicateIds(null);
    void submit(false);
  }

  const unreadable = error?.status === 422 ? bodyField(error, 'unreadable') : [];
  const invalid = error?.status === 400 ? bodyField(error, 'invalidKeys') : [];

  return (
    <section className="max-w-xl space-y-4">
      <h1 className="text-xl font-semibold">New session</h1>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label htmlFor="ticket-keys" className="block text-sm font-medium">
            Jira ticket keys
          </label>
          <p id="ticket-keys-help" className="text-xs text-slate-600">
            Separate keys with commas, spaces or new lines. The first key is the primary ticket.
          </p>
          <textarea
            id="ticket-keys"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            aria-describedby="ticket-keys-help"
            rows={3}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
            placeholder="ABC-123, ABC-124"
          />
        </div>
        <button
          type="submit"
          disabled={busy || parseKeys(input).length === 0}
          className="rounded bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-60"
        >
          Create session
        </button>
      </form>

      {duplicateIds ? (
        <div role="alertdialog" aria-labelledby="dup-title" className="space-y-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm">
          <p id="dup-title" className="font-medium">
            A session already exists for this ticket.
          </p>
          <ul className="list-disc pl-5">
            {duplicateIds.map((id) => (
              <li key={id}>
                <a href={`/sessions/${id}`} className="text-blue-700 underline">
                  Open existing session
                </a>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => void submit(true)}
            disabled={busy}
            className="rounded border border-amber-600 px-3 py-1 hover:bg-amber-100 disabled:opacity-60"
          >
            Create another session anyway
          </button>
        </div>
      ) : null}

      {error ? <ErrorBanner message={error.message} correlationId={error.correlationId} /> : null}
      {unreadable.length > 0 ? (
        <div className="text-sm">
          <p>These tickets could not be read (check the key and your access):</p>
          <ul aria-label="Unreadable tickets" className="list-disc pl-5">
            {unreadable.map((k) => (
              <li key={k}>{k}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {invalid.length > 0 ? (
        <p className="text-sm">Invalid keys: {invalid.join(', ')}</p>
      ) : null}
    </section>
  );
}
