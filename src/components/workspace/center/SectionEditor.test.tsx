import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditorView } from '@uiw/react-codemirror';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/client';
import { SectionEditor, type SectionEditorProps } from './SectionEditor';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const conflict = () => new ApiError('The working copy has changed; reload and retry', 409, 'version_conflict', 'corr-1', null);

function setup(overrides: Partial<SectionEditorProps> = {}) {
  const props: SectionEditorProps = {
    sessionId: 's1',
    name: 'Scope',
    body: 'server text',
    resetKey: 0,
    status: 'partial',
    highlighted: false,
    readOnly: false,
    suggestions: [],
    save: vi.fn(async () => {}),
    onReload: vi.fn(async () => {}),
    onRefreshVersion: vi.fn(async () => {}),
    onSuggestionDecided: vi.fn(),
    ...overrides,
  };
  const utils = render(<SectionEditor {...props} />);
  return { props, ...utils };
}

const editor = () => screen.getByLabelText('Scope content');

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

describe('SectionEditor', () => {
  it('keeps the user text and shows the conflict choice on 409 version_conflict', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => {
      throw conflict();
    });
    setup({ save });
    typeInto(editor(), 'my local edit');
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(save).toHaveBeenCalledWith('my local edit', undefined);
    expect(screen.getByRole('alert').textContent).toContain('Updated elsewhere');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Overwrite' })).toBeTruthy();
    expect(valueOf(editor())).toBe('my local edit');
    expect(screen.queryByText('Save failed')).toBeNull();

    // No further autosaves while the conflict is unresolved.
    typeInto(editor(), 'my local edit 2');
    await act(() => vi.advanceTimersByTimeAsync(6_000));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('Overwrite refreshes the version and saves the local text', async () => {
    let fail = true;
    const save = vi.fn(async () => {
      if (fail) {
        fail = false;
        throw conflict();
      }
    });
    const { props } = setup({ save });
    typeInto(editor(), 'mine');
    await act(async () => {
      fireEvent.focusOut(editor());
    });
    expect(screen.getByRole('alert').textContent).toContain('Updated elsewhere');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Overwrite' }));
    });
    expect(props.onRefreshVersion).toHaveBeenCalled();
    expect(save).toHaveBeenLastCalledWith('mine');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(valueOf(editor())).toBe('mine');
  });

  it('Reload replaces the local text with the server body', async () => {
    const save = vi.fn(async () => {
      throw conflict();
    });
    const { props, rerender } = setup({ save });
    typeInto(editor(), 'mine');
    await act(async () => {
      fireEvent.focusOut(editor());
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    });
    expect(props.onReload).toHaveBeenCalled();
    rerender(<SectionEditor {...props} body="theirs" resetKey={1} />);
    // @uiw/react-codemirror defers external value updates until ~200 ticks of a 1 ms interval after the last keystroke.
    await waitFor(() => expect(valueOf(editor())).toBe('theirs'), { timeout: 5_000 });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the status as a text label and disables editing when read-only', () => {
    setup({ readOnly: true });
    expect(screen.getByText('Partial')).toBeTruthy();
    expect(isEditable(editor())).toBe(false);
    expect(editor().getAttribute('aria-readonly')).toBe('true');
  });

  it('renders an editable CodeMirror markdown editor', () => {
    setup();
    expect(editor().closest('.cm-editor')).toBeTruthy();
    expect(isEditable(editor())).toBe(true);
    expect(valueOf(editor())).toBe('server text');
  });

  it('toggles a rendered markdown preview without rendering raw HTML', () => {
    const BODY = ['# Heading <b>x</b>', '', '<script>alert(1)</script>'].join('\n');
    setup({ body: BODY });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const preview = screen.getByLabelText('Scope preview');
    expect(preview.querySelector('h1')?.textContent).toContain('Heading');
    expect(preview.querySelector('b')).toBeNull();
    expect(preview.querySelector('script')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(valueOf(editor())).toBe(BODY);
  });
});
