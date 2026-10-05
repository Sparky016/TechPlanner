import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspace, WorkspaceProvider, type WorkspaceValue } from '@/components/workspace/WorkspaceProvider';
import { ReadinessPanel, type Readiness } from '@/components/workspace/right/ReadinessPanel';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', async (orig) => ({ ...(await orig<typeof import('@/lib/api/client')>()), apiFetch }));

let lockHolder: 'you' | 'other' = 'you';
let readiness: Readiness;

function baseReadiness(overrides: Partial<Readiness> = {}): Readiness {
  return {
    score: 72,
    statuses: { Scope: 'complete', Security: 'missing', APIs: 'partial' },
    issues: [],
    openQuestions: [],
    gatePasses: true,
    clarificationEnded: false,
    evaluatedAt: null,
    evaluationPending: false,
    ...overrides,
  };
}

beforeEach(() => {
  lockHolder = 'you';
  readiness = baseReadiness();
  apiFetch.mockImplementation(async (path: string) => {
    if (path.endsWith('/lock')) return { holder: lockHolder, expiresAt: null };
    if (path.endsWith('/readiness')) return readiness;
    if (path.endsWith('/end-clarification')) {
      readiness = { ...readiness, clarificationEnded: true };
      return { clarificationEnded: true };
    }
    return {};
  });
});

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
  vi.useRealTimers();
});

let workspace: WorkspaceValue | null = null;
function Capture() {
  workspace = useWorkspace();
  return null;
}

function renderPanel() {
  render(
    <WorkspaceProvider sessionId="s1">
      <Capture />
      <ReadinessPanel />
    </WorkspaceProvider>,
  );
}

const readinessCalls = () => apiFetch.mock.calls.filter(([p]) => p === '/api/sessions/s1/readiness').length;

describe('ReadinessPanel', () => {
  it("shows 'Ready' with an informational score and missing sections when the gate passes", async () => {
    renderPanel();
    const gate = await screen.findByTestId('gate-status');
    expect(gate.textContent).toContain('Ready');
    expect(gate.textContent).toContain('Score (informational): 72');
    expect(screen.getByRole('region', { name: 'Missing sections' }).textContent).toContain('Security');
  });

  it('lists critical issues when the gate fails and hides Accept risk for critical issues only', async () => {
    readiness = baseReadiness({
      gatePasses: false,
      issues: [
        { id: 'c1', severity: 'critical', section: 'Security', description: 'No auth <script>x</script>', status: 'open' },
        { id: 'w1', severity: 'warning', section: 'APIs', description: 'Pagination unclear', status: 'open' },
        { id: 'n1', severity: 'informational', section: 'Scope', description: 'Consider phasing', status: 'open' },
      ],
      openQuestions: [{ id: 'q1', issueId: null, section: 'Scope', text: 'Which regions?' }],
    });
    renderPanel();
    expect((await screen.findByTestId('gate-status')).textContent).toContain('1 critical issue open');
    const critical = screen.getByRole('region', { name: 'Critical issues' });
    expect(critical.textContent).toContain('No auth <script>x</script>');
    expect(within(critical).queryByRole('button', { name: 'Accept risk' })).toBeNull();
    expect(within(screen.getByRole('region', { name: 'Warnings' })).getByRole('button', { name: 'Accept risk' })).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Informational' })).getByRole('button', { name: 'Accept risk' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Action items' }).textContent).toContain('Which regions?');
  });

  it('Accept risk calls the endpoint for the issue', async () => {
    readiness = baseReadiness({
      issues: [{ id: 'w1', severity: 'warning', section: 'APIs', description: 'Pagination unclear', status: 'open' }],
    });
    renderPanel();
    const btn = (await screen.findByRole('button', { name: 'Accept risk' })) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false));
    fireEvent.click(btn);
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/sessions/s1/issues/w1/accept-risk', { method: 'POST' }),
    );
  });

  it('End clarification calls the endpoint and reflects clarificationEnded', async () => {
    renderPanel();
    const btn = (await screen.findByRole('button', { name: 'End clarification' })) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false));
    fireEvent.click(btn);
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/sessions/s1/end-clarification', { method: 'POST' }),
    );
    expect(await screen.findByText('Clarification ended')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'End clarification' })).toBeNull();
  });

  it('Evaluate now calls the endpoint', async () => {
    renderPanel();
    const btn = (await screen.findByRole('button', { name: 'Evaluate now' })) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false));
    fireEvent.click(btn);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/sessions/s1/evaluate', { method: 'POST' }));
  });

  it('disables the controls in read-only mode', async () => {
    lockHolder = 'other';
    readiness = baseReadiness({
      issues: [{ id: 'w1', severity: 'warning', section: 'APIs', description: 'Pagination unclear', status: 'open' }],
    });
    renderPanel();
    await screen.findByTestId('gate-status');
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/sessions/s1/lock', { method: 'POST' }));
    for (const name of ['Evaluate now', 'End clarification', 'Accept risk']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('polls every 5 s while an evaluation is pending and stops afterwards', async () => {
    vi.useFakeTimers();
    readiness = baseReadiness({ evaluationPending: true });
    renderPanel();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(readinessCalls()).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(readinessCalls()).toBe(2);
    readiness = baseReadiness({ evaluationPending: false });
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(readinessCalls()).toBe(3);
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(readinessCalls()).toBe(3);
  });

  it("reloads after each AI turn 'done' event", async () => {
    renderPanel();
    await screen.findByTestId('gate-status');
    expect(readinessCalls()).toBe(1);
    act(() => workspace!.publish({ type: 'done', messageSeq: 3 }));
    await waitFor(() => expect(readinessCalls()).toBe(2));
  });
});
