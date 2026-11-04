import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspace, WorkspaceProvider, type WorkspaceValue } from '@/components/workspace/WorkspaceProvider';
import { Conversation } from '@/components/workspace/left/Conversation';
import type { TurnEvent } from '@/lib/api/sse';

const apiFetch = vi.hoisted(() => vi.fn());
const streamTurn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', async (orig) => ({ ...(await orig<typeof import('@/lib/api/client')>()), apiFetch }));
vi.mock('@/lib/api/sse', async (orig) => ({ ...(await orig<typeof import('@/lib/api/sse')>()), streamTurn }));

// A stream whose events are pushed by the test, so intermediate renders can be observed.
function controlledStream() {
  const queue: (TurnEvent | null)[] = [];
  let wake: (() => void) | null = null;
  async function* gen(): AsyncGenerator<TurnEvent> {
    for (;;) {
      while (queue.length === 0) await new Promise<void>((r) => (wake = r));
      const next = queue.shift()!;
      if (next === null) return;
      yield next;
    }
  }
  const push = (e: TurnEvent | null) => {
    queue.push(e);
    wake?.();
    wake = null;
  };
  return { gen, push };
}

beforeEach(() => {
  apiFetch.mockImplementation(async (path: string) => {
    if (path.endsWith('/lock')) return { holder: 'you', expiresAt: null };
    if (path.endsWith('/messages')) return { messages: [] };
    return { session: null, sources: [] };
  });
});

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
  streamTurn.mockReset();
});

async function renderAndSend(text: string) {
  render(
    <WorkspaceProvider sessionId="s1">
      <Conversation />
    </WorkspaceProvider>,
  );
  const send = screen.getByRole('button', { name: 'Send' });
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/sessions/s1/lock', { method: 'POST' }));
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: text } });
  await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(send);
}

let workspace: WorkspaceValue | null = null;
function Capture() {
  workspace = useWorkspace();
  return null;
}

