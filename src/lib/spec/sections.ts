export const SECTION_NAMES = [
  'Executive Summary',
  'Problem Statement',
  'Business Context',
  'Scope',
  'Out of Scope',
  'Functional Requirements',
  'Non-functional Requirements',
  'User Flows',
  'Technical Design',
  'Data Model',
  'APIs',
  'External Integrations',
  'Security',
  'Performance',
  'Error Handling',
  'Monitoring',
  'Logging',
  'Risks',
  'Dependencies',
  'Assumptions',
  'Migration Strategy',
  'Deployment Strategy',
  'Rollback Strategy',
  'Testing Strategy',
  'Acceptance Criteria',
  'Open Questions',
  'Future Improvements',
] as const;

export type SectionName = (typeof SECTION_NAMES)[number];

export function sectionSlug(name: SectionName): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function sectionFromSlug(slug: string): SectionName | null {
  return SECTION_NAMES.find((n) => sectionSlug(n) === slug) ?? null;
}
