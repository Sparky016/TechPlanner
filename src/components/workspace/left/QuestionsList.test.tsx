import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceProvider } from '@/components/workspace/WorkspaceProvider';
import { QuestionsList } from '@/components/workspace/left/QuestionsList';

const apiFetch = vi.hoisted(() => vi.fn());
const streamTurn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', async (orig) => ({ ...(await orig<typeof import('@/lib/api/client')>()), apiFetch }));
vi.mock('@/lib/api/sse', async (orig) => ({ ...(await orig<typeof import('@/lib/api/sse')>()), streamTurn }));

const base = {
  issueId: null,
  dismissReason: null,
  answerText: null,
  answeredAt: null,
  answeredVia: null,
  resolution: null,
  resolvedAt: null,
  createdAt: '',
};
const QUESTIONS = [
  { ...base, id: 'q1', section: 'Scope', text: 'Which regions?', status: 'open', createdAt: '2026-01-02' },
  { ...base, id: 'q0', section: null, text: 'Older open?', status: 'open', createdAt: '2026-01-01' },
  { ...base, id: 'q2', text: 'Who owns it?', section: null, status: 'answered', answerText: 'The platform team', answeredVia: 'facilitator' },
  { ...base, id: 'q4', text: 'Auto?', section: null, status: 'answered', answerText: 'Discussed', answeredVia: 'ai' },
  { ...base, id: 'q3', text: 'Budget?', section: null, status: 'resolved', resolution: 'not_relevant', dismissReason: 'Out of scope' },
];

let lockHolder: 'you' | 'other' = 'you';

beforeEach(() => {
  lockHolder = 'you';
  apiFetch.mockImplementation(async (path: string) => {
    if (path.endsWith('/lock')) return { holder: lockHolder, expiresAt: null };
    if (path.endsWith('/questions')) return { questions: QUESTIONS };
    return {};
  });
});

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
  streamTurn.mockReset();
});

function renderList() {
  render(
    <WorkspaceProvider sessionId="s1">
      <QuestionsList />
    </WorkspaceProvider>,
  );
}

async function ready(text = 'Which regions?') {
  const li = (await screen.findByText(text)).closest('li')!;
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/sessions/s1/lock', { method: 'POST' }));
  return li;
}

function stream(events: unknown[], gate?: Promise<void>) {
  return (async function* () {
    for (const e of events) {
      if (gate) await gate;
      yield e;
    }
  })();
}

