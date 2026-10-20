'use client';

import type { AdoStatus } from './useAzureDevOps';

export const NO_REPOSITORY = '';

// Repository picker for code investigation. A current value Azure DevOps no longer lists stays selectable, marked.
export function RepositorySelect({
  id,
  status,
  value,
  onChange,
  disabled,
}: {
  id: string;
  status: AdoStatus | null;
  value: string | null;
  onChange: (repository: string | null) => void;
  disabled?: boolean;
}) {
  const repositories = status?.configured && status.connected ? status.repositories : [];
  const listed = value === null || repositories.some((r) => r.name === value);
  return (
    <select
      id={id}
      value={value ?? NO_REPOSITORY}
      onChange={(e) => onChange(e.target.value === NO_REPOSITORY ? null : e.target.value)}
      disabled={disabled || (repositories.length === 0 && value === null)}
      className="w-full rounded border border-slate-300 px-2 py-1 text-sm disabled:opacity-60"
    >
      <option value={NO_REPOSITORY}>None (the agent searches every repository)</option>
      {repositories.map((r) => (
        <option key={r.id} value={r.name}>
          {r.name}
          {r.defaultBranch ? ` (${r.defaultBranch})` : ''}
        </option>
      ))}
      {!listed && value !== null ? <option value={value}>{value} (not currently available)</option> : null}
    </select>
  );
}
