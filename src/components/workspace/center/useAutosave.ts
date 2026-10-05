'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// Section autosave (NFR-4): saves 1 s after the last change, and at most 5 s after the first unsaved change while
// typing continues. Saves are serialized (one in flight; the next one sends the latest value). Flushes on
// beforeunload and unmount; callers flush on blur.

export const AUTOSAVE_DEBOUNCE_MS = 1_000;
export const AUTOSAVE_MAX_WAIT_MS = 5_000;

export type AutosaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export type AutosaveFn = (value: string, opts?: { keepalive?: boolean }) => Promise<void>;

export interface Autosave {
  status: AutosaveStatus;
  error: unknown;
  /** Records a new value and (re)starts the debounce; starts the max-wait timer on the first unsaved change. */
  schedule: (value: string) => void;
  /** Saves any unsaved value now (after any in-flight save). */
  flush: () => Promise<void>;
  /** Drops any unsaved value and stops the timers. */
  cancel: () => void;
}

type Timer = ReturnType<typeof setTimeout>;

export function useAutosave(save: AutosaveFn, enabled = true): Autosave {
  const saveRef = useRef(save);
  const enabledRef = useRef(enabled);
  useEffect(() => {
    saveRef.current = save;
    enabledRef.current = enabled;
  });

  const pending = useRef<string | null>(null);
  const debounce = useRef<Timer | null>(null);
  const maxWait = useRef<Timer | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const [status, setStatus] = useState<AutosaveStatus>('idle');
  const [error, setError] = useState<unknown>(null);

  const clearTimers = useCallback(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (maxWait.current) clearTimeout(maxWait.current);
    debounce.current = null;
    maxWait.current = null;
  }, []);

  const run = useCallback(
    async (opts?: { keepalive?: boolean }): Promise<void> => {
      clearTimers();
      while (inFlight.current) await inFlight.current;
      const value = pending.current;
      if (value === null) return;
      pending.current = null;
      setStatus('saving');
      const p = saveRef
        .current(value, opts)
        .then(
          () => {
            setStatus('saved');
            setError(null);
          },
          (err: unknown) => {
            setStatus('error');
            setError(err);
          },
        )
        .finally(() => {
          inFlight.current = null;
        });
      inFlight.current = p;
      await p;
    },
    [clearTimers],
  );

  const schedule = useCallback(
    (value: string) => {
      if (!enabledRef.current) return;
      pending.current = value;
      if (debounce.current) clearTimeout(debounce.current);
      debounce.current = setTimeout(() => void run(), AUTOSAVE_DEBOUNCE_MS);
      if (!maxWait.current) maxWait.current = setTimeout(() => void run(), AUTOSAVE_MAX_WAIT_MS);
    },
    [run],
  );

  const flush = useCallback(() => run(), [run]);

  const cancel = useCallback(() => {
    clearTimers();
    pending.current = null;
  }, [clearTimers]);

  // Losing the lock or entering a conflict drops unsaved work from the queue (the server would reject it).
  useEffect(() => {
    if (!enabled) cancel();
  }, [enabled, cancel]);

  useEffect(() => {
    const onUnload = () => {
      if (pending.current !== null) void run({ keepalive: true });
    };
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      if (pending.current !== null) void run();
    };
  }, [run]);

  return { status, error, schedule, flush, cancel };
}
