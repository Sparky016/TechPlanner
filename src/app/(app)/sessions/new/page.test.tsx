import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NewSessionPage from '@/app/(app)/sessions/new/page';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', async (orig) => ({ ...(await orig<typeof import('@/lib/api/client')>()), apiFetch }));

const STATUS = '/api/azure-devops/status';

// Routes the Azure DevOps status check; everything else goes to `create`.
function mockApi(create: (path: string, init?: unknown) => unknown, status: unknown = { configured: false }) {
  apiFetch.mockImplementation(async (path: string, init?: unknown) => (path === STATUS ? status : create(path, init)));
}

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
    mockApi(() => {
      throw new ApiError('exists', 409, 'session_exists', 'c1', { existingSessionIds: ['abc-123'] });
    });
    await submitKeys('ABC-1');
    const link = await screen.findByRole('link', { name: 'Open existing session' });
    expect(link.getAttribute('href')).toBe('/sessions/abc-123');
    expect(screen.getByRole('button', { name: 'Create another session anyway' })).toBeTruthy();
  });

  it('lists unreadable keys with the correlation id on 422', async () => {
    const { ApiError } = await import('@/lib/api/client');
    mockApi(() => {
      throw new ApiError('Some Jira tickets cannot be read', 422, 'tickets_unreadable', 'c2', { unreadable: ['ABC-9'] });
    });
    await submitKeys('ABC-1 ABC-9');
    await waitFor(() => expect(screen.getByLabelText('Unreadable tickets').textContent).toContain('ABC-9'));
    expect(screen.getByRole('alert').textContent).toContain('c2');
  });

  it('shows the Azure DevOps connection and sends the selected repository', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    mockApi(() => ({ session: { id: 's-1' } }), {
      configured: true,
      organization: 'https://dev.azure.com/acme',
      project: 'Platform',
      connected: true,
      repositories: [{ id: '1', name: 'payments-api', defaultBranch: 'main', webUrl: null }],
      checkedAt: '2026-10-20T00:00:00Z',
    });
    render(<NewSessionPage />);
    expect((await screen.findByText(/Connected to Azure DevOps \(Platform\): 1 repository available/)).textContent).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Code repository (optional)'), { target: { value: 'payments-api' } });
    fireEvent.change(screen.getByLabelText('Jira ticket keys'), { target: { value: 'ABC-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/sessions/s-1'));
    expect(apiFetch).toHaveBeenCalledWith('/api/sessions', {
      method: 'POST',
      json: { ticketKeys: ['ABC-1'], codeRepository: 'payments-api' },
    });
    vi.unstubAllGlobals();
  });

  it('shows why the Azure DevOps connection failed', async () => {
    mockApi(() => ({}), {
      configured: true,
      organization: 'https://dev.azure.com/acme',
      project: 'Platform',
      connected: false,
      error: { code: 'ado_unauthorized', message: 'Azure DevOps rejected the configured credential' },
      checkedAt: '2026-10-20T00:00:00Z',
    });
    render(<NewSessionPage />);
    expect(
      await screen.findByText('Azure DevOps connection failed: Azure DevOps rejected the configured credential (ado_unauthorized).'),
    ).toBeTruthy();
  });
});
