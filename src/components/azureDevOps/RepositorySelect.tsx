'use client';

import type { AdoStatus } from './useAzureDevOps';

// Repository picker for code investigation: any number of repositories, none meaning the agent searches every one.
// A current value Azure DevOps no longer lists stays selectable, marked.
export function RepositorySelect({
  id,
  label,
  status,
  value,
  onChange,
  disabled,
  describedBy,
}: {
  id: string;
  label: string;
  status: AdoStatus | null;
  value: string[];
  onChange: (repositories: string[]) => void;
  disabled?: boolean;
  describedBy?: string;
}) {
  const repositories = status?.configured && status.connected ? status.repositories : [];
  const listed = new Set(repositories.map((r) => r.name));
  const unlisted = value.filter((v) => !listed.has(v));
  const options = [
    ...repositories.map((r) => ({ name: r.name, text: `${r.name}${r.defaultBranch ? ` (${r.defaultBranch})` : ''}` })),
    ...unlisted.map((name) => ({ name, text: `${name} (not currently available)` })),
  ];
  const selected = new Set(value);

  function toggle(name: string, checked: boolean) {
    // Keeps pick order; a new pick goes last.
    onChange(checked ? [...value, name] : value.filter((v) => v !== name));
  }

  return (
    <fieldset id={id} aria-describedby={describedBy} disabled={disabled} className="space-y-1 disabled:opacity-60">
      <legend className="sr-only">{label}</legend>
      {options.length === 0 ? (
        <p className="text-xs text-slate-600">No repositories available.</p>
      ) : (
        <ul className="max-h-48 space-y-0.5 overflow-y-auto rounded border border-slate-300 px-2 py-1 text-sm">
          {options.map((o) => (
            <li key={o.name}>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={selected.has(o.name)} onChange={(e) => toggle(o.name, e.target.checked)} />
                {o.text}
              </label>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-slate-600">
        {value.length === 0
          ? 'None selected: the agent searches every repository.'
          : `${value.length} selected: the agent investigates ${value.length === 1 ? 'this repository' : 'these repositories'} first.`}
      </p>
    </fieldset>
  );
}
