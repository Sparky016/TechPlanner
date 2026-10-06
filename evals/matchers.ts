import type { LlmClient, LlmToolDefinition } from '@/server/llm/types';
import type { SectionName } from '../src/lib/spec/sections';

// Matching rules for the LLM behaviour evals (task 40). Pure functions plus an optional LLM judge that receives its
// client and model from the caller, so importing this module never touches config, the DB or the Copilot CLI.

export interface SeededGap {
  id: string;
  section: SectionName;
  keywords: string[];
}

/** Anything the model produced that may address a gap: an AI question or a readiness issue. */
export interface Candidate {
  text: string;
  section: SectionName | null;
}

/** Case-insensitive: does `text` contain any of `keywords`? */
export function containsKeyword(text: string, keywords: readonly string[]): boolean {
  const haystack = text.toLowerCase();
  return keywords.some((k) => k.trim() !== '' && haystack.includes(k.trim().toLowerCase()));
}

/** A candidate addresses a gap when its section equals the gap section OR its text contains any gap keyword. */
export function matchesGap(candidate: Candidate, gap: SeededGap): boolean {
  return candidate.section === gap.section || containsKeyword(candidate.text, gap.keywords);
}

export function findMatch<T extends Candidate>(candidates: readonly T[], gap: SeededGap): T | undefined {
  return candidates.find((c) => matchesGap(c, gap));
}

export interface JudgeOptions {
  client: LlmClient;
  model: string;
  signal?: AbortSignal;
}

const JUDGE_SYSTEM =
  'You grade an automated evaluation. Decide whether any of the listed items (questions or readiness issues) ' +
  'addresses the described specification gap, even if worded differently. Call report_verdict exactly once.';

/**
 * Optional LLM judge (--judge), used only when keyword/section matching found nothing. Returns the index of the
 * matching candidate, or null. Runs on the evaluator model; failures count as "no match".
 */
export async function judgeMatch(
  candidates: readonly Candidate[],
  gap: SeededGap,
  opts: JudgeOptions,
): Promise<number | null> {
  if (candidates.length === 0) return null;
  let verdict: { matches: boolean; index?: number } | null = null;
  const tool: LlmToolDefinition = {
    name: 'report_verdict',
    description: 'Report whether an item addresses the gap and, if so, the number of the best matching item.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['matches'],
      properties: {
        matches: { type: 'boolean' },
        index: { type: 'integer', minimum: 1, maximum: candidates.length },
      },
    },
    handler: async (args) => {
      verdict = args as { matches: boolean; index?: number };
      return 'Recorded';
    },
  };
  const items = candidates.map((c, i) => `${i + 1}. [${c.section ?? 'no section'}] ${c.text}`).join('\n');
  const content =
    `Gap: section "${gap.section}", topic "${gap.id}" (related terms: ${gap.keywords.join(', ')}).\n\n` +
    `Items:\n${items}`;
  for await (const event of opts.client.run({
    kind: 'evaluator',
    model: opts.model,
    system: JUDGE_SYSTEM,
    messages: [{ role: 'user', content }],
    tools: [tool],
    signal: opts.signal,
  })) {
    if (event.type === 'error' || event.type === 'done') break;
  }
  const v = verdict as { matches: boolean; index?: number } | null;
  if (!v?.matches) return null;
  return v.index !== undefined && v.index >= 1 && v.index <= candidates.length ? v.index - 1 : 0;
}

export interface CheckTally {
  passed: number;
  total: number;
}

export function rate(t: CheckTally): number | null {
  return t.total === 0 ? null : t.passed / t.total;
}
