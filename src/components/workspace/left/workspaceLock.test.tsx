import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LockBanner, WorkspaceProvider } from '@/components/workspace/WorkspaceProvider';
import { Conversation } from '@/components/workspace/left/Conversation';
import { NotesInput } from '@/components/workspace/left/NotesInput';
import { SessionHeader } from '@/components/workspace/left/SessionHeader';

const apiFetch = vi.hoisted(() => vi.fn());
const streamTurn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', async (orig) => ({ ...(await orig<typeof import('@/lib/api/client')>()), apiFetch }));
vi.mock('@/lib/api/sse', async (orig) => ({ ...(await orig<typeof import('@/lib/api/sse')>()), streamTurn }));

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
  streamTurn.mockReset();
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

function mockApi(lockHolder: 'you' | 'other') {
  apiFetch.mockImplementation(async (path: string) => {
    if (path.endsWith('/lock/take-over')) return { holder: 'you', expiresAt: null };
    if (path.endsWith('/lock')) return { holder: lockHolder, expiresAt: null };
    if (path.endsWith('/messages')) return { messages: [] };
    if (path === '/api/azure-devops/status') return { configured: false, checkedAt: '' };
    if (path === '/api/sessions/s1') {
      return {
        session: {
          id: 's1',
          primaryTicketKey: 'ABC-1',
          ticketKeys: ['ABC-1'],
          intakeState: 'ingested',
          ingestedAt: '2026-10-29T10:00:00.000Z',
          analyzedAt: null,
          codeRepository: null,
        },
        sources: [],
        publish: null,
      };
    }
    return {};
  });
}

function renderWorkspace() {
  render(
    <WorkspaceProvider sessionId="s1">
      <LockBanner />
      <Conversation />
      <NotesInput />
    </WorkspaceProvider>,
  );
}

function controlsDisabled(): boolean[] {
  return [
    (screen.getByLabelText('Message') as HTMLTextAreaElement).disabled,
    (screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled,
    (screen.getByLabelText(/^Note/) as HTMLTextAreaElement).disabled,
    (screen.getByRole('button', { name: 'Add note' }) as HTMLButtonElement).disabled,
  ];
}

describe('workspace session lock', () => {
  it("shows the read-only banner with Take over and disables send/notes when the holder is 'other'", async () => {
    mockApi('other');
    renderWorkspace();
    expect(await screen.findByRole('button', { name: 'Take over' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Read-only');
    expect(controlsDisabled()).toEqual([true, true, true, true]);
  });

  it('Take over moves the lock to this tab and re-enables the controls', async () => {
    mockApi('other');
    renderWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Take over' })).toBeNull());
    expect(apiFetch).toHaveBeenCalledWith('/api/sessions/s1/lock/take-over', { method: 'POST' });
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).disabled).toBe(false);
    expect((screen.getByLabelText(/^Note/) as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('shows no banner and enables editing when this tab holds the lock', async () => {
    mockApi('you');
    renderWorkspace();
    await waitFor(() => expect((screen.getByLabelText('Message') as HTMLTextAreaElement).disabled).toBe(false));
    expect(screen.queryByRole('button', { name: 'Take over' })).toBeNull();
  });

  it('renews the lock every 20 s', async () => {
    vi.useFakeTimers();
    mockApi('you');
    renderWorkspace();
    const lockCalls = () => apiFetch.mock.calls.filter(([p]) => p === '/api/sessions/s1/lock').length;
    expect(lockCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(lockCalls()).toBe(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(lockCalls()).toBe(3);
  });

  it('?analyze=1 in a read-only tab starts no analysis, removes the parameter and disables Analyze ticket', async () => {
    window.history.replaceState(null, '', '/sessions/s1?analyze=1');
    mockApi('other');
    render(
      <WorkspaceProvider sessionId="s1">
        <LockBanner />
        <SessionHeader />
      </WorkspaceProvider>,
    );
    await screen.findByRole('button', { name: 'Take over' });
    const analyze = (await screen.findByRole('button', { name: 'Analyze ticket' })) as HTMLButtonElement;
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(analyze.disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Refresh sources' }) as HTMLButtonElement).disabled).toBe(true);

    // Taking over later does not start it either: the parameter was consumed.
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(analyze.disabled).toBe(false));
    expect(streamTurn).not.toHaveBeenCalled();
  });
});
