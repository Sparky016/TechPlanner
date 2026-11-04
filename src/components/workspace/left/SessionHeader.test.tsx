import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspace, WorkspaceProvider, type SessionInfo } from '@/components/workspace/WorkspaceProvider';
import { Conversation } from '@/components/workspace/left/Conversation';
import { SessionHeader } from '@/components/workspace/left/SessionHeader';
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

async function* events(...list: TurnEvent[]): AsyncGenerator<TurnEvent> {
  for (const e of list) yield e;
}

let intakeState: SessionInfo['intakeState'];
let lockHolder: 'you' | 'other';
let ticketKeys: string[];
let ingestError: Error | null;

function session(): SessionInfo {
  return {
    id: 's1',
    primaryTicketKey: ticketKeys[0],
    ticketKeys,
    facilitatorId: 'u1',
    status: 'draft',
    clarificationEnded: false,
    codeRepository: null,
    confluencePageId: null,
    confluencePageVersion: null,
    ingestedAt: intakeState === 'not_ingested' ? null : '2026-10-29T10:00:00.000Z',
    analyzedAt: intakeState === 'analyzed' ? '2026-10-29T10:01:00.000Z' : null,
    intakeState,
    createdAt: '2026-10-29T09:00:00.000Z',
    updatedAt: '2026-10-29T09:00:00.000Z',
  };
}

const SOURCE = {
  id: 'src1',
  kind: 'jira_issue',
  ref: 'ABC-1',
  title: 'ABC-1 Login',
  ingestStatus: 'ingested',
  detail: {},
  retrievedAt: '2026-10-29T10:00:00.000Z',
};

beforeEach(() => {
  intakeState = 'not_ingested';
  lockHolder = 'you';
  ticketKeys = ['ABC-1'];
  ingestError = null;
  window.history.replaceState(null, '', '/sessions/s1');
  apiFetch.mockImplementation(async (path: string) => {
    if (path.endsWith('/lock')) return { holder: lockHolder, expiresAt: null };
    if (path === '/api/azure-devops/status') return { configured: false, checkedAt: '' };
    if (path.endsWith('/messages')) return { messages: [] };
    if (path.endsWith('/ingest')) {
      if (ingestError) throw ingestError;
      intakeState = 'ingested';
      return { ingestedAt: '2026-10-29T10:00:00.000Z', sources: [SOURCE] };
    }
    if (path.endsWith('/refresh-sources')) return { changes: [] };
    if (path === '/api/sessions/s1') {
      return { session: session(), sources: intakeState === 'not_ingested' ? [] : [SOURCE], publish: null };
    }
    return {};
  });
});

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
  streamTurn.mockReset();
});

const analyzeCalls = () => streamTurn.mock.calls.filter(([p]) => p === '/api/sessions/s1/analyze');
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

