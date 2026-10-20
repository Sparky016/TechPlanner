'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiFetch } from '@/lib/api/client';

// Browser-only. Live Azure DevOps connection status and repository list (ADR-0016), from /api/azure-devops/status.

export interface AdoRepositoryInfo {
  id: string;
  name: string;
  defaultBranch: string | null;
  webUrl: string | null;
}

export type AdoStatus =
  | { configured: false; checkedAt: string }
  | {
      configured: true;
      organization: string;
      project: string;
      connected: true;
      repositories: AdoRepositoryInfo[];
      checkedAt: string;
    }
  | {
      configured: true;
      organization: string;
      project: string;
      connected: false;
      error: { code: string; message: string };
      checkedAt: string;
    };

export interface AzureDevOpsState {
  status: AdoStatus | null;
  /** The status request itself failed (Tech Planner, not Azure DevOps). */
  error: ApiError | null;
  checking: boolean;
  recheck: () => Promise<void>;
}

export function useAzureDevOps(): AzureDevOpsState {
  const [status, setStatus] = useState<AdoStatus | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [checking, setChecking] = useState(true);

  const recheck = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      setStatus(await apiFetch<AdoStatus>('/api/azure-devops/status'));
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError('Could not check Azure DevOps', 0, undefined, undefined, null));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void recheck();
  }, [recheck]);

  return { status, error, checking, recheck };
}
