import { SECTION_NAMES, type SectionName } from './sections';

export type SpecSections = Record<SectionName, string>;

export function emptySections(): SpecSections {
  const out = {} as SpecSections;
  for (const name of SECTION_NAMES) out[name] = '';
  return out;
}

export type ValidationResult =
  | { ok: true; sections: SpecSections }
  | { ok: false; errors: string[] };

/** Valid only when the object has exactly the 27 section keys, all with string values. */
export function validateSections(obj: unknown): ValidationResult {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return { ok: false, errors: ['Sections must be an object'] };
  }
  const record = obj as Record<string, unknown>;
  const errors: string[] = [];
  const known = new Set<string>(SECTION_NAMES);
  for (const name of SECTION_NAMES) {
    if (!Object.hasOwn(record, name)) errors.push(`Missing section: ${name}`);
    else if (typeof record[name] !== 'string') errors.push(`Section must be a string: ${name}`);
  }
  for (const key of Object.keys(record)) {
    if (!known.has(key)) errors.push(`Unknown section: ${key}`);
  }
  return errors.length === 0 ? { ok: true, sections: record as SpecSections } : { ok: false, errors };
}

/** SR-5.2: 'Not applicable — <reason>' (em dash or hyphen) with a non-empty reason. */
export function isNotApplicable(body: string): boolean {
  return /^Not applicable (?:—|-) \S/.test(body.trim());
}
