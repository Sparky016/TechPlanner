import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PendingSuggestion, type Suggestion } from './PendingSuggestion';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/client', async (orig) => ({ ...(await orig<typeof import('@/lib/api/client')>()), apiFetch }));

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
});

const suggestion: Suggestion = {
  id: 'sg1',
  section: 'Scope',
  patch: { section: 'Scope', op: 'append', content: 'AI line' },
  createdAt: '2026-10-05T00:00:00.000Z',
};

function setup(readOnly = false) {
  const onDecided = vi.fn();
  render(<PendingSuggestion sessionId="s1" suggestion={suggestion} currentBody="User line" readOnly={readOnly} onDecided={onDecided} />);
  return { onDecided };
}

describe('PendingSuggestion', () => {
  it('shows the change as a diff against the current body', () => {
    setup();
    const diff = screen.getByLabelText('Suggested change').textContent ?? '';
    expect(diff).toContain('- User line');
    expect(diff).toContain('+ User line\n+ AI line');
  });

  it('Edit & accept sends editedContent', async () => {
    apiFetch.mockResolvedValue({ version: 5 });
    const { onDecided } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Edit & accept' }));
    const box = screen.getByLabelText('Edit suggested content') as HTMLTextAreaElement;
    expect(box.value).toBe('AI line');
    fireEvent.change(box, { target: { value: 'Edited AI line' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Accept edited' }));
    });
    expect(apiFetch).toHaveBeenCalledWith('/api/sessions/s1/suggestions/sg1/accept', {
      method: 'POST',
      json: { editedContent: 'Edited AI line' },
    });
    expect(onDecided).toHaveBeenCalledWith(true);
  });

  it('Accept sends no editedContent', async () => {
    apiFetch.mockResolvedValue({ version: 5 });
    setup();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    });
    expect(apiFetch).toHaveBeenCalledWith('/api/sessions/s1/suggestions/sg1/accept', { method: 'POST', json: {} });
  });

  it('Reject removes the suggestion', async () => {
    apiFetch.mockResolvedValue(undefined);
    const { onDecided } = setup();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    });
    expect(apiFetch).toHaveBeenCalledWith('/api/sessions/s1/suggestions/sg1/reject', { method: 'POST' });
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(screen.queryByLabelText('Suggested change')).toBeNull();
    expect(onDecided).toHaveBeenCalledWith(false);
  });

  it('disables every decision while read-only', () => {
    setup(true);
    for (const name of ['Accept', 'Edit & accept', 'Reject']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
