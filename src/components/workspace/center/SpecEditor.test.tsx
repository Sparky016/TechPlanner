import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect } from 'react';
import { EditorView } from '@uiw/react-codemirror';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type WorkspaceEvent, WorkspaceProvider, useWorkspace } from '@/components/workspace/WorkspaceProvider';
import { SECTION_NAMES } from '@/lib/spec/sections';
import { SpecEditor } from './SpecEditor';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', async (orig) => ({ ...(await orig<typeof import('@/lib/api/client')>()), apiFetch }));

// jsdom has no layout: CodeMirror's measure pass needs Range rects.
if (typeof Range !== 'undefined' && !Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}

// Drive the real CodeMirror view: jsdom cannot type into its contenteditable, so dispatch a user change.
function cmView(el: HTMLElement): EditorView {
  const view = EditorView.findFromDOM(el);
  if (!view) throw new Error('not a CodeMirror editor');
  return view;
}
const valueOf = (el: HTMLElement) => cmView(el).state.doc.toString();
const isEditable = (el: HTMLElement) => el.getAttribute('contenteditable') === 'true';
function typeInto(el: HTMLElement, value: string) {
  act(() => {
    const view = cmView(el);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  });
}

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
  vi.useRealTimers();
});

function workingCopy(version: number, overrides: Record<string, string> = {}) {
  const sections: Record<string, { body: string; lastUserEditAt: null }> = {};
  for (const name of SECTION_NAMES) sections[name] = { body: overrides[name] ?? '', lastUserEditAt: null };
  return { version, sections, pendingSuggestions: [] };
}

interface MockState {
  holder: 'you' | 'other';
  wc: ReturnType<typeof workingCopy>;
}

function mockApi(state: MockState) {
  apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (path.endsWith('/lock')) return { holder: state.holder, expiresAt: null };
    if (path.endsWith('/working-copy')) return state.wc;
    if (path.endsWith('/readiness')) return { statuses: { 'Executive Summary': 'complete', Scope: 'partial', Risks: 'missing' } };
    if (path.endsWith('/revisions') && init?.method === 'POST') return { number: 7 };
    if (path.includes('/working-copy/sections/')) return { version: state.wc.version + 1 };
    return {};
  });
}

let publish: (e: WorkspaceEvent) => void = () => {};
function Bus() {
  const ws = useWorkspace();
  useEffect(() => {
    publish = ws.publish;
  });
  return null;
}

function renderEditor() {
  render(
    <WorkspaceProvider sessionId="s1">
      <Bus />
      <SpecEditor />
    </WorkspaceProvider>,
  );
}

describe('SpecEditor', () => {
  it('renders all 27 sections in order with text status labels', async () => {
    mockApi({ holder: 'you', wc: workingCopy(1) });
    renderEditor();
    await screen.findByLabelText('Scope content');
    await waitFor(() => expect(screen.getAllByText('Complete')).toHaveLength(1));
    const sections = Array.from(document.querySelectorAll('[data-section]')).map((el) => el.getAttribute('data-section'));
    expect(sections).toEqual([...SECTION_NAMES]);
    expect(sections).toHaveLength(27);
    expect(within(screen.getByRole('region', { name: 'Scope' })).getByText('Partial')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Risks' })).getByText('Missing')).toBeTruthy();
    expect(screen.getAllByText('Not evaluated')).toHaveLength(24);
  });

  it('highlights a section for 3 s and shows the new content on a patch event', async () => {
    const state: MockState = { holder: 'you', wc: workingCopy(1, { Scope: 'old scope' }) };
    mockApi(state);
    renderEditor();
    expect(valueOf(await screen.findByLabelText('Scope content'))).toBe('old scope');

    vi.useFakeTimers();
    state.wc = workingCopy(2, { Scope: 'AI scope' });
    await act(async () => {
      publish({ type: 'patch', section: 'Scope', version: 2 });
      await vi.advanceTimersByTimeAsync(0);
    });
    const region = screen.getByRole('region', { name: 'Scope' });
    expect(valueOf(screen.getByLabelText('Scope content'))).toBe('AI scope');
    expect(region.getAttribute('data-highlighted')).toBe('true');
    expect(within(region).getByText('Updated by AI')).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(region.getAttribute('data-highlighted')).toBe('false');
  });

  it('autosaves with the latest working copy version', async () => {
    mockApi({ holder: 'you', wc: workingCopy(4) });
    renderEditor();
    const box = await screen.findByLabelText('Scope content');
    await waitFor(() => expect(isEditable(box)).toBe(true));
    typeInto(box, 'typed');
    await act(async () => {
      fireEvent.focusOut(box);
    });
    expect(apiFetch).toHaveBeenCalledWith('/api/sessions/s1/working-copy/sections/scope', {
      method: 'PATCH',
      json: { body: 'typed', expectedVersion: 4 },
      keepalive: undefined,
    });
  });

  it('Save Draft posts a revision and shows its number', async () => {
    mockApi({ holder: 'you', wc: workingCopy(1) });
    renderEditor();
    const button = await screen.findByRole('button', { name: 'Save Draft' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(button);
    });
    expect(apiFetch).toHaveBeenCalledWith('/api/sessions/s1/revisions', { method: 'POST' });
    expect((await screen.findByText('Draft saved as revision 7')).getAttribute('role')).toBe('status');
  });

  it('disables editing and Save Draft while read-only', async () => {
    mockApi({ holder: 'other', wc: workingCopy(1) });
    renderEditor();
    const box = await screen.findByLabelText('Scope content');
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/sessions/s1/lock', { method: 'POST' }));
    await waitFor(() => expect(isEditable(box)).toBe(false));
    expect((screen.getByRole('button', { name: 'Save Draft' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
