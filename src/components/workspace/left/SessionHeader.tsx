'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ErrorBanner } from '@/components/ErrorBanner';
import { type TurnError, useWorkspace } from '@/components/workspace/WorkspaceProvider';
import { CodeRepositoryPicker } from '@/components/workspace/left/CodeRepositoryPicker';
import { SourcesList } from '@/components/workspace/left/SourcesList';
import { ApiError, apiFetch } from '@/lib/api/client';

// Session tickets, code repository (ADR-0016) and the Sources block with the guided-intake controls (GI-3, GI-6,
// GI-8, GI-27): Ingest ticket (+ Analyze after ingest) before ingestion, Analyze ticket after ingestion without a
// successful analysis, and the sources list with Refresh sources (SR-2.6) once ingested.

const ANALYZE_PARAM = 'analyze';

/** Removes ?analyze=1 from the address bar so a reload does not start the analysis again (GI-27). */
function dropAnalyzeParam(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete(ANALYZE_PARAM);
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

function toApiError(err: unknown, fallback: string): ApiError {
  return err instanceof ApiError ? err : new ApiError(fallback, 0, undefined, undefined, null);
}

type Busy = 'ingest' | 'refresh' | null;

export function SessionHeader() {
  const { sessionId, detail, detailError, reloadDetail, readOnly, publish, lock, runTurn, turnInProgress } = useWorkspace();
  const [busy, setBusy] = useState<Busy>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeAfterIngest, setAnalyzeAfterIngest] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [analysisError, setAnalysisError] = useState<TurnError | null>(null);
  const analyzeParamHandled = useRef(false);
  const base = `/api/sessions/${encodeURIComponent(sessionId)}`;

  async function analyze(ignoreAlreadyAnalyzed = false) {
    setAnalysisError(null);
    setAnalyzing(true);
    const result = await runTurn({ path: '/analyze', label: 'Analysis' });
    setAnalyzing(false);
    if (result.error && !(ignoreAlreadyAnalyzed && result.error.code === 'already_analyzed')) {
      setAnalysisError(result.error);
    }
    // intakeState moves to 'analyzed' on success; reload in every case so the controls match the server.
    await reloadDetail();
  }

  async function ingest() {
    setBusy('ingest');
    setError(null);
    setAnalysisError(null);
    try {
      await apiFetch(`${base}/ingest`, { method: 'POST' });
    } catch (err) {
      setError(toApiError(err, 'Could not ingest the sources'));
      setBusy(null);
      // 409 already_ingested: another tab got there first; show the current state.
      if (err instanceof ApiError && err.code === 'already_ingested') await reloadDetail();
      return;
    }
    await reloadDetail();
    // Ingest records a system message in the conversation.
    publish({ type: 'conversation_changed' });
    setBusy(null);
    if (analyzeAfterIngest) await analyze();
  }

  async function refresh() {
    setBusy('refresh');
    setError(null);
    try {
      await apiFetch(`${base}/refresh-sources`, { method: 'POST' });
      await reloadDetail();
      // Refresh records a system message in the conversation.
      publish({ type: 'conversation_changed' });
    } catch (err) {
      setError(toApiError(err, 'Could not refresh sources'));
    } finally {
      setBusy(null);
    }
  }

  // GI-27: ?analyze=1 (from Create and ingest) starts the analysis once this tab holds the lock.
  const intakeState = detail?.session.intakeState;
  const holder = lock?.holder;
  useEffect(() => {
    if (analyzeParamHandled.current) return;
    if (new URLSearchParams(window.location.search).get(ANALYZE_PARAM) !== '1') {
      analyzeParamHandled.current = true;
      return;
    }
    if (!holder || !intakeState) return; // wait for the first lock and session responses
    analyzeParamHandled.current = true;
    if (holder === 'you' && intakeState === 'ingested') void analyze(true);
    dropAnalyzeParam();
    // analyze() is recreated every render; the ref makes this run at most once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holder, intakeState]);

  if (!detail) {
    return detailError ? (
      <ErrorBanner message={detailError.message} correlationId={detailError.correlationId} />
    ) : (
      <p className="text-sm text-slate-600">Loading session…</p>
    );
  }

  const { session, sources } = detail;
  const controlsDisabled = readOnly || busy !== null || turnInProgress;
  const ingestLabel = session.ticketKeys.length > 1 ? 'Ingest tickets' : 'Ingest ticket';
  const status = busy === 'ingest' ? 'Ingesting…' : analyzing ? `Analyzing ${session.primaryTicketKey}…` : '';

  return (
    <section aria-label="Session" className="space-y-2">
      <div>
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">{session.primaryTicketKey}</h1>
          <Link href={`/sessions/${encodeURIComponent(sessionId)}/audit`} className="text-xs underline text-blue-600 hover:text-blue-800">
            Audit trail
          </Link>
        </div>
        {session.ticketKeys.length > 1 ? (
          <p className="text-sm text-slate-600">Also: {session.ticketKeys.slice(1).join(', ')}</p>
        ) : null}
      </div>
      <CodeRepositoryPicker />
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Sources</h2>
        {session.intakeState !== 'not_ingested' ? (
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={controlsDisabled}
            className="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-100 disabled:opacity-60"
          >
            {busy === 'refresh' ? 'Refreshing…' : 'Refresh sources'}
          </button>
        ) : null}
      </div>
      <p aria-live="polite" data-testid="intake-status" className="text-sm text-slate-700 empty:hidden">
        {status}
      </p>
      {error ? <ErrorBanner message={error.message} correlationId={error.correlationId} /> : null}
      {session.intakeState === 'not_ingested' ? (
        <>
          <p className="text-sm text-slate-600">Sources not ingested yet.</p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void ingest()}
              disabled={controlsDisabled}
              className="rounded bg-blue-700 px-3 py-1 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-60"
            >
              {ingestLabel}
            </button>
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={analyzeAfterIngest}
                onChange={(e) => setAnalyzeAfterIngest(e.target.checked)}
                disabled={readOnly || busy !== null}
              />
              Analyze after ingest
            </label>
          </div>
        </>
      ) : (
        <SourcesList sources={sources} />
      )}
      {analysisError ? (
        <ErrorBanner
          message={
            analysisError.code === 'ai_unavailable'
              ? `AI unavailable: ${analysisError.message} The analysis did not run; use Analyze ticket to try again.`
              : `Analysis failed: ${analysisError.message}`
          }
          correlationId={analysisError.correlationId}
        />
      ) : null}
      {session.intakeState === 'ingested' && !analyzing ? (
        <button
          type="button"
          onClick={() => void analyze()}
          disabled={controlsDisabled}
          className="rounded bg-blue-700 px-3 py-1 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-60"
        >
          Analyze ticket
        </button>
      ) : null}
    </section>
  );
}
