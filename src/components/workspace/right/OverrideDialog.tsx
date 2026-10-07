'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ErrorBanner } from '@/components/ErrorBanner';
import type { ApiError } from '@/lib/api/client';

// Readiness gate Override (SR-9.1): lists the open critical issues and requires a justification of at least 20
// characters plus an explicit confirmation before publishing anyway. Modal with focus trap; Escape closes (NFR-10).

export const MIN_JUSTIFICATION_LENGTH = 20;

export interface OpenCriticalIssue {
  id: string;
  section: string;
  description: string;
}

const FOCUSABLE = 'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function OverrideDialog({
  issues,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  issues: OpenCriticalIssue[];
  busy: boolean;
  error: ApiError | null;
  onConfirm: (input: { overrideJustification: string; confirmOverride: true }) => void;
  onClose: () => void;
}) {
  const [justification, setJustification] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus the justification on open and restore focus to the opener on close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    textareaRef.current?.focus();
    return () => opener?.focus();
  }, []);

  const valid = justification.trim().length >= MIN_JUSTIFICATION_LENGTH && confirmed;

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="override-title"
        aria-describedby="override-desc"
        onKeyDown={onKeyDown}
        className="w-full max-w-lg space-y-4 rounded bg-white p-6 shadow-lg"
      >
        <h2 id="override-title" className="text-lg font-semibold">
          Publish with override
        </h2>
        <p id="override-desc" className="text-sm">
          The readiness gate failed. These critical issues are still open:
        </p>
        <ul className="max-h-48 list-disc space-y-1 overflow-y-auto pl-5 text-sm">
          {issues.map((i) => (
            <li key={i.id} className="whitespace-pre-wrap break-words">
              <span className="font-medium">{i.section}:</span> {i.description}
            </li>
          ))}
        </ul>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && !busy) onConfirm({ overrideJustification: justification.trim(), confirmOverride: true });
          }}
        >
          <div>
            <label htmlFor="override-justification" className="block text-sm font-medium">
              Justification (at least {MIN_JUSTIFICATION_LENGTH} characters)
            </label>
            <textarea
              id="override-justification"
              ref={textareaRef}
              value={justification}
              onChange={(e) => setJustification(e.target.value)}
              rows={3}
              maxLength={5000}
              className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
            />
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-1" />
            <span>I confirm publishing with the critical issues listed above still open.</span>
          </label>
          {error ? <ErrorBanner message={error.message} correlationId={error.correlationId} /> : null}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded border border-slate-300 px-3 py-1 text-sm hover:bg-slate-100">
              Cancel
            </button>
            <button
              type="submit"
              disabled={!valid || busy}
              className="rounded bg-red-700 px-3 py-1 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-60"
            >
              Publish with override
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
