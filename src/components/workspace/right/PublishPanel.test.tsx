import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceProvider } from '@/components/workspace/WorkspaceProvider';
import { PublishPanel, type PublishRun } from '@/components/workspace/right/PublishPanel';
import { ApiError } from '@/lib/api/client';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', async (orig) => ({ ...(await orig<typeof import('@/lib/api/client')>()), apiFetch }));

const STEP_NAMES = ['confluence', 'jira_attach', 'jira_description', 'jira_comment', 'jira_label', 'downstream'];

function makeRun(status: PublishRun['status'], stepStatuses: string[], confluenceError?: { code: string; message: string }): PublishRun {
  return {
    id: 'r1',
    revisionNumber: 2,
    status,
    steps: STEP_NAMES.map((name, i) => ({
      name,
      status: stepStatuses[i] as PublishRun['steps'][number]['status'],
      attempts: 1,
      lastError: name === 'confluence' && confluenceError ? confluenceError : null,
    })),
  };
}

let lockHolder: 'you' | 'other' = 'you';
let run: PublishRun;
let latestRun: { id: string } | null;
let publishHandler: (json: unknown) => unknown;

beforeEach(() => {
  lockHolder = 'you';
  latestRun = null;
  run = makeRun('running', ['running', 'pending', 'pending', 'pending', 'pending', 'pending']);
  publishHandler = () => ({ runId: 'r1' });
  apiFetch.mockImplementation(async (path: string, init?: { method?: string; json?: unknown }) => {
    if (path.endsWith('/lock')) return { holder: lockHolder, expiresAt: null };
    if (path === '/api/sessions/s1') return { session: {}, sources: [], publish: { status: 'draft', latestRun } };
    if (path === '/api/sessions/s1/publish') return publishHandler(init?.json);
    if (path === '/api/sessions/s1/publish/r1') return { run };
    if (path === '/api/sessions/s1/publish/r1/retry') {
      run = { ...run, status: 'running' };
      return { runId: 'r1' };
    }
    return {};
  });
});

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
  vi.useRealTimers();
});

function renderPanel() {
  render(
    <WorkspaceProvider sessionId="s1">
      <PublishPanel />
    </WorkspaceProvider>,
  );
}

const runCalls = () => apiFetch.mock.calls.filter(([p]) => p === '/api/sessions/s1/publish/r1').length;

async function clickPublish() {
  const btn = (await screen.findByRole('button', { name: 'Publish' })) as HTMLButtonElement;
  await waitFor(() => expect(btn.disabled).toBe(false));
  fireEvent.click(btn);
}

describe('PublishPanel', () => {
  it('renders all six steps with their states and shows Retry when the run failed', async () => {
    run = makeRun('failed', ['success', 'running', 'waiting', 'pending', 'cancelled', 'failed']);
    latestRun = { id: 'r1' };
    renderPanel();
    const steps = await screen.findByRole('list', { name: 'Publish steps' });
    const items = within(steps).getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('data-step'))).toEqual(STEP_NAMES);
    expect(items.map((li) => li.textContent)).toEqual([
      'Confluence pageSuccess',
      'Jira attachmentRunning',
      'Jira descriptionWaiting',
      'Jira commentPending',
      'Jira labelCancelled',
      'Downstream notificationFailed',
    ]);
    const retry = screen.getByRole('button', { name: 'Retry failed steps' }) as HTMLButtonElement;
    await waitFor(() => expect(retry.disabled).toBe(false));
    fireEvent.click(retry);
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/sessions/s1/publish/r1/retry', { method: 'POST', json: {} }),
    );
  });

  it('shows no Retry while the run is running or completed', async () => {
    run = makeRun('completed', ['success', 'success', 'success', 'success', 'success', 'success']);
    latestRun = { id: 'r1' };
    renderPanel();
    expect((await screen.findByRole('status')).textContent).toContain('Published');
    expect(screen.queryByRole('button', { name: 'Retry failed steps' })).toBeNull();
  });

  it('polls the run every 2 s until it finishes', async () => {
    vi.useFakeTimers();
    renderPanel();
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(apiFetch).toHaveBeenCalledWith('/api/sessions/s1/publish', { method: 'POST', json: {} });
    expect(runCalls()).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(runCalls()).toBe(2);
    run = makeRun('completed', ['success', 'success', 'success', 'success', 'success', 'success']);
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(runCalls()).toBe(3);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(runCalls()).toBe(3);
  });

  it('opens the override dialog on 409 gate_failed and publishes with the justification and confirmation', async () => {
    publishHandler = (json) => {
      if ((json as { confirmOverride?: boolean }).confirmOverride) return { runId: 'r1' };
      throw new ApiError('gate failed', 409, 'gate_failed', 'corr-1', {
        error: { code: 'gate_failed' },
        openCriticalIssues: [{ id: 'c1', section: 'Security', description: 'No auth model' }],
      });
    };
    renderPanel();
    await clickPublish();
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('No auth model');
    fireEvent.change(within(dialog).getByLabelText(/Justification/), {
      target: { value: 'Accepted by the architecture board' },
    });
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish with override' }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/sessions/s1/publish', {
        method: 'POST',
        json: { overrideJustification: 'Accepted by the architecture board', confirmOverride: true },
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByRole('list', { name: 'Publish steps' })).toBeTruthy();
  });

  it.each([
    ['Overwrite', 'overwrite'],
    ['Cancel', 'cancel'],
  ])('page_changed_externally offers %s which retries with confluenceAction %s', async (label, action) => {
    run = makeRun('failed', ['failed', 'pending', 'pending', 'pending', 'pending', 'pending'], {
      code: 'page_changed_externally',
      message: 'The Confluence page was edited externally',
    });
    latestRun = { id: 'r1' };
    renderPanel();
    expect(await screen.findByRole('button', { name: 'Overwrite' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry failed steps' })).toBeNull();
    const btn = screen.getByRole('button', { name: label }) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false));
    fireEvent.click(btn);
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/sessions/s1/publish/r1/retry', {
        method: 'POST',
        json: { confluenceAction: action },
      }),
    );
  });

  it('disables Publish and Retry in read-only mode', async () => {
    lockHolder = 'other';
    run = makeRun('failed', ['success', 'failed', 'pending', 'pending', 'pending', 'pending']);
    latestRun = { id: 'r1' };
    renderPanel();
    const retry = (await screen.findByRole('button', { name: 'Retry failed steps' })) as HTMLButtonElement;
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/sessions/s1/lock', { method: 'POST' }));
    expect(retry.disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
