'use client';

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorBanner } from '@/components/ErrorBanner';
import { ApiError, apiFetch } from '@/lib/api/client';
import { streamTurn, type TurnEvent } from '@/lib/api/sse';

// Shared workspace state for all three panels: session detail, the session lock (D-3), an event bus that
// carries streamed facilitator events (token/patch/suggestion/question/done/error) so every panel can react, and
// the turn runner (GI-22): one AI turn at a time per tab, started from any panel and visible to all of them.

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
  /** Azure DevOps repository for code investigation, or null. */
  codeRepository: string | null;
  confluencePageId: string | null;
  confluencePageVersion: number | null;
  /** When the sources were first ingested, or null (guided intake GI-1). */
  ingestedAt: string | null;
  /** When the initial analysis succeeded, or null. */
  analyzedAt: string | null;
  /** Server-derived; the client never computes it from the timestamps. */
  intakeState: 'not_ingested' | 'ingested' | 'analyzed';
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

/** A turn to start with runTurn. `path` is relative to /api/sessions/:id, e.g. '/messages', '/analyze'. */
export interface RunTurnOptions {
  path: string;
  /** JSON body; omit for routes without one (/analyze). */
  body?: unknown;
  /** Short human-readable name of the turn, e.g. 'Discussion', 'Analysis', 'Answer'. */
  label: string;
  /** The facilitator text that started the turn, shown above the streamed reply (message and answer turns). */
  prompt?: string;
}

/** The turn streaming right now in this tab (read with useActiveTurn). */
export interface ActiveTurn {
  label: string;
  prompt?: string;
  /** Concatenated `token` text so far. */
  reply: string;
  /** False until the first event arrives (the request may still be rejected with 409/423). */
  started: boolean;
}

export interface TurnError {
  code?: string;
  message: string;
  correlationId?: string;
  /** HTTP status of a request rejected before streaming (409, 423, ...); undefined for stream `error` events. */
  status?: number;
}

export interface TurnResult {
  /** The stream ended without an `error` event. */
  ok: boolean;
  /** At least one event arrived, i.e. the server accepted the turn and persisted its input. */
  started: boolean;
  error: TurnError | null;
}

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
  /**
   * Streams one AI turn, publishing every event on the bus and updating useActiveTurn(). Resolves when the turn
   * ends; never throws. Refused locally (started: false, code 'turn_in_progress') while another turn streams in
   * this tab. After a started turn it publishes `conversation_changed`.
   */
  runTurn: (opts: RunTurnOptions) => Promise<TurnResult>;
  /** True while any turn started with runTurn streams in this tab. Disables every Send / Answer / Analyze control. */
  turnInProgress: boolean;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);
// Kept apart from WorkspaceContext so a token only re-renders the components that show the streamed reply.
const ActiveTurnContext = createContext<ActiveTurn | null>(null);

/** The turn streaming in this tab, or null. Re-renders on every token: use it only where the reply is shown. */
export function useActiveTurn(): ActiveTurn | null {
  return useContext(ActiveTurnContext);
}

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
  const [activeTurn, setActiveTurn] = useState<ActiveTurn | null>(null);
  const [turnInProgress, setTurnInProgress] = useState(false);
  // Synchronous guard so a double click cannot start two streams before the state update renders.
  const turnRunning = useRef(false);
  const turnAbort = useRef<AbortController | null>(null);
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

  // Abort a streaming turn when the workspace unmounts (the server finishes and persists it regardless).
  useEffect(() => () => turnAbort.current?.abort(), []);

  const runTurn = useCallback(
    async ({ path, body, label, prompt }: RunTurnOptions): Promise<TurnResult> => {
      if (turnRunning.current) {
        return {
          ok: false,
          started: false,
          error: { code: 'turn_in_progress', message: 'An AI turn is already in progress.' },
        };
      }
      turnRunning.current = true;
      const controller = new AbortController();
      turnAbort.current = controller;
      setTurnInProgress(true);
      setActiveTurn({ label, prompt, reply: '', started: false });
      let started = false;
      let error: TurnError | null = null;
      try {
        for await (const ev of streamTurn(`${base}${path}`, body, controller.signal)) {
          if (!started) setActiveTurn((t) => (t ? { ...t, started: true } : t));
          started = true;
          if (ev.type === 'token') setActiveTurn((t) => (t ? { ...t, reply: t.reply + ev.text } : t));
          else if (ev.type === 'error') error = { code: ev.code, message: ev.message, correlationId: ev.correlationId };
          publish(ev);
        }
      } catch (err) {
        const apiErr = err instanceof ApiError ? err : null;
        error = {
          code: apiErr?.code,
          message: apiErr?.message ?? 'The AI turn failed',
          correlationId: apiErr?.correlationId,
          status: apiErr?.status,
        };
      } finally {
        turnRunning.current = false;
        if (turnAbort.current === controller) turnAbort.current = null;
        setActiveTurn(null);
        setTurnInProgress(false);
      }
      // The server persisted the turn's messages: let every panel reload them.
      if (started) publish({ type: 'conversation_changed' });
      return { ok: error === null, started, error };
    },
    [base, publish],
  );

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
      runTurn,
      turnInProgress,
    }),
    [sessionId, detail, detailError, reloadDetail, lock, lockError, takeOver, publish, subscribe, runTurn, turnInProgress],
  );

  return (
    <WorkspaceContext.Provider value={value}>
      <ActiveTurnContext.Provider value={activeTurn}>{children}</ActiveTurnContext.Provider>
    </WorkspaceContext.Provider>
  );
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
