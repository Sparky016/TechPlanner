import type { SpecSections } from './document';
import { SECTION_NAMES } from './sections';

export interface SpecHeader {
  title: string;
  tickets: { key: string; url: string }[];
  facilitator: string;
  sessionId: string;
  revision: number | null;
  readinessScore: number | null;
  overrideJustification?: string | null;
}

const EMPTY_BODY = '_Not yet specified._';

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function renderSpecMarkdown(sections: SpecSections, header: SpecHeader): string {
  const tickets = header.tickets.map((t) => `[${cell(t.key)}](${t.url})`).join(', ');
  const rows: [string, string][] = [
    ['Tickets', tickets],
    ['Facilitator', cell(header.facilitator)],
    ['Session ID', cell(header.sessionId)],
    ['Revision', header.revision === null ? '' : String(header.revision)],
    ['Readiness Score', header.readinessScore === null ? '' : String(header.readinessScore)],
  ];
  if (header.overrideJustification) {
    rows.push(['Override justification', cell(header.overrideJustification)]);
  }

  const lines: string[] = [`# ${header.title}`, '', '| Field | Value |', '| --- | --- |'];
  for (const [k, v] of rows) lines.push(`| ${k} | ${v} |`);

  for (const name of SECTION_NAMES) {
    const body = sections[name].trim();
    lines.push('', `## ${name}`, '', body === '' ? EMPTY_BODY : body);
  }
  return lines.join('\n') + '\n';
}
