import type { SectionName } from '../../lib/spec/sections';

// Server-only: never import from src/lib or client components.

export type SectionPatch = {
  section: SectionName;
  op: 'replace' | 'append';
  content: string;
};

/** 'replace' -> content; 'append' -> body + newline separator (only when body is non-empty) + content. */
export function applyPatchToBody(body: string, patch: SectionPatch): string {
  if (patch.op === 'replace') return patch.content;
  return body + (body ? '\n' : '') + patch.content;
}
