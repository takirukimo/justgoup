import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackendError, withTimeout } from './errors';

afterEach(() => {
  vi.useRealTimers();
});

describe('withTimeout', () => {
  it('rejects with a timeout BackendError when the answer never comes', async () => {
    vi.useFakeTimers();
    const p = withTimeout(new Promise<never>(() => {}), 1000, 'probe');
    const caught = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1001);
    const err = await caught;
    expect(err).toBeInstanceOf(BackendError);
    expect((err as BackendError).code).toBe('timeout');
  });

  it('does not count a main-thread stall against the other side', async () => {
    vi.useFakeTimers();
    let answer!: (v: string) => void;
    const p = withTimeout(new Promise<string>((r) => (answer = r)), 1000, 'probe');
    // the page blocks for 5 s (boot on a slow phone): the clock moves, the timer fires overdue
    vi.setSystemTime(Date.now() + 5000);
    await vi.advanceTimersByTimeAsync(1000);
    // the reply that was queued behind the stall is processed during the grace period
    answer('db');
    await expect(p).resolves.toBe('db');
  });

  it('still times out after a stall when nothing was waiting', async () => {
    vi.useFakeTimers();
    const p = withTimeout(new Promise<never>(() => {}), 1000, 'probe');
    const caught = p.catch((e: unknown) => e);
    vi.setSystemTime(Date.now() + 5000);
    await vi.advanceTimersByTimeAsync(1000 + 400 + 50);
    expect(await caught).toBeInstanceOf(BackendError);
  });
});
