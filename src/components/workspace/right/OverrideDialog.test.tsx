import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverrideDialog } from '@/components/workspace/right/OverrideDialog';

afterEach(() => cleanup());

const ISSUES = [{ id: 'i1', section: 'Security', description: 'No auth model <b>defined</b>' }];

function renderDialog(onConfirm = vi.fn(), onClose = vi.fn()) {
  render(<OverrideDialog issues={ISSUES} busy={false} error={null} onConfirm={onConfirm} onClose={onClose} />);
  return { onConfirm, onClose };
}

const confirmButton = () => screen.getByRole('button', { name: 'Publish with override' }) as HTMLButtonElement;

describe('OverrideDialog', () => {
  it('lists the open critical issues as plain text', () => {
    renderDialog();
    expect(screen.getByRole('dialog').textContent).toContain('No auth model <b>defined</b>');
  });

  it('keeps confirm disabled until a 20+ char justification and the checkbox, then sends both fields', () => {
    const { onConfirm } = renderDialog();
    const text = screen.getByLabelText(/Justification/);
    const box = screen.getByRole('checkbox');
    expect(confirmButton().disabled).toBe(true);

    fireEvent.change(text, { target: { value: '   short reason       ' } });
    fireEvent.click(box);
    expect(confirmButton().disabled).toBe(true); // trimmed length < 20

    fireEvent.change(text, { target: { value: 'Accepted by the architecture board' } });
    fireEvent.click(box); // unchecked again
    expect(confirmButton().disabled).toBe(true);

    fireEvent.click(box);
    expect(confirmButton().disabled).toBe(false);
    fireEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith({
      overrideJustification: 'Accepted by the architecture board',
      confirmOverride: true,
    });
  });

  it('focuses the justification on open and closes on Escape', () => {
    const { onClose } = renderDialog();
    expect(document.activeElement).toBe(screen.getByLabelText(/Justification/));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('traps Tab focus inside the dialog', () => {
    renderDialog();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const text = screen.getByLabelText(/Justification/);
    // Confirm is disabled, so Cancel is the last focusable element.
    cancel.focus();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });
    expect(document.activeElement).toBe(text);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(cancel);
  });
});
