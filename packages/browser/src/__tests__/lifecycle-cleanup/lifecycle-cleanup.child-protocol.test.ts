import type {} from '../../configuration.js';
import { it, expect, describe, afterEach, vi } from 'vitest';
import { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { until } from '../../lifecycle/deadline.js';
import {
  TRUSTED_CHILD_SOURCE,
  TRUSTED_CHILD_ENV,
  ownTrustedChild,
} from './lifecycle-cleanup.fixtures.js';

// These controls use only EventEmitter fixtures; they never spawn, query or signal a process.
describe('trusted child closure protocol without native subjects', () => {
  afterEach(() => vi.useRealTimers());
  function fixture() {
    const child = new EventEmitter();
    const stdin = new EventEmitter();
    const end = vi.fn();
    Object.assign(stdin, { end });
    Object.assign(child, { stdin });
    let now = 0;
    const owner = ownTrustedChild(child as unknown as ChildProcess, 100, () => now);
    return {
      child,
      stdin,
      end,
      owner,
      setNow: (value: number) => {
        now = value;
      },
    };
  }
  it('memoizes EOF and requires exact original exit, child close and stdin close', async () => {
    const f = fixture();
    const first = f.owner.stop();
    expect(f.owner.stop()).toBe(first);
    expect(f.end).toHaveBeenCalledTimes(1);
    f.child.emit('exit', 0, null);
    f.child.emit('close', 0, null);
    f.stdin.emit('close');
    await first;
    expect(f.owner.isClosed()).toBe(true);
  });
  it.each(['exit', 'close', 'stdin'])(
    'missing %s remains unknown at original deadline',
    async (missing) => {
      vi.useFakeTimers();
      const f = fixture();
      const pending = expect(f.owner.stop()).rejects.toThrow('OWNED_CHILD_CLOSURE_UNVERIFIED');
      if (missing !== 'exit') f.child.emit('exit', 0, null);
      if (missing !== 'close') f.child.emit('close', 0, null);
      if (missing !== 'stdin') f.stdin.emit('close');
      f.setNow(100);
      await vi.advanceTimersByTimeAsync(100);
      await pending;
      expect(f.owner.isClosed()).toBe(false);
    }
  );
  it('closed environment supplies no NODE_OPTIONS, preload or shell intake', () => {
    expect(Object.keys(TRUSTED_CHILD_ENV)).toEqual([]);
    expect(TRUSTED_CHILD_SOURCE).not.toMatch(/require|import|fork|spawn|Worker/);
    expect(TRUSTED_CHILD_SOURCE).toContain("process.stdin.on('end',()=>process.exit(0))");
  });
});

// The original exists before a caller discovers that its absolute wait has expired.
it('observes an original late rejection when its absolute wait already expired', async () => {
  const primary = Error('ORIGINAL_OBSERVATION_FAILED');
  let fail!: (error: unknown) => void;
  const original = new Promise<never>((_resolve, reject) => {
    fail = reject;
  });
  await expect(
    until(original, performance.now() - 1, 'PROCESS_OBSERVATION_UNAVAILABLE')
  ).rejects.toMatchObject({ code: 'PROCESS_OBSERVATION_UNAVAILABLE' });
  fail(primary);
  // Give actual Node rejection reporting a complete turn before examining the original.
  await new Promise<void>((resolve) => setImmediate(resolve));
  await expect(original).rejects.toBe(primary);
});
