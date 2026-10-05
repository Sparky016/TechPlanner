import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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

const editor = () => screen.getByLabelText('Scope content') as HTMLTextAreaElement;

describe('SectionEditor', () => {
  it('keeps the user text and shows the conflict choice on 409 version_conflict', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => {
      throw conflict();
    });
    setup({ save });
    fireEvent.change(editor(), { target: { value: 'my local edit' } });
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(save).toHaveBeenCalledWith('my local edit', undefined);
    expect(screen.getByRole('alert').textContent).toContain('Updated elsewhere');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Overwrite' })).toBeTruthy();
    expect(editor().value).toBe('my local edit');
    expect(screen.queryByText('Save failed')).toBeNull();

    // No further autosaves while the conflict is unresolved.
    fireEvent.change(editor(), { target: { value: 'my local edit 2' } });
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
    fireEvent.change(editor(), { target: { value: 'mine' } });
    await act(async () => {
      fireEvent.blur(editor());
    });
    expect(screen.getByRole('alert').textContent).toContain('Updated elsewhere');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Overwrite' }));
    });
    expect(props.onRefreshVersion).toHaveBeenCalled();
    expect(save).toHaveBeenLastCalledWith('mine');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(editor().value).toBe('mine');
  });

  it('Reload replaces the local text with the server body', async () => {
    const save = vi.fn(async () => {
      throw conflict();
    });
    const { props, rerender } = setup({ save });
    fireEvent.change(editor(), { target: { value: 'mine' } });
    await act(async () => {
      fireEvent.blur(editor());
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    });
    expect(props.onReload).toHaveBeenCalled();
    rerender(<SectionEditor {...props} body="theirs" resetKey={1} />);
    expect(editor().value).toBe('theirs');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the status as a text label and disables editing when read-only', () => {
    setup({ readOnly: true });
    expect(screen.getByText('Partial')).toBeTruthy();
    expect(editor().disabled).toBe(true);
  });

  it('toggles a plain-text preview', () => {
    setup({ body: '# Heading <b>x</b>' });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByLabelText('Scope preview').textContent).toBe('# Heading <b>x</b>');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(editor().value).toBe('# Heading <b>x</b>');
  });
});
