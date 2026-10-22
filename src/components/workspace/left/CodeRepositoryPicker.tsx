'use client';

import { useState } from 'react';
import { ErrorBanner } from '@/components/ErrorBanner';
import { AzureDevOpsStatus } from '@/components/azureDevOps/AzureDevOpsStatus';
import { RepositorySelect } from '@/components/azureDevOps/RepositorySelect';
import { useAzureDevOps } from '@/components/azureDevOps/useAzureDevOps';
import { useWorkspace } from '@/components/workspace/WorkspaceProvider';
import { ApiError, apiFetch } from '@/lib/api/client';

// Azure DevOps connection status and the session's code repositories (ADR-0016): the facilitator agent investigates
// the selected repositories first.
export function CodeRepositoryPicker() {
  const { sessionId, detail, reloadDetail, readOnly } = useWorkspace();
  const ado = useAzureDevOps();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  if (!detail) return null;
  const current = detail.session.codeRepositories;

  async function save(repositories: string[]) {
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/code-repository`, {
        method: 'PUT',
        json: { repositories },
      });
      await reloadDetail();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError('Could not save the repositories', 0, undefined, undefined, null));
    } finally {
      setSaving(false);
    }
  }

  const configured = ado.status?.configured === true;
  return (
    <section aria-label="Code repositories" className="space-y-1">
      <h2 className="text-sm font-medium">Code repositories</h2>
      <AzureDevOpsStatus ado={ado} />
      {configured || current.length > 0 ? (
        <>
          <RepositorySelect
            id="code-repositories"
            label="Azure DevOps repositories"
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
