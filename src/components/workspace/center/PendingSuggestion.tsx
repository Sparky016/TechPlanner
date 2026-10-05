'use client';

import { diffLines } from 'diff';
import { useState } from 'react';
import { ErrorBanner } from '@/components/ErrorBanner';
import { ApiError, apiFetch } from '@/lib/api/client';

// An AI patch held back because the facilitator edited the section after the AI read it (SR-4.4). Shows the
// change as a line diff against the current section body, with Accept, Edit & accept and Reject. Plain text only.

export interface Suggestion {
  id: string;
  section: string;
  patch: unknown;
  createdAt: string;
}

interface SuggestionPatch {
  op: 'replace' | 'append';
  content: string;
}

function readPatch(patch: unknown): SuggestionPatch | null {
  const p = patch as { op?: unknown; content?: unknown } | null;
  if (!p || typeof p.content !== 'string' || (p.op !== 'replace' && p.op !== 'append')) return null;
  return { op: p.op, content: p.content };
}

/** Mirrors the server's applyPatchToBody: replace -> content; append -> body + '\n' (if non-empty) + content. */
function proposedBody(body: string, patch: SuggestionPatch): string {
  if (patch.op === 'replace') return patch.content;
  return body + (body ? '\n' : '') + patch.content;
}

function toApiError(err: unknown, fallback: string): ApiError {
  return err instanceof ApiError ? err : new ApiError(fallback, 0, undefined, undefined, null);
}

function DiffView({ before, after }: { before: string; after: string }) {
  return (
    <pre aria-label="Suggested change" className="max-h-64 overflow-auto rounded border border-slate-200 bg-white text-xs">
      {diffLines(before, after).map((part, i) => {
        const prefix = part.added ? '+ ' : part.removed ? '- ' : '  ';
        const cls = part.added ? 'bg-green-50 text-green-900' : part.removed ? 'bg-red-50 text-red-900 line-through' : 'text-slate-600';
        const lines = part.value.replace(/\n$/, '').split('\n');
        return (
          <span key={i} className={`block whitespace-pre-wrap break-words px-2 ${cls}`}>
            {lines.map((l) => prefix + l).join('\n')}
          </span>
        );
      })}
    </pre>
  );
}

export function PendingSuggestion({
  sessionId,
  suggestion,
  currentBody,
  readOnly,
  onDecided,
}: {
  sessionId: string;
  suggestion: Suggestion;
  currentBody: string;
  readOnly: boolean;
  onDecided: (accepted: boolean) => void;
}) {
  const patch = readPatch(suggestion.patch);
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState(patch?.content ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [decided, setDecided] = useState(false);
  const base = `/api/sessions/${encodeURIComponent(sessionId)}/suggestions/${encodeURIComponent(suggestion.id)}`;

  if (decided) return null;

  async function decide(action: 'accept' | 'reject', json?: { editedContent?: string }) {
    setBusy(true);
    try {
      // Reject takes no body; plain accept sends {} (no editedContent).
      await apiFetch(`${base}/${action}`, action === 'accept' ? { method: 'POST', json: json ?? {} } : { method: 'POST' });
      setError(null);
      setDecided(true);
      onDecided(action === 'accept');
    } catch (err) {
      setError(toApiError(err, `Could not ${action} the suggestion`));
    } finally {
      setBusy(false);
    }
  }

  const editId = `suggestion-edit-${suggestion.id}`;
  return (
    <div data-suggestion={suggestion.id} className="space-y-2 rounded border border-violet-300 bg-violet-50 p-2 text-sm">
      <p className="text-xs font-medium text-violet-900">
        AI suggestion{patch ? ` (${patch.op === 'replace' ? 'replace section' : 'append to section'})` : ''}
      </p>
      {error ? <ErrorBanner message={error.message} correlationId={error.correlationId} /> : null}
      {patch ? (
        editing ? (
          <div className="space-y-1">
            <label htmlFor={editId} className="block text-xs">
              Edit suggested content
            </label>
            <textarea
              id={editId}
              value={edited}
              onChange={(e) => setEdited(e.target.value)}
              disabled={readOnly}
              rows={6}
              className="w-full rounded border border-slate-300 p-1 font-mono text-xs"
            />
          </div>
        ) : (
          <DiffView before={currentBody} after={proposedBody(currentBody, patch)} />
        )
      ) : (
        <p className="text-xs text-slate-600">This suggestion cannot be displayed.</p>
      )}
      <div className="flex flex-wrap gap-2">
        {editing ? (
          <>
            <button
              type="button"
              disabled={readOnly || busy}
              onClick={() => void decide('accept', { editedContent: edited })}
              className="rounded border border-violet-600 px-2 py-0.5 text-xs hover:bg-violet-100 disabled:opacity-60"
            >
              Accept edited
            </button>
            <button type="button" onClick={() => setEditing(false)} className="px-1 text-xs underline">
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={readOnly || busy || !patch}
              onClick={() => void decide('accept')}
              className="rounded border border-violet-600 px-2 py-0.5 text-xs hover:bg-violet-100 disabled:opacity-60"
            >
              Accept
            </button>
            <button
              type="button"
              disabled={readOnly || busy || !patch}
              onClick={() => setEditing(true)}
              className="rounded border border-slate-400 px-2 py-0.5 text-xs hover:bg-slate-100 disabled:opacity-60"
            >
              Edit &amp; accept
            </button>
            <button
              type="button"
              disabled={readOnly || busy}
              onClick={() => void decide('reject')}
              className="rounded border border-slate-400 px-2 py-0.5 text-xs hover:bg-slate-100 disabled:opacity-60"
            >
              Reject
            </button>
          </>
        )}
      </div>
    </div>
  );
}
