import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditTable } from '@/components/audit/AuditTable';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', async (orig) => ({ ...(await orig<typeof import('@/lib/api/client')>()), apiFetch }));

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
});

describe('AuditTable', () => {
  const sessionId = 'session-123';

  const createRecord = (overrides = {}) => ({
    id: '1',
    ts: '2026-01-01T12:00:00.000Z',
    user: { accountId: 'user-123', displayName: 'John Doe' },
    sessionId,
    ticketIds: [],
    action: 'draft.created',
    result: 'success' as const,
    details: { key: 'value' },
    correlationId: 'corr-123',
    hash: 'abc123',
    ...overrides,
  });

  it('renders records and expands details as preformatted JSON (AC1)', async () => {
    const record1 = createRecord({
      id: '1',
      user: { accountId: 'system', displayName: null },
      details: { foo: 'bar', nested: { a: 1 } },
    });
    const record2 = createRecord({
      id: '2',
      ts: '2026-01-01T13:00:00.000Z',
      user: { accountId: 'user-456', displayName: 'Jane Smith' },
      action: 'draft.updated',
      details: { changed: true },
    });

    apiFetch.mockResolvedValueOnce({
      records: [record1, record2],
      nextCursor: '7',
    });

    render(<AuditTable sessionId={sessionId} />);

    await waitFor(() => {
      expect(screen.getByText('2026-01-01T12:00:00.000Z')).toBeTruthy();
    });

    // Check that 'system' user displays sensibly
    const firstRow = screen.getByText('2026-01-01T12:00:00.000Z').closest('tr');
    expect(firstRow?.textContent).toContain('system');

    // Expand details for first record
    const detailsButtons = screen.getAllByText('Show details');
    fireEvent.click(detailsButtons[0]);

    await waitFor(() => {
      const preElement = screen.getByText(/foo/);
      expect(preElement.textContent).toBe(JSON.stringify(record1.details, null, 2));
    });
  });

  it('loads more records with cursor and re-queries with action filter (AC2)', async () => {
    const record1 = createRecord({ id: '1', ts: '2026-01-01T12:00:00.000Z' });
    const record2 = createRecord({ id: '2', ts: '2026-01-01T11:00:00.000Z' });

    apiFetch.mockResolvedValueOnce({
      records: [record1, record2],
      nextCursor: '7',
    });

    render(<AuditTable sessionId={sessionId} />);

    await waitFor(() => {
      expect(screen.getByText('2026-01-01T12:00:00.000Z')).toBeTruthy();
    });

    // Verify initial fetch
    expect(apiFetch).toHaveBeenCalledOnce();
    const initialCall = apiFetch.mock.calls[0][0] as string;
    expect(initialCall).toContain('/api/sessions/session-123/audit');
    expect(initialCall).toContain('limit=50');

    // Load more
    apiFetch.mockResolvedValueOnce({
      records: [createRecord({ id: '3', ts: '2026-01-01T10:00:00.000Z' })],
      nextCursor: null,
    });

    fireEvent.click(screen.getByText('Load more'));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledTimes(2);
    });

    const loadMoreCall = apiFetch.mock.calls[1][0] as string;
    expect(loadMoreCall).toContain('cursor=7');

    // Filter by action
    apiFetch.mockResolvedValueOnce({
      records: [createRecord({ id: '4', action: 'publish.started', ts: '2026-01-01T14:00:00.000Z' })],
      nextCursor: null,
    });

    const filterSelect = screen.getByDisplayValue('All actions');
    fireEvent.change(filterSelect, { target: { value: 'publish.started' } });

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledTimes(3);
    });

    const filterCall = apiFetch.mock.calls[2][0] as string;
    expect(filterCall).toContain('action=publish.started');
    expect(filterCall).not.toContain('cursor=');
  });

  it('export link points to the correct API route (AC3)', () => {
    apiFetch.mockResolvedValueOnce({
      records: [],
      nextCursor: null,
    });

    render(<AuditTable sessionId={sessionId} />);

    const exportLink = screen.getByRole('link', { name: /export/i });
    expect(exportLink.getAttribute('href')).toBe(`/api/sessions/${sessionId}/audit/export`);
  });
});
