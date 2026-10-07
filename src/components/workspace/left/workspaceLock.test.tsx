import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LockBanner, WorkspaceProvider } from '@/components/workspace/WorkspaceProvider';
import { Conversation } from '@/components/workspace/left/Conversation';
import { NotesInput } from '@/components/workspace/left/NotesInput';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', async (orig) => ({ ...(await orig<typeof import('@/lib/api/client')>()), apiFetch }));

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
  vi.useRealTimers();
});

function mockApi(lockHolder: 'you' | 'other') {
  apiFetch.mockImplementation(async (path: string) => {
    if (path.endsWith('/lock/take-over')) return { holder: 'you', expiresAt: null };
    if (path.endsWith('/lock')) return { holder: lockHolder, expiresAt: null };
    if (path.endsWith('/messages')) return { messages: [] };
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
});
