'use client';

import { ErrorBanner } from '@/components/ErrorBanner';
import type { AzureDevOpsState } from './useAzureDevOps';

// Shows whether Tech Planner can reach Azure DevOps Repos with its configured credential, with a re-check button.
export function AzureDevOpsStatus({ ado }: { ado: AzureDevOpsState }) {
  const { status, error, checking, recheck } = ado;

  let tone = 'border-slate-300 bg-slate-50 text-slate-700';
  let text = 'Checking Azure DevOps connection…';
  if (!checking && status) {
    if (!status.configured) {
      text = 'Azure DevOps is not configured: code investigation is off.';
    } else if (status.connected) {
      tone = 'border-green-300 bg-green-50 text-green-800';
      const n = status.repositories.length;
      text = `Connected to Azure DevOps (${status.project}): ${n} ${n === 1 ? 'repository' : 'repositories'} available.`;
    } else {
      tone = 'border-red-300 bg-red-50 text-red-800';
      text = `Azure DevOps connection failed: ${status.error.message} (${status.error.code}).`;
    }
  }

  return (
    <div className="space-y-1">
      <div role="status" aria-label="Azure DevOps connection" className={`flex items-start justify-between gap-2 rounded border px-2 py-1 text-xs ${tone}`}>
        <span>{text}</span>
        <button
          type="button"
          onClick={() => void recheck()}
          disabled={checking}
          className="shrink-0 underline disabled:opacity-60"
        >
          {checking ? 'Checking…' : 'Re-check'}
        </button>
      </div>
      {error ? <ErrorBanner message={error.message} correlationId={error.correlationId} /> : null}
    </div>
  );
}
