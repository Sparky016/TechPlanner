'use client';

import { useEffect, useState } from 'react';
import { ErrorBanner } from '@/components/ErrorBanner';
import { ApiError, apiFetch } from '@/lib/api/client';
import { AUDIT_ACTIONS } from '@/server/audit/actions';

// Mirror of AuditRecord from @/server/audit/read (never import from server code).
interface AuditRecord {
  id: string;
  ts: string;
  user: { accountId: string | null; displayName: string | null };
  sessionId: string | null;
  ticketIds: string[];
  action: string;
  result: string;
  details: Record<string, unknown>;
  correlationId: string | null;
  hash: string;
}

interface AuditListResponse {
  records: AuditRecord[];
  nextCursor: string | null;
}

interface ExpandedDetails {
  [recordId: string]: boolean;
}

export function AuditTable({ sessionId }: { sessionId: string }) {
  const [records, setRecords] = useState<AuditRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [action, setAction] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [expandedDetails, setExpandedDetails] = useState<ExpandedDetails>({});

  // Fetch first page when sessionId or action filter changes
  useEffect(() => {
    setRecords([]);
    setNextCursor(null);
    setExpandedDetails({});
    setError(null);

    const fetchRecords = async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        params.set('limit', '50');
        if (action) {
          params.set('action', action);
        }

        const response = await apiFetch<AuditListResponse>(
          `/api/sessions/${encodeURIComponent(sessionId)}/audit?${params.toString()}`,
        );
        setRecords(response.records);
        setNextCursor(response.nextCursor);
      } catch (err) {
        setError(err instanceof ApiError ? err : new ApiError('Failed to load audit records', 0, undefined, undefined, null));
      } finally {
        setLoading(false);
      }
    };

    void fetchRecords();
  }, [sessionId, action]);

  const loadMore = async () => {
    if (!nextCursor || loading) return;

    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('limit', '50');
      if (action) {
        params.set('action', action);
      }
      params.set('cursor', nextCursor);

      const response = await apiFetch<AuditListResponse>(
        `/api/sessions/${encodeURIComponent(sessionId)}/audit?${params.toString()}`,
      );
      setRecords((prev) => [...prev, ...response.records]);
      setNextCursor(response.nextCursor);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError('Failed to load more records', 0, undefined, undefined, null));
    } finally {
      setLoading(false);
    }
  };

  const toggleDetails = (recordId: string) => {
    setExpandedDetails((prev) => ({
      ...prev,
      [recordId]: !prev[recordId],
    }));
  };

  const handleActionChange = (value: string) => {
    setAction(value);
  };

  return (
    <div className="space-y-4">
      {error && <ErrorBanner message={error.message} correlationId={error.correlationId} />}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <label htmlFor="action-filter" className="text-sm font-medium">
            Filter by action:
          </label>
          <select
            id="action-filter"
            value={action}
            onChange={(e) => handleActionChange(e.target.value)}
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          >
            <option value="">All actions</option>
            {AUDIT_ACTIONS.map((act) => (
              <option key={act} value={act}>
                {act}
              </option>
            ))}
          </select>
        </div>
        <a
          href={`/api/sessions/${encodeURIComponent(sessionId)}/audit/export`}
          download
          className="text-sm text-blue-600 hover:text-blue-800 underline"
        >
          Export JSONL
        </a>
      </div>

      {loading && records.length === 0 ? (
        <p className="text-sm text-slate-600">Loading audit records…</p>
      ) : records.length === 0 ? (
        <p className="text-sm text-slate-600">No audit records found.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse border border-slate-300 text-sm">
            <thead>
              <tr className="bg-slate-50">
                <th className="border border-slate-300 px-3 py-2 text-left font-semibold">Time</th>
                <th className="border border-slate-300 px-3 py-2 text-left font-semibold">User</th>
                <th className="border border-slate-300 px-3 py-2 text-left font-semibold">Action</th>
                <th className="border border-slate-300 px-3 py-2 text-left font-semibold">Result</th>
                <th className="border border-slate-300 px-3 py-2 text-left font-semibold">Correlation ID</th>
                <th className="border border-slate-300 px-3 py-2 text-left font-semibold">Details</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.id} className="hover:bg-slate-50">
                  <td className="border border-slate-300 px-3 py-2">
                    <time dateTime={record.ts}>{record.ts}</time>
                  </td>
                  <td className="border border-slate-300 px-3 py-2">
                    {record.user.displayName ?? record.user.accountId ?? '—'}
                  </td>
                  <td className="border border-slate-300 px-3 py-2">{record.action}</td>
                  <td className="border border-slate-300 px-3 py-2">
                    <span
                      className={
                        record.result === 'success' ? 'text-green-700' : 'text-red-700'
                      }
                    >
                      {record.result}
                    </span>
                  </td>
                  <td className="border border-slate-300 px-3 py-2 font-mono text-xs">
                    {record.correlationId ?? '—'}
                  </td>
                  <td className="border border-slate-300 px-3 py-2">
                    <button
                      type="button"
                      onClick={() => toggleDetails(record.id)}
                      className="text-xs text-blue-600 hover:text-blue-800 underline"
                    >
                      {expandedDetails[record.id] ? 'Hide details' : 'Show details'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Expanded details rows */}
      {records.map((record) =>
        expandedDetails[record.id] ? (
          <div key={`${record.id}-details`} className="rounded border border-slate-300 bg-slate-50 p-3">
            <p className="mb-2 text-xs font-semibold">Details for record {record.id}:</p>
            <pre className="overflow-x-auto rounded bg-white p-2 text-xs font-mono">
              {JSON.stringify(record.details, null, 2)}
            </pre>
          </div>
        ) : null,
      )}

      {nextCursor && (
        <button
          type="button"
          onClick={() => void loadMore()}
          disabled={loading}
          className="rounded border border-slate-300 bg-white px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-60"
        >
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}