describe('QuestionsList', () => {
  it('renders three groups with counts and Resolved collapsed', async () => {
    renderList();
    await screen.findByText('Which regions?');
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Questions · 2 open · 2 answered');
    const open = screen.getByRole('group', { name: 'Open (2)' });
    expect(within(open).getAllByRole('listitem').map((li) => li.textContent)[0]).toContain('Older open?');
    const answered = screen.getByRole('group', { name: 'Answered — awaiting resolve (2)' });
    expect(within(answered).getByText('Answered in discussion (AI summary)')).toBeTruthy();
    expect(within(answered).getByText('The platform team')).toBeTruthy();
    expect(screen.queryByText('Budget?')).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Resolved (1)' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    const resolved = screen.getByText('Budget?').closest('li')!;
    expect(resolved.textContent).toContain('Resolved — not relevant');
    expect(resolved.textContent).toContain('Out of scope');
    expect(within(resolved).getByRole('button', { name: 'Reopen' })).toBeTruthy();
  });

  it('answers inline, shows progress, then patched sections', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    streamTurn.mockReturnValue(
      stream([{ type: 'patch', section: 'Scope', version: 2 }, { type: 'suggestion', suggestionId: 's1', section: 'Risks' }, { type: 'done', messageSeq: 3 }], gate),
    );
    renderList();
    const li = await ready();
    fireEvent.click(within(li).getByRole('button', { name: 'Answer' }));
    const textarea = within(li).getByLabelText('Your answer') as HTMLTextAreaElement;
    expect(document.activeElement).toBe(textarea);
    fireEvent.change(textarea, { target: { value: 'EU only' } });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    await waitFor(() =>
      expect(streamTurn).toHaveBeenCalledWith('/api/sessions/s1/questions/q1/answer', { text: 'EU only' }, expect.any(AbortSignal)),
    );
    expect(await screen.findByText('AI is updating the specification…')).toBeTruthy();
    release();
    const done = await screen.findByText(/Updated sections: Scope\. 1 suggestion pending\./);
    expect(done).toBeTruthy();
    expect(screen.queryByText('AI is updating the specification…')).toBeNull();
  });

  it('restores the text when the answer is rejected before streaming', async () => {
    streamTurn.mockImplementation(() => {
      throw Object.assign(new Error('busy'), {});
    });
    renderList();
    const li = await ready();
    fireEvent.click(within(li).getByRole('button', { name: 'Answer' }));
    fireEvent.change(within(li).getByLabelText('Your answer'), { target: { value: 'EU only' } });
    fireEvent.click(within(li).getByRole('button', { name: 'Send answer' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect((screen.getByLabelText('Your answer') as HTMLTextAreaElement).value).toBe('EU only');
  });

  it('shows the AI unavailable banner when the stream errors after the answer is saved', async () => {
    streamTurn.mockReturnValue(stream([{ type: 'token', text: 'x' }, { type: 'error', code: 'ai_unavailable', message: 'down' }]));
    renderList();
    const li = await ready();
    fireEvent.click(within(li).getByRole('button', { name: 'Answer' }));
    fireEvent.change(within(li).getByLabelText('Your answer'), { target: { value: 'EU only' } });
    fireEvent.click(within(li).getByRole('button', { name: 'Send answer' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'AI unavailable: your answer was saved but not yet worked into the specification. Use Edit answer to resend.',
    );
  });

  it('cancel returns focus to the Answer button', async () => {
    renderList();
    const li = await ready();
    const answer = within(li).getByRole('button', { name: 'Answer' });
    fireEvent.click(answer);
    fireEvent.click(within(li).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.activeElement).toBe(within(li).getByRole('button', { name: 'Answer' })));
  });

  it('Edit answer prefills the form', async () => {
    renderList();
    const li = await ready('Who owns it?');
    fireEvent.click(within(li).getByRole('button', { name: 'Edit answer' }));
    expect((within(li).getByLabelText('Your answer') as HTMLTextAreaElement).value).toBe('The platform team');
  });

  it('resolve as not relevant sends the reason; Resolve on answered sends no body; Reopen posts', async () => {
    renderList();
    const open = await ready();
    fireEvent.click(within(open).getByRole('button', { name: 'Resolve as not relevant' }));
    fireEvent.change(within(open).getByLabelText('Reason (optional)'), { target: { value: 'Not needed' } });
    fireEvent.click(within(open).getByRole('button', { name: 'Confirm resolve' }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/sessions/s1/questions/q1/resolve', { method: 'POST', json: { reason: 'Not needed' } }),
    );

    const answered = screen.getByText('Who owns it?').closest('li')!;
    fireEvent.click(within(answered).getByRole('button', { name: 'Resolve' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/sessions/s1/questions/q2/resolve', { method: 'POST' }));

    fireEvent.click(screen.getByRole('button', { name: 'Resolved (1)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/sessions/s1/questions/q3/reopen', { method: 'POST' }));
  });

  it('disables actions in read-only mode', async () => {
    lockHolder = 'other';
    renderList();
    await ready();
    for (const name of ['Answer', 'Resolve as not relevant', 'Resolve', 'Edit answer']) {
      for (const b of screen.getAllByRole('button', { name })) expect((b as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('disables actions while a turn runs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    streamTurn.mockReturnValue(stream([{ type: 'done', messageSeq: 1 }], gate));
    renderList();
    const li = await ready();
    fireEvent.click(within(li).getByRole('button', { name: 'Answer' }));
    fireEvent.change(within(li).getByLabelText('Your answer'), { target: { value: 'x' } });
    fireEvent.click(within(li).getByRole('button', { name: 'Send answer' }));
    await screen.findByText('AI is updating the specification…');
    for (const b of screen.getAllByRole('button', { name: 'Resolve' })) expect((b as HTMLButtonElement).disabled).toBe(true);
    release();
    await waitFor(() => expect(screen.queryByText('AI is updating the specification…')).toBeNull());
  });
});
