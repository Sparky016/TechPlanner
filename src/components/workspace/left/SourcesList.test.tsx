import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { SourceItem } from '@/components/workspace/WorkspaceProvider';
import { SourcesList } from '@/components/workspace/left/SourcesList';

afterEach(cleanup);

const base = { retrievedAt: '2026-01-01T00:00:00.000Z' };
const SOURCES: SourceItem[] = [
  { ...base, id: '1', kind: 'jira_issue', ref: 'ABC-1', title: 'ABC-1 Login', ingestStatus: 'ingested', detail: { truncatedComments: ['ABC-1#5', 'ABC-1#6'] } },
  { ...base, id: '2', kind: 'confluence_page', ref: 'p1', title: 'Design doc', ingestStatus: 'truncated', detail: { reason: 'context_budget' } },
  { ...base, id: '3', kind: 'attachment', ref: 'a1', title: 'diagram.vsdx', ingestStatus: 'listed', detail: { reason: 'unsupported_type', mimeType: 'application/x' } },
  { ...base, id: '4', kind: 'confluence_page', ref: 'p2', title: null, ingestStatus: 'unavailable', detail: { reason: 'forbidden', message: 'No access' } },
];

function itemFor(text: string): HTMLElement {
  return screen.getByText(text).closest('li')!;
}

describe('SourcesList', () => {
  it('shows not-ingested and truncated items with their reasons', () => {
    render(<SourcesList sources={SOURCES} />);
    expect(itemFor('Design doc').textContent).toContain('Truncated');
    expect(itemFor('Design doc').textContent).toContain('context_budget');
    expect(itemFor('diagram.vsdx').textContent).toContain('not ingested');
    expect(itemFor('diagram.vsdx').textContent).toContain('unsupported_type');
    expect(itemFor('p2').textContent).toContain('Unavailable');
    expect(itemFor('p2').textContent).toContain('forbidden: No access');
  });

  it('shows ingested items without a reason and counts truncated comments', () => {
    render(<SourcesList sources={SOURCES} />);
    const issue = itemFor('ABC-1 Login');
    expect(issue.textContent).toContain('Ingested');
    expect(issue.textContent).not.toContain('Reason');
    expect(issue.textContent).toContain('2 comments truncated');
  });
});