function renderHeader({ withConversation = false, strict = false } = {}) {
  const tree = (
    <WorkspaceProvider sessionId="s1">
      <SessionHeader />
      {withConversation ? <Conversation /> : null}
    </WorkspaceProvider>
  );
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

async function lockAcquired() {
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/sessions/s1/lock', { method: 'POST' }));
}

describe('SessionHeader intake controls', () => {
  it('not_ingested: shows Ingest ticket, a checked Analyze after ingest box and no sources list', async () => {
    renderHeader();
    expect(await screen.findByText('Sources not ingested yet.')).toBeTruthy();
    await waitFor(() => expect(button('Ingest ticket').disabled).toBe(false));
    expect((screen.getByLabelText('Analyze after ingest') as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole('button', { name: 'Refresh sources' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Sources' })).toBeNull();
  });

  it("labels the button 'Ingest tickets' for more than one key", async () => {
    ticketKeys = ['ABC-1', 'ABC-2'];
    renderHeader();
    expect(await screen.findByRole('button', { name: 'Ingest tickets' })).toBeTruthy();
  });

  it('checked: Ingest calls /ingest, reloads, then streams /analyze and announces progress', async () => {
    const s = controlledStream();
    streamTurn.mockReturnValue(s.gen());
    renderHeader();
    await lockAcquired();
    await waitFor(() => expect(button('Ingest ticket').disabled).toBe(false));
    fireEvent.click(button('Ingest ticket'));

    await waitFor(() => expect(analyzeCalls()).toHaveLength(1));
    expect(apiFetch).toHaveBeenCalledWith('/api/sessions/s1/ingest', { method: 'POST' });
    const ingestOrder = apiFetch.mock.invocationCallOrder[apiFetch.mock.calls.findIndex(([p]) => p.endsWith('/ingest'))];
    expect(ingestOrder).toBeLessThan(streamTurn.mock.invocationCallOrder[0]);
    expect(analyzeCalls()[0]).toEqual(['/api/sessions/s1/analyze', undefined, expect.any(AbortSignal)]);
    expect(screen.getByTestId('intake-status').textContent).toBe('Analyzing ABC-1…');
    expect(screen.getByTestId('intake-status').getAttribute('aria-live')).toBe('polite');
    expect(await screen.findByText('ABC-1 Login')).toBeTruthy();
    expect(button('Refresh sources').disabled).toBe(true);

    intakeState = 'analyzed';
    await act(async () => {
      s.push({ type: 'done', messageSeq: 2 });
      s.push(null);
    });
    await waitFor(() => expect(screen.getByTestId('intake-status').textContent).toBe(''));
    await waitFor(() => expect(button('Refresh sources').disabled).toBe(false));
    expect(screen.queryByRole('button', { name: 'Analyze ticket' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('unchecked: Ingest calls only /ingest and then shows Analyze ticket, which starts the analysis', async () => {
    renderHeader();
    await lockAcquired();
    await waitFor(() => expect(button('Ingest ticket').disabled).toBe(false));
    fireEvent.click(screen.getByLabelText('Analyze after ingest'));
    fireEvent.click(button('Ingest ticket'));

    expect(await screen.findByRole('button', { name: 'Analyze ticket' })).toBeTruthy();
    expect(apiFetch).toHaveBeenCalledWith('/api/sessions/s1/ingest', { method: 'POST' });
    expect(streamTurn).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Ingest ticket' })).toBeNull();

    streamTurn.mockReturnValue(events({ type: 'done', messageSeq: 2 }));
    intakeState = 'analyzed';
    fireEvent.click(button('Analyze ticket'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Analyze ticket' })).toBeNull());
    expect(analyzeCalls()).toHaveLength(1);
  });

  it('an ingest failure shows the error with its correlation id and keeps the Ingest button', async () => {
    const { ApiError } = await import('@/lib/api/client');
    ingestError = new ApiError('Jira is unavailable', 500, 'upstream_error', 'corr-7', null);
    renderHeader();
    await lockAcquired();
    await waitFor(() => expect(button('Ingest ticket').disabled).toBe(false));
    fireEvent.click(button('Ingest ticket'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Jira is unavailable');
    expect(alert.textContent).toContain('corr-7');
    expect(button('Ingest ticket').disabled).toBe(false);
    expect(streamTurn).not.toHaveBeenCalled();
  });

  it('a failed chained analysis shows the sources, an error in the Sources block and Analyze ticket', async () => {
    streamTurn.mockReturnValue(
      events({ type: 'error', code: 'ai_unavailable', message: 'Model timed out.', correlationId: 'corr-8' }),
    );
    renderHeader();
    await lockAcquired();
    await waitFor(() => expect(button('Ingest ticket').disabled).toBe(false));
    fireEvent.click(button('Ingest ticket'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('AI unavailable');
    expect(alert.textContent).toContain('corr-8');
    expect(screen.getByText('ABC-1 Login')).toBeTruthy();
    expect(button('Analyze ticket').disabled).toBe(false);
  });

  it('?ingest=failed shows the creation failure above Ingest ticket and removes the parameter', async () => {
    window.history.replaceState(null, '', '/sessions/s1?ingest=failed&tab=x');
    renderHeader();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Ingest during creation failed. Try Ingest ticket again.');
    expect(window.location.search).toBe('?tab=x');
    expect(button('Ingest ticket')).toBeTruthy();
    // A later attempt clears the stale banner.
    await waitFor(() => expect(button('Ingest ticket').disabled).toBe(false));
    fireEvent.click(screen.getByLabelText('Analyze after ingest'));
    fireEvent.click(button('Ingest ticket'));
    await screen.findByRole('button', { name: 'Analyze ticket' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows no creation failure banner without the parameter', async () => {
    renderHeader();
    await screen.findByText('Sources not ingested yet.');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('disables Ingest/Analyze/Refresh and the checkbox when read-only', async () => {
    lockHolder = 'other';
    renderHeader();
    await lockAcquired();
    await screen.findByRole('button', { name: 'Ingest ticket' });
    expect(button('Ingest ticket').disabled).toBe(true);
    expect((screen.getByLabelText('Analyze after ingest') as HTMLInputElement).disabled).toBe(true);
  });
});

describe('one turn at a time (GI-22)', () => {
  beforeEach(() => {
    intakeState = 'ingested';
  });

  it('an analysis started from the Sources block disables Send, Analyze and Refresh', async () => {
    const s = controlledStream();
    streamTurn.mockReturnValue(s.gen());
    renderHeader({ withConversation: true });
    await lockAcquired();
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hello' } });
    await waitFor(() => expect(button('Analyze ticket').disabled).toBe(false));
    await waitFor(() => expect(button('Send').disabled).toBe(false));

    fireEvent.click(button('Analyze ticket'));
    await waitFor(() => expect(button('AI is responding…').disabled).toBe(true));
    expect(button('Refresh sources').disabled).toBe(true);
    await act(async () => s.push({ type: 'token', text: 'Understanding: …' }));
    await waitFor(() => expect(screen.getByTestId('streaming-reply').textContent).toContain('Understanding'));

    await act(async () => {
      s.push({ type: 'error', code: 'ai_unavailable', message: 'Down.' });
      s.push(null);
    });
    await waitFor(() => expect(button('Send').disabled).toBe(false));
    expect(button('Analyze ticket').disabled).toBe(false);
  });

  it('a message streaming from Conversation disables Analyze ticket and Refresh sources', async () => {
    const s = controlledStream();
    streamTurn.mockReturnValue(s.gen());
    renderHeader({ withConversation: true });
    await lockAcquired();
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'What is the scope?' } });
    await waitFor(() => expect(button('Send').disabled).toBe(false));
    fireEvent.click(button('Send'));

    await waitFor(() => expect(button('Analyze ticket').disabled).toBe(true));
    expect(button('Refresh sources').disabled).toBe(true);
    await act(async () => {
      s.push({ type: 'done', messageSeq: 2 });
      s.push(null);
    });
    await waitFor(() => expect(button('Analyze ticket').disabled).toBe(false));
    expect(analyzeCalls()).toHaveLength(0);
  });

  it('disables Ingest while a turn streams (not_ingested)', async () => {
    intakeState = 'not_ingested';
    const s = controlledStream();
    streamTurn.mockReturnValue(s.gen());
    // The discussion is disabled before ingestion (GI-20), so start the turn through the provider directly.
    let run!: () => Promise<unknown>;
    function Starter() {
      const { runTurn } = useWorkspace();
      run = () => runTurn({ path: '/messages', body: { text: 'Hi' }, label: 'Discussion', prompt: 'Hi' });
      return null;
    }
    render(
      <WorkspaceProvider sessionId="s1">
        <SessionHeader />
        <Starter />
      </WorkspaceProvider>,
    );
    await lockAcquired();
    await waitFor(() => expect(button('Ingest ticket').disabled).toBe(false));
    act(() => {
      void run();
    });
    await waitFor(() => expect(button('Ingest ticket').disabled).toBe(true));
    await act(async () => s.push(null));
    await waitFor(() => expect(button('Ingest ticket').disabled).toBe(false));
  });
});

describe('?analyze=1 (GI-27)', () => {
  beforeEach(() => {
    intakeState = 'ingested';
    window.history.replaceState(null, '', '/sessions/s1?analyze=1&tab=x');
  });

  it('starts exactly one analysis once the lock is held and removes the parameter', async () => {
    streamTurn.mockImplementation(() => {
      intakeState = 'analyzed';
      return events({ type: 'done', messageSeq: 2 });
    });
    renderHeader({ strict: true });
    await waitFor(() => expect(analyzeCalls()).toHaveLength(1));
    expect(window.location.search).toBe('?tab=x');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Analyze ticket' })).toBeNull());
    expect(analyzeCalls()).toHaveLength(1);
  });

  it('ignores 409 already_analyzed silently', async () => {
    const { ApiError } = await import('@/lib/api/client');
    streamTurn.mockImplementation(() => {
      intakeState = 'analyzed';
      throw new ApiError('Already analyzed', 409, 'already_analyzed', 'corr-1', null);
    });
    renderHeader();
    await waitFor(() => expect(analyzeCalls()).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Analyze ticket' })).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(window.location.search).toBe('?tab=x');
  });

  it('does nothing but remove the parameter when the session is not in the ingested state', async () => {
    intakeState = 'analyzed';
    renderHeader();
    await screen.findByText('ABC-1 Login');
    await waitFor(() => expect(window.location.search).toBe('?tab=x'));
    expect(streamTurn).not.toHaveBeenCalled();
  });

  it('does not touch the URL or start an analysis without the parameter', async () => {
    window.history.replaceState(null, '', '/sessions/s1?tab=x');
    renderHeader();
    await screen.findByRole('button', { name: 'Analyze ticket' });
    expect(streamTurn).not.toHaveBeenCalled();
  });
});
