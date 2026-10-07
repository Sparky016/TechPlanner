import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAutosave } from './useAutosave';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useAutosave', () => {
  it('saves at least every 5 s during 12 s of continuous typing and 1 s after typing stops', async () => {
    vi.useFakeTimers();
    const saveTimes: number[] = [];
    const save = vi.fn(async () => {
      saveTimes.push(Date.now());
    });
    const { result } = renderHook(() => useAutosave(save));
    const start = Date.now();

    let text = '';
    for (let t = 0; t < 12_000; t += 250) {
      text += 'a';
      act(() => result.current.schedule(text));
      await act(() => vi.advanceTimersByTimeAsync(250));
    }
    const duringTyping = save.mock.calls.length;
    expect(duringTyping).toBeGreaterThanOrEqual(2);
    const points = [start, ...saveTimes];
    for (let i = 1; i < points.length; i++) expect(points[i] - points[i - 1]).toBeLessThanOrEqual(5_000);

    // Stopped typing (last keystroke at ~11.75 s, now 12 s): one more save 1 s after the last keystroke.
    await act(() => vi.advanceTimersByTimeAsync(750));
    expect(save).toHaveBeenCalledTimes(duringTyping + 1);
    expect(save).toHaveBeenLastCalledWith(text, undefined);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(save).toHaveBeenCalledTimes(duringTyping + 1);
  });

  it('debounces a burst into one save of the latest value', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => {});
    const { result } = renderHook(() => useAutosave(save));
    act(() => {
      result.current.schedule('a');
      result.current.schedule('ab');
    });
    await act(() => vi.advanceTimersByTimeAsync(999));
    expect(save).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('ab', undefined);
    expect(result.current.status).toBe('saved');
  });

  it('serializes saves: a flush during an in-flight save waits and then sends the latest value', async () => {
    let resolveFirst!: () => void;
    const save = vi
      .fn<(v: string) => Promise<void>>()
      .mockImplementationOnce(() => new Promise<void>((r) => (resolveFirst = r)))
      .mockResolvedValue(undefined);
    const { result } = renderHook(() => useAutosave(save));
    act(() => result.current.schedule('one'));
    let first!: Promise<void>;
    act(() => {
      first = result.current.flush();
    });
    act(() => result.current.schedule('two'));
    let second!: Promise<void>;
    act(() => {
      second = result.current.flush();
    });
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveFirst();
      await first;
      await second;
    });
    expect(save.mock.calls.map((c) => c[0])).toEqual(['one', 'two']);
  });

  it('flushes on beforeunload with keepalive', async () => {
    const save = vi.fn(async () => {});
    const { result } = renderHook(() => useAutosave(save));
    act(() => result.current.schedule('unsaved'));
    await act(async () => {
      window.dispatchEvent(new Event('beforeunload'));
    });
    expect(save).toHaveBeenCalledWith('unsaved', { keepalive: true });
  });

  it('does nothing while disabled and reports save errors', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => {
      throw new Error('boom');
    });
    const { result, rerender } = renderHook(({ enabled }) => useAutosave(save, enabled), { initialProps: { enabled: false } });
    act(() => result.current.schedule('x'));
    await act(() => vi.advanceTimersByTimeAsync(6_000));
    expect(save).not.toHaveBeenCalled();
    rerender({ enabled: true });
    act(() => result.current.schedule('y'));
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(save).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('error');
  });
});
