'use client';

import type { IngestStatus, SourceItem } from '@/components/workspace/WorkspaceProvider';

// Every source of the session with its ingest status (SR-2.6); anything not fully ingested shows why.

const STATUS_LABEL: Record<IngestStatus, string> = {
  ingested: 'Ingested',
  listed: 'Listed only (not ingested)',
  unavailable: 'Unavailable',
  truncated: 'Truncated',
};

const STATUS_CLASS: Record<IngestStatus, string> = {
  ingested: 'bg-green-100 text-green-900',
  listed: 'bg-slate-200 text-slate-800',
  unavailable: 'bg-red-100 text-red-900',
  truncated: 'bg-amber-100 text-amber-900',
};

const KIND_LABEL: Record<SourceItem['kind'], string> = {
  jira_issue: 'Jira issue',
  confluence_page: 'Confluence page',
  attachment: 'Attachment',
};

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function reasonOf(s: SourceItem): string | null {
  const reason = str(s.detail.reason);
  const message = str(s.detail.message);
  if (reason && message) return `${reason}: ${message}`;
  return reason ?? message;
}

export function SourcesList({ sources }: { sources: SourceItem[] }) {
  if (sources.length === 0) return <p className="text-sm text-slate-600">No sources.</p>;
  return (
    <ul aria-label="Sources" className="space-y-1 text-sm">
      {sources.map((s) => {
        const reason = s.ingestStatus === 'ingested' ? null : reasonOf(s);
        const truncatedComments = Array.isArray(s.detail.truncatedComments) ? s.detail.truncatedComments.length : 0;
        return (
          <li key={s.id} className="rounded border border-slate-200 bg-white px-2 py-1">
            <div className="flex items-start justify-between gap-2">
              <span className="min-w-0 break-words">
                <span className="text-xs text-slate-500">{KIND_LABEL[s.kind] ?? s.kind} · </span>
                {s.title ?? s.ref}
              </span>
              <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${STATUS_CLASS[s.ingestStatus] ?? ''}`}>
                {STATUS_LABEL[s.ingestStatus] ?? s.ingestStatus}
              </span>
            </div>
            {reason ? <p className="mt-0.5 text-xs text-slate-700">Reason: {reason}</p> : null}
            {truncatedComments > 0 ? (
              <p className="mt-0.5 text-xs text-amber-800">
                {truncatedComments} comment{truncatedComments === 1 ? '' : 's'} truncated (context budget)
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
