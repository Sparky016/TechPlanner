'use client';

import { type FormEvent, useState } from 'react';
import { ErrorBanner } from '@/components/ErrorBanner';
import { useWorkspace } from '@/components/workspace/WorkspaceProvider';
import { ApiError, apiFetch } from '@/lib/api/client';

// Facilitator notes: added to the conversation as context for later turns; never start an AI turn.
export function NotesInput() {
  const { sessionId, readOnly, publish } = useWorkspace();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (text.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/notes`, { method: 'POST', json: { text } });
      setText('');
      publish({ type: 'conversation_changed' });
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError('Could not add the note', 0, undefined, undefined, null));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="space-y-1">
      <label htmlFor="note-input" className="block text-sm font-medium">
        Note <span className="text-xs font-normal text-slate-600">(context only, no AI reply)</span>
      </label>
      <textarea
        id="note-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={readOnly}
        rows={2}
        className="w-full rounded border border-dashed border-slate-400 bg-slate-50 px-2 py-1 text-sm disabled:opacity-60"
      />
      <button
        type="submit"
        disabled={readOnly || busy || text.trim() === ''}
        className="rounded border border-slate-400 px-3 py-1 text-sm hover:bg-slate-100 disabled:opacity-60"
      >
        Add note
      </button>
      {error ? <ErrorBanner message={error.message} correlationId={error.correlationId} /> : null}
    </form>
  );
}
