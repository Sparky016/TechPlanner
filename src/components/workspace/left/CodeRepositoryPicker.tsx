'use client';

import { useState } from 'react';
import { ErrorBanner } from '@/components/ErrorBanner';
import { AzureDevOpsStatus } from '@/components/azureDevOps/AzureDevOpsStatus';
import { RepositorySelect } from '@/components/azureDevOps/RepositorySelect';
import { useAzureDevOps } from '@/components/azureDevOps/useAzureDevOps';
import { useWorkspace } from '@/components/workspace/WorkspaceProvider';
import { ApiError, apiFetch } from '@/lib/api/client';

// Azure DevOps connection status and the session's code repository (ADR-0016): the facilitator agent investigates
// the selected repository first.
export function CodeRepositoryPicker() {
  const { sessionId, detail, reloadDetail, readOnly } = useWorkspace();
  const ado = useAzureDevOps();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  if (!detail) return null;
  const current = detail.session.codeRepository;

  async function save(repository: string | null) {
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/code-repository`, {
        method: 'PUT',
        json: { repository },
      });
      await reloadDetail();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError('Could not save the repository', 0, undefined, undefined, null));
    } finally {
      setSaving(false);
    }
  }

  const configured = ado.status?.configured === true;
  return (
    <section aria-label="Code repository" className="space-y-1">
      <h2 className="text-sm font-medium">Code repository</h2>
      <AzureDevOpsStatus ado={ado} />
      {configured || current !== null ? (
        <>
          <label htmlFor="code-repository" className="sr-only">
            Azure DevOps repository
          </label>
          <RepositorySelect
            id="code-repository"
            status={ado.status}
            value={current}
            onChange={(r) => void save(r)}
            disabled={readOnly || saving || ado.checking}
          />
        </>
      ) : null}
      {error ? <ErrorBanner message={error.message} correlationId={error.correlationId} /> : null}
    </section>
  );
}
