// Server-only: never import from src/lib or client components.
// Hand-built Atlassian Document Format for the Jira description spec block (D-8, SR-13.2 step 3) and the publish
// comment (SR-13.2 step 4, SR-9.2). The description block is delimited by marker paragraphs so it can be replaced
// on republish without ever touching the ticket's original content.

import type { AdfNode } from "../atlassian/adfToText";

export interface AdfDoc {
  type: "doc";
  version: 1;
  content: AdfNode[];
}

export const SPEC_BLOCK_START =
  "TECH-PLANNER-SPEC-START — Technical Specification (managed by Tech Planner; edits here are overwritten)";
export const SPEC_BLOCK_END = "TECH-PLANNER-SPEC-END";
export const RUN_MARKER_PREFIX = "tech-planner-run:";

export interface SpecBlockInfo {
  confluencePageUrl: string | null;
  revisionNumber: number;
  readinessScore: number;
  overridden: boolean;
}

export interface PublishCommentInfo {
  runId: string;
  publisher: { accountId: string; displayName: string };
  revisionNumber: number;
  readinessScore: number;
  confluencePageUrl: string | null;
  overrideJustification: string | null;
}

function text(value: string): AdfNode {
  return { type: "text", text: value };
}

function linkText(value: string, href: string): AdfNode {
  return {
    type: "text",
    text: value,
    marks: [{ type: "link", attrs: { href } }],
  };
}

function paragraph(...content: AdfNode[]): AdfNode {
  return { type: "paragraph", content };
}

function confluenceLine(url: string | null): AdfNode {
  return url === null
    ? paragraph(text("Confluence page: not available"))
    : paragraph(text("Confluence page: "), linkText(url, url));
}

/** The full delimited block, start and end markers included. */
export function buildSpecBlockNodes(info: SpecBlockInfo): AdfNode[] {
  return [
    paragraph(text(SPEC_BLOCK_START)),
    confluenceLine(info.confluencePageUrl),
    paragraph(text(`Revision: ${info.revisionNumber}`)),
    paragraph(text(`Readiness score: ${info.readinessScore}`)),
    paragraph(text(`Override: ${info.overridden ? "yes" : "no"}`)),
    paragraph(text(SPEC_BLOCK_END)),
  ];
}

export function buildPublishCommentAdf(info: PublishCommentInfo): AdfDoc {
  const publisher: AdfNode =
    info.publisher.accountId === ""
      ? text(info.publisher.displayName)
      : {
          type: "mention",
          attrs: {
            id: info.publisher.accountId,
            text: `@${info.publisher.displayName}`,
          },
        };
  const content: AdfNode[] = [
    paragraph(text("Technical Specification published by "), publisher),
    paragraph(text(`Revision: ${info.revisionNumber}`)),
    paragraph(text(`Readiness score: ${info.readinessScore}`)),
    confluenceLine(info.confluencePageUrl),
  ];
  const justification = info.overrideJustification?.trim();
  if (justification)
    content.push(paragraph(text(`Override justification: ${justification}`)));
  // Idempotency marker: the comment step looks for this to avoid duplicate comments on retry.
  content.push(paragraph(text(`${RUN_MARKER_PREFIX}${info.runId}`)));
  return { type: "doc", version: 1, content };
}

function plainText(node: AdfNode): string {
  if (node.type === "text") return node.text ?? "";
  return Array.isArray(node.content)
    ? node.content.map(plainText).join("")
    : "";
}

function isMarker(node: AdfNode, marker: string): boolean {
  return node.type === "paragraph" && plainText(node).trim() === marker;
}

/**
 * Inserts or replaces the spec block. When both markers exist (start before end) the nodes from start through end
 * are replaced; otherwise the block is appended. Nodes outside the block are never changed, and the input is not
 * mutated. A null description yields a new doc containing only the block.
 */
export function upsertSpecBlock(
  descriptionAdf: AdfDoc | null,
  nodes: AdfNode[],
): AdfDoc {
  if (descriptionAdf === null)
    return { type: "doc", version: 1, content: [...nodes] };
  const existing = Array.isArray(descriptionAdf.content)
    ? descriptionAdf.content
    : [];
  const start = existing.findIndex((n) => isMarker(n, SPEC_BLOCK_START));
  const end =
    start === -1
      ? -1
      : existing.findIndex((n, i) => i > start && isMarker(n, SPEC_BLOCK_END));
  const content =
    start !== -1 && end !== -1
      ? [...existing.slice(0, start), ...nodes, ...existing.slice(end + 1)]
      : [...existing, ...nodes];
  return { ...descriptionAdf, content };
}
