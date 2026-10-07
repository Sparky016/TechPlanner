// Server-only: never import from src/lib or client components.
// Renders the published Generated Specification (SR-5.3, SR-5.4) from the canonical sections.

import type { SpecSections } from "../../lib/spec/document";
import { renderSpecMarkdown, type SpecHeader } from "../../lib/spec/render";

export interface PublishedMarkdownInput {
  sections: SpecSections;
  header: Omit<
    SpecHeader,
    "revision" | "readinessScore" | "overrideJustification"
  > & {
    revision: number;
    readinessScore: number;
    /** Written into the header only when an Override was used (SR-9.2). */
    overrideJustification: string | null;
  };
}

export function renderPublishedMarkdown(input: PublishedMarkdownInput): string {
  const justification = input.header.overrideJustification?.trim() || null;
  return renderSpecMarkdown(input.sections, {
    ...input.header,
    overrideJustification: justification,
  });
}
