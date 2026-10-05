'use client';

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorBanner } from '@/components/ErrorBanner';
import { ApiError, apiFetch } from '@/lib/api/client';
import type { TurnEvent } from '@/lib/api/sse';

// Shared workspace state for all three panels: session detail, the session lock (D-3) and an event bus that
// carries streamed facilitator events (patch/suggestion/question/done) so the center and right panels can react.

export const LOCK_HEARTBEAT_MS = 20_000;

export type IngestStatus = 'ingested' | 'listed' | 'unavailable' | 'truncated';

export interface SourceItem {
  id: string;
  kind: 'jira_issue' | 'confluence_page' | 'attachment';
  ref: string;
  title: string | null;
  ingestStatus: IngestStatus;
  detail: Record<string, unknown>;
  retrievedAt: string;
}

export interface SessionInfo {
  id: string;
  primaryTicketKey: string;
  ticketKeys: string[];
  facilitatorId: string;
  status: 'draft' | 'published' | 'partially_published';
  clarificationEnded: boolean;
  confluencePageId: string | null;
  confluencePageVersion: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionDetail {
  session: SessionInfo;
  sources: SourceItem[];
  publish: unknown;
}

export interface LockInfo {
  holder: 'you' | 'other';
  expiresAt: string | null;
}

/** Bus events: facilitator stream events plus local ones (a note or source refresh added conversation messages). */
export type WorkspaceEvent = TurnEvent | { type: 'conversation_changed' };
type Listener = (e: WorkspaceEvent) => void;

export interface WorkspaceValue {
  sessionId: string;
  detail: SessionDetail | null;
  detailError: ApiError | null;
  reloadDetail: () => Promise<void>;
  lock: LockInfo | null;
  lockError: ApiError | null;
  /** True unless this tab holds the lock (including before the first lock response). Disables every mutating control. */
  readOnly: boolean;
  takeOver: () => Promise<void>;
  publish: (e: WorkspaceEvent) => void;
  subscribe: (listener: Listener) => () => void;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export function useWorkspace(): WorkspaceValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used inside WorkspaceProvider');
  return value;
}

/** Calls `listener` for every bus event while mounted. */
export function useWorkspaceEvents(listener: Listener): void {
  const { subscribe } = useWorkspace();
  const ref = useRef(listener);
  useEffect(() => {
    ref.current = listener;
  });
  useEffect(() => subscribe((e) => ref.current(e)), [subscribe]);
}

function toApiError(err: unknown, fallback: string): ApiError {
  return err instanceof ApiError ? err : new ApiError(fallback, 0, undefined, undefined, null);
}

export function WorkspaceProvider({ sessionId, children }: { sessionId: string; children: ReactNode }) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [detailError, setDetailError] = useState<ApiError | null>(null);
  const [lock, setLock] = useState<LockInfo | null>(null);
  const [lockError, setLockError] = useState<ApiError | null>(null);
  const listeners = useRef(new Set<Listener>());
  const base = `/api/sessions/${encodeURIComponent(sessionId)}`;

  const reloadDetail = useCallback(async () => {
    try {
      setDetail(await apiFetch<SessionDetail>(base));
      setDetailError(null);
    } catch (err) {
      setDetailError(toApiError(err, 'Could not load the session'));
    }
  }, [base]);

  useEffect(() => {
    void reloadDetail();
  }, [reloadDetail]);

  // Acquire on mount and renew every 20 s; a tab that is not the holder keeps polling so it sees the lock free up.
  useEffect(() => {
    let cancelled = false;
    const beat = async () => {
      try {
        const next = await apiFetch<LockInfo>(`${base}/lock`, { method: 'POST' });
        if (!cancelled) {
          setLock(next);
          setLockError(null);
        }
      } catch (err) {
        if (!cancelled) setLockError(toApiError(err, 'Could not acquire the session lock'));
      }
    };
    void beat();
    const timer = setInterval(() => void beat(), LOCK_HEARTBEAT_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [base]);

  const takeOver = useCallback(async () => {
    try {
      setLock(await apiFetch<LockInfo>(`${base}/lock/take-over`, { method: 'POST' }));
      setLockError(null);
    } catch (err) {
      setLockError(toApiError(err, 'Could not take over the session'));
    }
  }, [base]);

  const publish = useCallback((e: WorkspaceEvent) => {
    for (const l of listeners.current) l(e);
  }, []);

  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  const value = useMemo<WorkspaceValue>(
    () => ({
      sessionId,
      detail,
      detailError,
      reloadDetail,
      lock,
      lockError,
      readOnly: lock?.holder !== 'you',
      takeOver,
      publish,
      subscribe,
    }),
    [sessionId, detail, detailError, reloadDetail, lock, lockError, takeOver, publish, subscribe],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

/** Read-only banner with Take over, shown while another tab holds the session lock. */
export function LockBanner() {
  const { lock, lockError, takeOver } = useWorkspace();
  const [busy, setBusy] = useState(false);
  return (
    <>
      {lock?.holder === 'other' ? (
        <div role="status" className="flex items-center justify-between gap-4 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          <span>Read-only: this session is being edited in another tab or by another user.</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void takeOver().finally(() => setBusy(false));
            }}
            className="rounded border border-amber-600 px-3 py-1 font-medium hover:bg-amber-100 disabled:opacity-60"
          >
            Take over
          </button>
        </div>
      ) : null}
      {lockError ? (
        <div className="px-4 py-2">
          <ErrorBanner message={lockError.message} correlationId={lockError.correlationId} />
        </div>
      ) : null}
    </>
  );
}
