import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoryDrawer } from './HistoryDrawer';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', async (orig) => ({ ...(await orig<typeof import('@/lib/api/client')>()), apiFetch }));

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
});

const revisions = [
  { number: 1, createdAt: '2026-10-01T10:00:00.000Z', author: { accountId: 'u1', displayName: 'Ann' }, trigger: 'save', readinessScore: 40, published: false },
  { number: 3, createdAt: '2026-10-03T10:00:00.000Z', author: { accountId: 'u1', displayName: 'Ann' }, trigger: 'publish', readinessScore: null, published: true },
  { number: 2, createdAt: '2026-10-02T10:00:00.000Z', author: { accountId: null, displayName: null }, trigger: 'restore', readinessScore: 75, published: false },
];

function mockApi() {
  apiFetch.mockImplementation(async (path: string) => {
    if (path.endsWith('/revisions')) return { revisions };
    if (path.includes('/compare?')) {
      return {
        a: 1,
        b: 3,
        sections: [
          { section: 'Scope', changed: true, hunks: [{ value: 'old line\n', removed: true }, { value: 'new line\n', added: true }, { value: 'same\n' }] },
          { section: 'Goals', changed: false, hunks: [{ value: 'unchanged text\n' }] },
        ],
      };
    }
    return { number: 4, restoredFrom: 1 };
  });
}

function setup(readOnly = false) {
  mockApi();
  const onRestored = vi.fn().mockResolvedValue(undefined);
  const beforeRestore = vi.fn().mockResolvedValue(undefined);
  render(<HistoryDrawer sessionId="s1" readOnly={readOnly} onClose={vi.fn()} beforeRestore={beforeRestore} onRestored={onRestored} />);
  return { onRestored, beforeRestore };
}

describe('HistoryDrawer', () => {
  it('lists revisions newest first with number, time, author, trigger, score and published badge', async () => {
    setup();
    const items = await screen.findAllByRole('listitem');
    expect(items.map((li) => within(li).getByText(/^Revision \d+$/).textContent)).toEqual(['Revision 3', 'Revision 2', 'Revision 1']);
    expect(within(items[0]).getByText('Published')).toBeTruthy();
    expect(within(items[0]).getByText('publish')).toBeTruthy();
    expect(within(items[0]).getByText('Score: n/a')).toBeTruthy();
    expect(within(items[1]).getByText('Unknown author')).toBeTruthy();
    expect(within(items[1]).getByText('Score: 75')).toBeTruthy();
    expect(within(items[2]).getByText('Ann')).toBeTruthy();
    expect(within(items[2]).getByText('save')).toBeTruthy();
    expect(within(items[2]).queryByText('Published')).toBeNull();
    expect(items[2].querySelector('time')?.getAttribute('datetime')).toBe('2026-10-01T10:00:00.000Z');
  });

  it('compares two revisions: changed sections expanded with +/- lines, unchanged collapsed', async () => {
    setup();
    await screen.findAllByRole('listitem');
    fireEvent.click(screen.getByLabelText('Select revision 3'));
    fireEvent.click(screen.getByLabelText('Select revision 1'));
    fireEvent.click(screen.getByRole('button', { name: 'Compare selected' }));
    const diff = await screen.findByLabelText('Changes from revision 1 to revision 3');
    expect(apiFetch).toHaveBeenCalledWith('/api/sessions/s1/revisions/compare?a=1&b=3');
    const text = diff.textContent ?? '';
    expect(text).toContain('- old line');
    expect(text).toContain('+ new line');
    const open = diff.querySelectorAll('details[open]');
    expect(open).toHaveLength(1);
    expect(open[0].textContent).toContain('Scope');
    const collapsed = [...diff.querySelectorAll('details')].find((d) => !d.open);
    expect(collapsed?.textContent).toContain('1 unchanged section');
    expect(collapsed?.textContent).toContain('Goals');
  });

  it('restore needs confirmation, calls the endpoint and reloads the working copy', async () => {
    const { onRestored, beforeRestore } = setup();
    await screen.findAllByRole('listitem');
    fireEvent.click(screen.getByRole('button', { name: 'Restore revision 1' }));
    const dialog = screen.getByRole('dialog', { name: 'Confirm restore' });
    expect(dialog.textContent).toContain('new revision');
    expect(apiFetch).not.toHaveBeenCalledWith('/api/sessions/s1/revisions/1/restore', expect.anything());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm restore' }));
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
    expect(apiFetch).toHaveBeenCalledWith('/api/sessions/s1/revisions/1/restore', { method: 'POST' });
    expect(beforeRestore.mock.invocationCallOrder[0]).toBeLessThan(onRestored.mock.invocationCallOrder[0]);
    expect((await screen.findByRole('status')).textContent).toContain('restored as revision 4');
  });

  it('cancelling the confirmation does not restore', async () => {
    const { onRestored } = setup();
    await screen.findAllByRole('listitem');
    fireEvent.click(screen.getByRole('button', { name: 'Restore revision 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onRestored).not.toHaveBeenCalled();
  });

  it('disables Restore when read-only', async () => {
    setup(true);
    await screen.findAllByRole('listitem');
    expect((screen.getByRole('button', { name: 'Restore revision 1' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
