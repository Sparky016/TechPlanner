import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceProvider } from '@/components/workspace/WorkspaceProvider';
import { QuestionsList } from '@/components/workspace/left/QuestionsList';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', async (orig) => ({ ...(await orig<typeof import('@/lib/api/client')>()), apiFetch }));

const QUESTIONS = [
  { id: 'q1', issueId: null, section: 'Scope', text: 'Which regions?', status: 'open', dismissReason: null, createdAt: '' },
  { id: 'q2', issueId: null, section: null, text: 'Who owns it?', status: 'answered', dismissReason: null, createdAt: '' },
  { id: 'q3', issueId: null, section: null, text: 'Budget?', status: 'dismissed', dismissReason: 'Out of scope', createdAt: '' },
];

let lockHolder: 'you' | 'other' = 'you';

beforeEach(() => {
  lockHolder = 'you';
  apiFetch.mockImplementation(async (path: string) => {
    if (path.endsWith('/lock')) return { holder: lockHolder, expiresAt: null };
    if (path.endsWith('/questions')) return { questions: QUESTIONS };
    if (path.endsWith('/dismiss')) return { id: 'q1', status: 'dismissed', dismissReason: 'Not needed' };
    return {};
  });
});

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
});

function renderList() {
  render(
    <WorkspaceProvider sessionId="s1">
      <QuestionsList />
    </WorkspaceProvider>,
  );
}

describe('QuestionsList', () => {
  it('shows open, answered and dismissed questions with their status', async () => {
    renderList();
    const open = (await screen.findByText('Which regions?')).closest('li')!;
    expect(open.textContent).toContain('Open');
    expect(screen.getByText('Who owns it?').closest('li')!.textContent).toContain('Answered');
    const dismissed = screen.getByText('Budget?').closest('li')!;
    expect(dismissed.textContent).toContain('Dismissed');
    expect(dismissed.textContent).toContain('Out of scope');
    // Only open questions can be dismissed.
    expect(screen.getAllByRole('button', { name: 'Dismiss' })).toHaveLength(1);
  });

  it('dismiss sends the entered reason', async () => {
    renderList();
    const open = (await screen.findByText('Which regions?')).closest('li')!;
    const dismiss = within(open).getByRole('button', { name: 'Dismiss' }) as HTMLButtonElement;
    await waitFor(() => expect(dismiss.disabled).toBe(false));
    fireEvent.click(dismiss);
    fireEvent.change(within(open).getByLabelText('Reason (optional)'), { target: { value: 'Not needed' } });
    fireEvent.click(within(open).getByRole('button', { name: 'Confirm dismiss' }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/sessions/s1/questions/q1/dismiss', {
        method: 'POST',
        json: { reason: 'Not needed' },
      }),
    );
  });

  it('disables dismiss in read-only mode', async () => {
    lockHolder = 'other';
    renderList();
    await screen.findByText('Which regions?');
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/sessions/s1/lock', { method: 'POST' }));
    expect((screen.getByRole('button', { name: 'Dismiss' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
