'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorBanner } from '@/components/ErrorBanner';
import { useWorkspace, useWorkspaceEvents } from '@/components/workspace/WorkspaceProvider';
import { ApiError, apiFetch } from '@/lib/api/client';
import type { SectionStatus } from '@/lib/readiness/types';
import { SECTION_NAMES, type SectionName, sectionSlug } from '@/lib/spec/sections';
import type { Suggestion } from './PendingSuggestion';
import { SectionEditor } from './SectionEditor';

// Center panel (§6): the 27 Working Copy sections in SECTION_NAMES order, live AI patch highlighting, pending
// suggestions and Save Draft. The working copy version is shared by all sections, so every section save goes
// through one serialized chain that always sends the latest known version.

export const PATCH_HIGHLIGHT_MS = 3_000;
const DRAFT_MESSAGE_MS = 5_000;

interface WorkingCopy {
  version: number;
  sections: Record<string, { body: string; lastUserEditAt: string | null }>;
  pendingSuggestions: Suggestion[];
}

interface Readiness {
  statuses: Partial<Record<string, SectionStatus>> | null;
}

function toApiError(err: unknown, fallback: string): ApiError {
  return err instanceof ApiError ? err : new ApiError(fallback, 0, undefined, undefined, null);
}

export function SpecEditor() {
  const { sessionId, readOnly } = useWorkspace();
  const base = `/api/sessions/${encodeURIComponent(sessionId)}`;
  const [wc, setWc] = useState<WorkingCopy | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [statuses, setStatuses] = useState<Readiness['statuses']>(null);
  const [resetKeys, setResetKeys] = useState<Record<string, number>>({});
  const [highlighted, setHighlighted] = useState<Record<string, boolean>>({});
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftMessage, setDraftMessage] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<ApiError | null>(null);

  const version = useRef(-1);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const flushers = useRef(new Set<() => Promise<void>>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending.values()) clearTimeout(t);
    };
  }, []);

  /** Runs `fn` after `ms`, replacing any timer pending under the same key. */
  const later = useCallback((key: string, fn: () => void, ms: number) => {
    const prev = timers.current.get(key);
    if (prev) clearTimeout(prev);
    timers.current.set(
      key,
      setTimeout(() => {
        timers.current.delete(key);
        fn();
      }, ms),
    );
  }, []);

  /** Refetches the working copy; sections in `replace` have their local text replaced by the server body. */
  const load = useCallback(
    async (replace: string[] = []) => {
      try {
        const next = await apiFetch<WorkingCopy>(`${base}/working-copy`);
        version.current = Math.max(version.current, next.version);
        setWc(next);
        if (replace.length > 0) {
          setResetKeys((keys) => {
            const out = { ...keys };
            for (const s of replace) out[s] = (out[s] ?? 0) + 1;
            return out;
          });
        }
        setError(null);
      } catch (err) {
        setError(toApiError(err, 'Could not load the specification'));
        throw err;
      }
    },
    [base],
  );

  const loadReadiness = useCallback(async () => {
    try {
      setStatuses((await apiFetch<Readiness>(`${base}/readiness`)).statuses);
    } catch {
      // Badges fall back to "Not evaluated"; the right panel reports readiness errors.
    }
  }, [base]);

  useEffect(() => {
    load().catch(() => {});
    void loadReadiness();
  }, [load, loadReadiness]);

  const highlight = useCallback(
    (section: string) => {
      setHighlighted((h) => ({ ...h, [section]: true }));
      later(`highlight:${section}`, () => setHighlighted((h) => ({ ...h, [section]: false })), PATCH_HIGHLIGHT_MS);
    },
    [later],
  );

  useWorkspaceEvents((e) => {
    if (e.type === 'patch') {
      load([e.section])
        .then(() => highlight(e.section))
        .catch(() => {});
    } else if (e.type === 'suggestion') {
      load().catch(() => {});
    } else if (e.type === 'done') {
      void loadReadiness();
    }
  });

  const saveSection = useCallback(
    (section: SectionName, body: string, opts?: { keepalive?: boolean }) => {
      const run = chain.current.then(async () => {
        const res = await apiFetch<{ version: number }>(`${base}/working-copy/sections/${sectionSlug(section)}`, {
          method: 'PATCH',
          json: { body, expectedVersion: version.current },
          keepalive: opts?.keepalive,
        });
        version.current = res.version;
        setWc((prev) =>
          prev ? { ...prev, sections: { ...prev.sections, [section]: { body, lastUserEditAt: new Date().toISOString() } } } : prev,
        );
      });
      chain.current = run.catch(() => {});
      return run;
    },
    [base],
  );

  const registerFlush = useCallback((fn: () => Promise<void>) => {
    flushers.current.add(fn);
    return () => {
      flushers.current.delete(fn);
    };
  }, []);

  async function saveDraft() {
    setDraftBusy(true);
    try {
      await Promise.all([...flushers.current].map((f) => f()));
      await chain.current;
      const { number } = await apiFetch<{ number: number }>(`${base}/revisions`, { method: 'POST' });
      setDraftError(null);
      setDraftMessage(`Draft saved as revision ${number}`);
      later('draft', () => setDraftMessage(null), DRAFT_MESSAGE_MS);
    } catch (err) {
      setDraftError(toApiError(err, 'Could not save the draft'));
    } finally {
      setDraftBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Specification</h2>
        <div className="flex items-center gap-2">
          {draftMessage ? (
            <span role="status" className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-900">
              {draftMessage}
            </span>
          ) : null}
          <button
            type="button"
            disabled={readOnly || draftBusy || !wc}
            onClick={() => void saveDraft()}
            className="rounded border border-slate-400 px-3 py-1 text-sm font-medium hover:bg-slate-100 disabled:opacity-60"
          >
            Save Draft
          </button>
        </div>
      </div>
      {draftError ? <ErrorBanner message={draftError.message} correlationId={draftError.correlationId} /> : null}
      {error ? <ErrorBanner message={error.message} correlationId={error.correlationId} /> : null}
      {wc ? (
        <div className="space-y-2">
          {SECTION_NAMES.map((name) => (
            <SectionEditor
              key={name}
              sessionId={sessionId}
              name={name}
              body={wc.sections[name]?.body ?? ''}
              resetKey={resetKeys[name] ?? 0}
              status={statuses?.[name] ?? null}
              highlighted={highlighted[name] ?? false}
              readOnly={readOnly}
              suggestions={wc.pendingSuggestions.filter((s) => s.section === name)}
              save={(body, opts) => saveSection(name, body, opts)}
              onReload={() => load([name])}
              onRefreshVersion={() => load()}
              onSuggestionDecided={(accepted) => {
                load(accepted ? [name] : []).catch(() => {});
              }}
              registerFlush={registerFlush}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
