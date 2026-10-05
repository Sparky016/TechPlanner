import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataNotice } from '@/components/DataNotice';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', async (orig) => ({ ...(await orig<typeof import('@/lib/api/client')>()), apiFetch }));

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
});

describe('DataNotice', () => {
  it('is hidden when already acknowledged', () => {
    render(<DataNotice acknowledged />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows until acknowledged, then persists the acknowledgement', async () => {
    apiFetch.mockResolvedValue({ dataNoticeAcknowledged: true });
    render(<DataNotice acknowledged={false} />);
    expect(screen.getByRole('dialog').textContent).toContain('GitHub Copilot');

    fireEvent.click(screen.getByRole('button', { name: 'I understand' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(apiFetch).toHaveBeenCalledWith('/api/me/ack-data-notice', { method: 'POST' });
  });

  it('stays visible and shows the correlation id when saving fails', async () => {
    const { ApiError } = await import('@/lib/api/client');
    apiFetch.mockRejectedValue(new ApiError('Boom', 500, 'internal_error', 'corr-1', null));
    render(<DataNotice acknowledged={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'I understand' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('corr-1'));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
