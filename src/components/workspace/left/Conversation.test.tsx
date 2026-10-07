import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceProvider } from '@/components/workspace/WorkspaceProvider';
import { Conversation } from '@/components/workspace/left/Conversation';
import type { TurnEvent } from '@/lib/api/sse';

const apiFetch = vi.hoisted(() => vi.fn());
const streamMessage = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', async (orig) => ({ ...(await orig<typeof import('@/lib/api/client')>()), apiFetch }));
vi.mock('@/lib/api/sse', async (orig) => ({ ...(await orig<typeof import('@/lib/api/sse')>()), streamMessage }));

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
  streamMessage.mockReset();
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

describe('Conversation', () => {
  it('renders streamed tokens incrementally and disables send while streaming', async () => {
    const s = controlledStream();
    streamMessage.mockReturnValue(s.gen());
    await renderAndSend('What is the scope?');

    expect(streamMessage).toHaveBeenCalledWith('s1', 'What is the scope?');
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
    streamMessage.mockReturnValue(s.gen());
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
    streamMessage.mockImplementation(() => {
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
});
