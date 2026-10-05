'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ErrorBanner } from '@/components/ErrorBanner';
import { ApiError, apiFetch } from '@/lib/api/client';

interface SessionSummary {
  id: string;
  primaryTicketKey: string;
  ticketKeys: string[];
  status: 'draft' | 'published' | 'partially_published';
  updatedAt: string;
}

const STATUS_LABEL: Record<SessionSummary['status'], string> = {
  draft: 'Draft',
  published: 'Published',
  partially_published: 'Partially published',
};

export default function SessionsPage() {
  const [status, setStatus] = useState('');
  const [ticket, setTicket] = useState('');
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (ticket.trim()) params.set('ticket', ticket.trim());
    const qs = params.toString();
    apiFetch<{ sessions: SessionSummary[] }>(`/api/sessions${qs ? `?${qs}` : ''}`)
      .then((data) => {
        if (cancelled) return;
        setSessions(data.sessions);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err : new ApiError('Could not load sessions', 0, undefined, undefined, null));
      });
    return () => {
      cancelled = true;
    };
  }, [status, ticket]);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">My sessions</h1>
        <Link href="/sessions/new" className="rounded bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800">
          New session
        </Link>
      </div>

      <div className="flex flex-wrap gap-4">
        <div>
          <label htmlFor="status-filter" className="block text-sm font-medium">
            Status
          </label>
          <select
            id="status-filter"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="rounded border border-slate-300 px-2 py-1"
          >
            <option value="">All</option>
            <option value="draft">Draft</option>
            <option value="published">Published</option>
            <option value="partially_published">Partially published</option>
          </select>
        </div>
        <div>
          <label htmlFor="ticket-filter" className="block text-sm font-medium">
            Ticket
          </label>
          <input
            id="ticket-filter"
            value={ticket}
            onChange={(e) => setTicket(e.target.value)}
            placeholder="ABC-123"
            className="rounded border border-slate-300 px-2 py-1"
          />
        </div>
      </div>

      {error ? <ErrorBanner message={error.message} correlationId={error.correlationId} /> : null}

      {sessions === null ? (
        error ? null : <p className="text-sm text-slate-600">Loading…</p>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-slate-600">No sessions found.</p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded border border-slate-200 bg-white">
          {sessions.map((s) => (
            <li key={s.id}>
              <a href={`/sessions/${s.id}`} className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-slate-50">
                <span>
                  <span className="font-medium">{s.primaryTicketKey}</span>
                  {s.ticketKeys.length > 1 ? (
                    <span className="ml-2 text-sm text-slate-600">{s.ticketKeys.slice(1).join(', ')}</span>
                  ) : null}
                </span>
                <span className="text-sm text-slate-600">
                  {STATUS_LABEL[s.status]} · {new Date(s.updatedAt).toLocaleString()}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
