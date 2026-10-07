import { createHash } from 'node:crypto';
import type { SectionName } from '../../lib/spec/sections';

// Server-only: never import from src/lib or client components.

/** SR-7.4: lowercase, strip punctuation, collapse whitespace, trim. */
export function normalizeIssueText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function issueFingerprint(section: SectionName, description: string): string {
  return createHash('sha256').update(`${section}\n${normalizeIssueText(description)}`).digest('hex');
}
