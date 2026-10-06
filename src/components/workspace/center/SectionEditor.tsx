'use client';

import { markdown } from '@codemirror/lang-markdown';
import CodeMirror, { EditorView } from '@uiw/react-codemirror';
import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { ErrorBanner } from '@/components/ErrorBanner';
import { ApiError } from '@/lib/api/client';
import type { SectionStatus } from '@/lib/readiness/types';
import type { SectionName } from '@/lib/spec/sections';
import { PendingSuggestion, type Suggestion } from './PendingSuggestion';
import { type AutosaveFn, useAutosave } from './useAutosave';

// One collapsible Working Copy section: status badge, CodeMirror markdown editor with a rendered preview toggle
// (react-markdown without rehype-raw, so raw HTML in the body is never rendered),
// autosave indicator, version-conflict choice (SR-4.3) and the section's pending AI suggestions.

const STATUS_LABEL: Record<SectionStatus, string> = { complete: 'Complete', partial: 'Partial', missing: 'Missing' };
const STATUS_CLASS: Record<SectionStatus, string> = {
  complete: 'bg-green-100 text-green-900',
  partial: 'bg-amber-100 text-amber-900',
  missing: 'bg-red-100 text-red-900',
};

/** Text label first (NFR-10: never color alone). */
export function StatusBadge({ status }: { status: SectionStatus | null }) {
  return (
    <span data-status={status ?? 'none'} className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${status ? STATUS_CLASS[status] : 'bg-slate-200 text-slate-700'}`}>
      {status ? STATUS_LABEL[status] : 'Not evaluated'}
    </span>
  );
}

export interface SectionEditorProps {
  sessionId: string;
  name: SectionName;
  /** Server body. Local text is replaced with it only when resetKey changes. */
  body: string;
  resetKey: number;
  status: SectionStatus | null;
  highlighted: boolean;
  readOnly: boolean;
  suggestions: Suggestion[];
  save: AutosaveFn;
  /** Refetch the working copy and replace this section's local text with the server body. */
  onReload: () => Promise<void>;
  /** Refetch the working copy for its current version without touching local text. */
  onRefreshVersion: () => Promise<void>;
  onSuggestionDecided: (accepted: boolean) => void;
  registerFlush?: (flush: () => Promise<void>) => () => void;
}

function isConflict(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'version_conflict';
}

export function SectionEditor(props: SectionEditorProps) {
  const { name, body, resetKey, status, highlighted, readOnly, suggestions, save, registerFlush } = props;
  const [text, setText] = useState(body);
  const [seenKey, setSeenKey] = useState(resetKey);
  const [open, setOpen] = useState(true);
  const [seenHighlight, setSeenHighlight] = useState(highlighted);
  const [preview, setPreview] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<ApiError | null>(null);

  const autosave = useAutosave(async (value, opts) => {
    try {
      await save(value, opts);
    } catch (err) {
      if (isConflict(err)) setConflict(true);
      throw err;
    }
  }, !readOnly && !conflict);
  const { cancel, flush } = autosave;

  // Server-driven replacement (AI patch, accepted suggestion, reload): take the server body.
  if (seenKey !== resetKey) {
    setSeenKey(resetKey);
    setText(body);
    setConflict(false);
  }
  if (seenHighlight !== highlighted) {
    setSeenHighlight(highlighted);
    if (highlighted) setOpen(true);
  }
  useEffect(() => cancel(), [resetKey, cancel]);
  useEffect(() => registerFlush?.(flush), [registerFlush, flush]);

  async function resolve(action: 'reload' | 'overwrite') {
    setResolving(true);
    try {
      if (action === 'reload') {
        await props.onReload();
      } else {
        await props.onRefreshVersion();
        await save(text);
      }
      setConflict(false);
      setResolveError(null);
    } catch (err) {
      setResolveError(err instanceof ApiError ? err : new ApiError('Could not resolve the conflict', 0, undefined, undefined, null));
    } finally {
      setResolving(false);
    }
  }

  // The label goes on CodeMirror's contenteditable (the actual textbox), not its wrapper div.
  const extensions = useMemo(
    () => [markdown(), EditorView.lineWrapping, EditorView.contentAttributes.of({ 'aria-label': `${name} content` })],
    [name],
  );

  const contentId = `section-${name}`.replace(/[^a-zA-Z0-9-]/g, '-');
  // A version conflict is reported by the conflict choice, not as a save failure.
  const failed = autosave.status === 'error' && !isConflict(autosave.error);
  const saveError = failed && autosave.error instanceof ApiError ? autosave.error : null;
  const indicator = autosave.status === 'saving' ? 'Saving…' : autosave.status === 'saved' ? 'Saved' : failed ? 'Save failed' : '';

  return (
    <section
      aria-label={name}
      data-section={name}
      data-highlighted={highlighted ? 'true' : 'false'}
      className={`rounded border p-2 transition-colors ${highlighted ? 'border-amber-400 bg-amber-50 ring-2 ring-amber-300' : 'border-slate-200 bg-white'}`}
    >
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => setOpen((o) => !o)}
          className="flex-1 text-left text-sm font-medium"
        >
          <span aria-hidden="true">{open ? '▾' : '▸'} </span>
          <h3 className="inline">{name}</h3>
        </button>
        {highlighted ? <span className="text-xs text-amber-900">Updated by AI</span> : null}
        {suggestions.length > 0 ? <span className="text-xs text-violet-900">{suggestions.length} pending</span> : null}
        <span aria-live="polite" className="text-xs text-slate-500">
          {indicator}
        </span>
        <StatusBadge status={status} />
      </div>
      {conflict ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
          <span className="flex-1">Updated elsewhere. Your text is kept below.</span>
          <button
            type="button"
            disabled={resolving}
            onClick={() => void resolve('reload')}
            className="rounded border border-amber-600 px-2 py-0.5 text-xs hover:bg-amber-100 disabled:opacity-60"
          >
            Reload
          </button>
          <button
            type="button"
            disabled={resolving || readOnly}
            onClick={() => void resolve('overwrite')}
            className="rounded border border-amber-600 px-2 py-0.5 text-xs hover:bg-amber-100 disabled:opacity-60"
          >
            Overwrite
          </button>
        </div>
      ) : null}
      {resolveError ? <ErrorBanner message={resolveError.message} correlationId={resolveError.correlationId} /> : null}
      {saveError ? <ErrorBanner message={saveError.message} correlationId={saveError.correlationId} /> : null}
      {open ? (
        <div id={contentId} className="mt-2 space-y-2">
          <div className="flex justify-end">
            <button type="button" onClick={() => setPreview((p) => !p)} className="text-xs underline">
              {preview ? 'Edit' : 'Preview'}
            </button>
          </div>
          {preview ? (
            <div aria-label={`${name} preview`} className="break-words rounded border border-slate-200 bg-slate-50 p-2 text-sm">
              <ReactMarkdown>{text}</ReactMarkdown>
            </div>
          ) : (
            <CodeMirror
              value={text}
              extensions={extensions}
              editable={!readOnly}
              readOnly={readOnly}
              indentWithTab={false} // Tab must leave the editor, or keyboard users are trapped (WCAG 2.1.2).
              basicSetup={{ lineNumbers: false, foldGutter: false }}
              onChange={(value) => {
                setText(value);
                autosave.schedule(value);
              }}
              onBlur={() => void flush()}
              className="overflow-hidden rounded border border-slate-300 text-sm"
            />
          )}
          {suggestions.map((s) => (
            <PendingSuggestion
              key={s.id}
              sessionId={props.sessionId}
              suggestion={s}
              currentBody={body}
              readOnly={readOnly}
              onDecided={props.onSuggestionDecided}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
