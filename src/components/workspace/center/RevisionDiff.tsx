'use client';

// Section-aligned revision diff (SR-11.3): changed sections are expanded with +/- line markers (not colour alone,
// NFR-10); unchanged sections are collapsed into one closed group. Plain text only.

export interface DiffHunk {
  value: string;
  added?: boolean;
  removed?: boolean;
}

export interface SectionDiff {
  section: string;
  changed: boolean;
  hunks: DiffHunk[];
}

function HunkLines({ hunks }: { hunks: DiffHunk[] }) {
  return (
    <pre className="overflow-auto rounded border border-slate-200 bg-white text-xs">
      {hunks.map((part, i) => {
        const prefix = part.added ? '+ ' : part.removed ? '- ' : '  ';
        const cls = part.added ? 'bg-green-50 text-green-900' : part.removed ? 'bg-red-50 text-red-900' : 'text-slate-600';
        const lines = part.value.replace(/\n$/, '').split('\n');
        return (
          <span key={i} className={`block whitespace-pre-wrap break-words px-2 ${cls}`}>
            {lines.map((l) => prefix + l).join('\n')}
          </span>
        );
      })}
    </pre>
  );
}

export function RevisionDiff({ a, b, sections }: { a: number; b: number; sections: SectionDiff[] }) {
  const changed = sections.filter((s) => s.changed);
  const unchanged = sections.filter((s) => !s.changed);
  return (
    <div aria-label={`Changes from revision ${a} to revision ${b}`} className="space-y-2">
      <p className="text-xs text-slate-600">
        Revision {a} to revision {b}: {changed.length} changed {changed.length === 1 ? 'section' : 'sections'}
      </p>
      {changed.map((s) => (
        <details key={s.section} open className="rounded border border-slate-300 p-2">
          <summary className="cursor-pointer text-sm font-medium">{s.section}</summary>
          <div className="mt-1">
            <HunkLines hunks={s.hunks} />
          </div>
        </details>
      ))}
      {unchanged.length > 0 ? (
        <details className="rounded border border-slate-200 p-2">
          <summary className="cursor-pointer text-sm text-slate-600">
            {unchanged.length} unchanged {unchanged.length === 1 ? 'section' : 'sections'}
          </summary>
          <ul className="mt-1 list-disc pl-5 text-xs text-slate-600">
            {unchanged.map((s) => (
              <li key={s.section}>{s.section}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
