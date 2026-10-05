import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NewSessionPage from '@/app/(app)/sessions/new/page';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', async (orig) => ({ ...(await orig<typeof import('@/lib/api/client')>()), apiFetch }));

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
});

async function submitKeys(keys: string) {
  render(<NewSessionPage />);
  fireEvent.change(screen.getByLabelText('Jira ticket keys'), { target: { value: keys } });
  fireEvent.click(screen.getByRole('button', { name: 'Create session' }));
}

describe('new session page', () => {
  it('shows the duplicate confirmation with a link to the existing session on 409', async () => {
    const { ApiError } = await import('@/lib/api/client');
    apiFetch.mockRejectedValue(
      new ApiError('exists', 409, 'session_exists', 'c1', { existingSessionIds: ['abc-123'] }),
    );
    await submitKeys('ABC-1');
    const link = await screen.findByRole('link', { name: 'Open existing session' });
    expect(link.getAttribute('href')).toBe('/sessions/abc-123');
    expect(screen.getByRole('button', { name: 'Create another session anyway' })).toBeTruthy();
  });

  it('lists unreadable keys with the correlation id on 422', async () => {
    const { ApiError } = await import('@/lib/api/client');
    apiFetch.mockRejectedValue(
      new ApiError('Some Jira tickets cannot be read', 422, 'tickets_unreadable', 'c2', { unreadable: ['ABC-9'] }),
    );
    await submitKeys('ABC-1 ABC-9');
    await waitFor(() => expect(screen.getByLabelText('Unreadable tickets').textContent).toContain('ABC-9'));
    expect(screen.getByRole('alert').textContent).toContain('c2');
  });
});
