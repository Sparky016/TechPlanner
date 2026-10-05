import { describe, expect, it } from 'vitest';
import { emptySections, isNotApplicable, validateSections } from './document';
import { renderSpecMarkdown, type SpecHeader } from './render';
import { SECTION_NAMES, sectionFromSlug, sectionSlug } from './sections';

const header: SpecHeader = {
  title: 'Checkout redesign',
  tickets: [{ key: 'ABC-1', url: 'https://example.atlassian.net/browse/ABC-1' }],
  facilitator: 'Ruan',
  sessionId: 'sess-1',
  revision: 2,
  readinessScore: 80,
};

describe('sections', () => {
  it('has exactly 27 names in SR-5.1 order', () => {
    expect(SECTION_NAMES).toHaveLength(27);
    expect(SECTION_NAMES[0]).toBe('Executive Summary');
    expect(SECTION_NAMES[5]).toBe('Functional Requirements');
    expect(SECTION_NAMES[26]).toBe('Future Improvements');
    expect(new Set(SECTION_NAMES).size).toBe(27);
  });

  it('round-trips slugs and rejects unknown slugs', () => {
    for (const n of SECTION_NAMES) expect(sectionFromSlug(sectionSlug(n))).toBe(n);
    expect(sectionSlug('Non-functional Requirements')).toBe('non-functional-requirements');
    expect(sectionSlug('APIs')).toBe('apis');
    expect(sectionFromSlug('nope')).toBeNull();
  });
});

describe('validateSections', () => {
  it('accepts an empty document', () => {
    expect(validateSections(emptySections()).ok).toBe(true);
  });

  it('rejects missing, extra and non-string sections', () => {
    const missing: Record<string, unknown> = { ...emptySections() };
    delete missing['Scope'];
    expect(validateSections(missing).ok).toBe(false);
    expect(validateSections({ ...emptySections(), Extra: 'x' }).ok).toBe(false);
    expect(validateSections({ ...emptySections(), Scope: 5 }).ok).toBe(false);
    expect(validateSections(null).ok).toBe(false);
    expect(validateSections([]).ok).toBe(false);
  });
});

describe('isNotApplicable', () => {
  it('requires a reason', () => {
    expect(isNotApplicable('Not applicable — no data stored')).toBe(true);
    expect(isNotApplicable('  Not applicable - no data stored ')).toBe(true);
    expect(isNotApplicable('Not applicable')).toBe(false);
    expect(isNotApplicable('Not applicable — ')).toBe(false);
    expect(isNotApplicable('Not applicable — \n')).toBe(false);
  });
});

describe('renderSpecMarkdown', () => {
  it('emits header and all 27 headings in order', () => {
    const sections = { ...emptySections(), Scope: 'In scope: checkout' };
    const md = renderSpecMarkdown(sections, header);
    const headings = md.split('\n').filter((l) => l.startsWith('## '));
    expect(headings).toEqual(SECTION_NAMES.map((n) => `## ${n}`));
    expect(md).toMatchSnapshot();
  });

  it('includes the override row only when set', () => {
    expect(renderSpecMarkdown(emptySections(), header)).not.toContain('Override justification');
    expect(renderSpecMarkdown(emptySections(), { ...header, overrideJustification: null })).not.toContain(
      'Override justification',
    );
    expect(
      renderSpecMarkdown(emptySections(), { ...header, overrideJustification: 'Urgent' }),
    ).toContain('| Override justification | Urgent |');
  });

  it('is deterministic and marks empty bodies', () => {
    const a = renderSpecMarkdown(emptySections(), header);
    expect(renderSpecMarkdown(emptySections(), header)).toBe(a);
    expect(a).toContain('_Not yet specified._');
  });
});
