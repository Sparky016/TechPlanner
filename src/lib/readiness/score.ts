import { SECTION_NAMES, type SectionName } from '../spec/sections';
import type { SectionStatus, SectionStatuses } from './types';

const VALUE: Record<SectionStatus, number> = { complete: 1, partial: 0.5, missing: 0 };

/** SR-6.3: round(100 * Σ(w_i * v_i) / Σ w_i). Default weight 1 per section. */
export function computeReadinessScore(
  statuses: SectionStatuses,
  weights: Partial<Record<SectionName, number>> = {},
): number {
  const known = new Set<string>(SECTION_NAMES);
  for (const [name, w] of Object.entries(weights)) {
    if (!known.has(name)) throw new Error(`Unknown section in weights: ${name}`);
    if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) {
      throw new Error(`Weight must be a positive number: ${name}`);
    }
  }
  let total = 0;
  let weighted = 0;
  for (const name of SECTION_NAMES) {
    const w = weights[name] ?? 1;
    total += w;
    weighted += w * VALUE[statuses[name]];
  }
  return Math.round((100 * weighted) / total);
}