describe('Conversation', () => {
  it('disables Send while a turn started elsewhere streams, shows its reply, and refuses a second turn', async () => {
    const s = controlledStream();
    streamTurn.mockReturnValue(s.gen());
    render(
      <WorkspaceProvider sessionId="s1">
        <Capture />
        <Conversation />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/sessions/s1/lock', { method: 'POST' }));
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Queued' } });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false));

    let first!: Promise<unknown>;
    act(() => {
      first = workspace!.runTurn({ path: '/analyze', label: 'Analysis' });
    });
    expect((screen.getByRole('button', { name: 'AI is responding…' }) as HTMLButtonElement).disabled).toBe(true);
    const second = await workspace!.runTurn({ path: '/analyze', label: 'Analysis' });
    expect(second).toMatchObject({ ok: false, started: false, error: { code: 'turn_in_progress' } });
    expect(streamTurn).toHaveBeenCalledTimes(1);
    expect(streamTurn).toHaveBeenCalledWith('/api/sessions/s1/analyze', undefined, expect.any(AbortSignal));

    await act(async () => s.push({ type: 'token', text: 'Summary' }));
    await waitFor(() => expect(screen.getByTestId('streaming-reply').textContent).toContain('Summary'));
    await act(async () => {
      s.push({ type: 'done', messageSeq: 3 });
      s.push(null);
      await first;
    });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false));
    expect(await first).toEqual({ ok: true, started: true, error: null });
  });


  it('renders streamed tokens incrementally and disables send while streaming', async () => {
    const s = controlledStream();
    streamTurn.mockReturnValue(s.gen());
    await renderAndSend('What is the scope?');

    expect(streamTurn).toHaveBeenCalledWith('/api/sessions/s1/messages', { text: 'What is the scope?' }, expect.any(AbortSignal));
    await act(async () => s.push({ type: 'token', text: 'The ' }));
    await waitFor(() => expect(screen.getByTestId('streaming-reply').textContent).toContain('The'));
    expect((screen.getByRole('button', { name: 'AI is responding…' }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => s.push({ type: 'token', text: 'scope is X.' }));
    await waitFor(() => expect(screen.getByTestId('streaming-reply').textContent).toContain('The scope is X.'));

    await act(async () => {
      s.push({ type: 'done', messageSeq: 2 });
      s.push(null);
    });
    await waitFor(() => expect(screen.queryByTestId('streaming-reply')).toBeNull());
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });

  it('shows the error message with its correlation id on an error event', async () => {
    const s = controlledStream();
    streamTurn.mockReturnValue(s.gen());
    await renderAndSend('Hi');
    await act(async () => {
      s.push({ type: 'token', text: 'Partial' });
      s.push({ type: 'error', code: 'ai_unavailable', message: 'Model timed out.', correlationId: 'corr-42' });
      s.push(null);
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('AI unavailable');
    expect(alert.textContent).toContain('corr-42');
    // Editing stays enabled after the failure.
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('shows a request error such as turn_in_progress with its correlation id', async () => {
    const { ApiError } = await import('@/lib/api/client');
    streamTurn.mockImplementation(() => {
      throw new ApiError('A facilitator turn is already in progress', 409, 'turn_in_progress', 'corr-9', null);
    });
    await renderAndSend('Again');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('already in progress');
    expect(alert.textContent).toContain('corr-9');
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('Again');
  });

  it('renders notes as context-only and distinct from messages', async () => {
    apiFetch.mockImplementation(async (path: string) => {
      if (path.endsWith('/lock')) return { holder: 'you', expiresAt: null };
      if (path.endsWith('/messages')) {
        return {
          messages: [
            { seq: 1, role: 'facilitator', content: 'Hello', createdAt: '' },
            { seq: 2, role: 'note', content: '<b>remember</b>', createdAt: '' },
          ],
        };
      }
      return {};
    });
    render(
      <WorkspaceProvider sessionId="s1">
        <Conversation />
      </WorkspaceProvider>,
    );
    const note = await screen.findByText('<b>remember</b>');
    const item = note.closest('li')!;
    expect(item.getAttribute('data-role')).toBe('note');
    expect(item.textContent).toContain('context only');
    expect(item.querySelector('b')).toBeNull();
  });

  function mockApi(opts: { intakeState?: string; questions?: { id: string; text: string }[]; messages?: unknown[] }) {
    apiFetch.mockImplementation(async (path: string) => {
      if (path.endsWith('/lock')) return { holder: 'you', expiresAt: null };
      if (path.endsWith('/messages')) return { messages: opts.messages ?? [] };
      if (path.endsWith('/questions')) return { questions: opts.questions ?? [] };
      return { session: { intakeState: opts.intakeState ?? 'analyzed' }, sources: [] };
    });
  }

  it('is collapsed once questions exist, and a turn started elsewhere streams in and expands it', async () => {
    window.localStorage.clear();
    mockApi({ questions: [{ id: 'q1', text: 'Which regions?' }] });
    const s = controlledStream();
    streamTurn.mockReturnValue(s.gen());
    render(
      <WorkspaceProvider sessionId="s1">
        <Capture />
        <Conversation />
      </WorkspaceProvider>,
    );
    const toggle = await screen.findByRole('button', { name: 'Discuss with AI' });
    await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('false'));
    expect(screen.getByRole('region', { name: 'Discuss with AI' })).toBeTruthy();

    let turn!: Promise<unknown>;
    act(() => {
      turn = workspace!.runTurn({ path: '/answer', label: 'Answer', prompt: 'It is EU only' });
    });
    await act(async () => s.push({ type: 'token', text: 'Noted.' }));
    await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('true'));
    expect(screen.getByTestId('streaming-reply').textContent).toContain('Noted.');
    expect(screen.getByText('It is EU only')).toBeTruthy();
    await act(async () => {
      s.push({ type: 'done', messageSeq: 2 });
      s.push(null);
      await turn;
    });
  });

  it('remembers the open state per session in localStorage', async () => {
    window.localStorage.clear();
    mockApi({ questions: [{ id: 'q1', text: 'Which regions?' }] });
    render(
      <WorkspaceProvider sessionId="s1">
        <Conversation />
      </WorkspaceProvider>,
    );
    const toggle = await screen.findByRole('button', { name: 'Discuss with AI' });
    await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('false'));
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(window.localStorage.getItem('techplanner.discuss-open.s1')).toBe('1');
    cleanup();
    render(
      <WorkspaceProvider sessionId="s1">
        <Conversation />
      </WorkspaceProvider>,
    );
    const again = await screen.findByRole('button', { name: 'Discuss with AI' });
    await waitFor(() => expect(again.getAttribute('aria-expanded')).toBe('true'));
  });

  it('labels answer messages with the (truncated) question text', async () => {
    window.localStorage.clear();
    const long = 'Q'.repeat(200);
    mockApi({
      questions: [
        { id: 'q1', text: 'Which regions?' },
        { id: 'q2', text: long },
      ],
      messages: [
        { seq: 1, role: 'facilitator', content: 'EU only', createdAt: '', questionId: 'q1' },
        { seq: 2, role: 'facilitator', content: 'Long one', createdAt: '', questionId: 'q2' },
        { seq: 3, role: 'facilitator', content: 'Plain', createdAt: '', questionId: null },
      ],
    });
    render(
      <WorkspaceProvider sessionId="s1">
        <Conversation />
      </WorkspaceProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Discuss with AI' }));
    expect(await screen.findByText('Answer to: Which regions?')).toBeTruthy();
    const truncated = screen.getByText(/^Answer to: Q+…$/);
    expect(truncated.textContent!.length).toBe('Answer to: '.length + 120);
    expect(screen.getAllByText(/^Answer to:/)).toHaveLength(2);
  });

  it('is disabled with a hint before ingestion', async () => {
    window.localStorage.clear();
    mockApi({ intakeState: 'not_ingested' });
    render(
      <WorkspaceProvider sessionId="s1">
        <Conversation />
      </WorkspaceProvider>,
    );
    const toggle = (await screen.findByRole('button', { name: 'Discuss with AI' })) as HTMLButtonElement;
    expect(await screen.findByText('Ingest the ticket to start the discussion.')).toBeTruthy();
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByLabelText('Message', { selector: 'textarea' }).closest('[hidden]')).not.toBeNull();
  });
});
