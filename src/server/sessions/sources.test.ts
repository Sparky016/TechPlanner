import { describe, expect, it, vi } from 'vitest';
import { mapWithConcurrency } from './sources';

vi.mock('@/server/db/pool', () => ({ query: vi.fn() }));
vi.mock('@/server/audit/audit', () => ({ recordAudit: vi.fn() }));

describe('mapWithConcurrency', () => {
  it('keeps input order and never exceeds the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithConcurrency([5, 1, 4, 2, 3], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, n));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);
  });

  it('starts no new calls after a rejection and settles only once in-flight calls have', async () => {
    const started: number[] = [];
    let slowDone = false;
    const run = mapWithConcurrency([1, 2, 3, 4], 2, async (n) => {
      started.push(n);
      if (n === 1) throw new Error('boom');
      await new Promise((resolve) => setTimeout(resolve, 20));
      slowDone = true;
      return n;
    });
    await expect(run).rejects.toThrow('boom');
    expect(slowDone).toBe(true);
    expect(started).toEqual([1, 2]);
  });
});
