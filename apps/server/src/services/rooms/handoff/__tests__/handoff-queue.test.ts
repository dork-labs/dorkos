import { afterEach, describe, expect, it, vi } from 'vitest';
import { HandoffQueue } from '../handoff-queue.js';

afterEach(() => vi.useRealTimers());
describe('bounded handoff queue', () => {
  it('counts an active turn and refuses capacity before constructing another item', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const create = vi.fn(() => 'draft');
    const run = vi.fn(() => gate);
    const queue = new HandoffQueue<string>({ run, expired() {}, failed() {} });
    try {
      for (let i = 0; i < 25; i++)
        expect(queue.admit('seat', Date.now() + 120000, create).accepted).toBe(true);
      await Promise.resolve();
      expect(run).toHaveBeenCalledTimes(1);
      expect(queue.admit('seat', Date.now() + 120000, create)).toEqual({
        accepted: false,
        why: 'capacity',
      });
      expect(create).toHaveBeenCalledTimes(25);
    } finally {
      release();
      await queue.idle();
    }
  });
  it('reserves the 25th preparing slot before a reentrant same-seat factory', async () => {
    const queue = new HandoffQueue<string>({ async run() {}, expired() {}, failed() {} });
    for (let i = 0; i < 24; i++) queue.admit('seat', Date.now() + 120000, () => 'draft');
    const nested = vi.fn(() => 'nested');
    expect(
      queue.admit('seat', Date.now() + 120000, () => {
        expect(queue.admit('seat', Date.now() + 120000, nested)).toEqual({
          accepted: false,
          why: 'capacity',
        });
        return '25th';
      }).accepted
    ).toBe(true);
    expect(nested).not.toHaveBeenCalled();
    await queue.idle();
  });
  it('reserves the 1000th preparing slot before a reentrant global factory', async () => {
    const queue = new HandoffQueue<string>({ async run() {}, expired() {}, failed() {} });
    for (let i = 0; i < 999; i++)
      queue.admit(`seat-${Math.floor(i / 25)}`, Date.now() + 120000, () => 'draft');
    const nested = vi.fn(() => 'nested');
    expect(
      queue.admit('last-seat', Date.now() + 120000, () => {
        expect(queue.admit('nested-seat', Date.now() + 120000, nested)).toEqual({
          accepted: false,
          why: 'capacity',
        });
        return '1000th';
      }).accepted
    ).toBe(true);
    expect(nested).not.toHaveBeenCalled();
    await queue.idle();
  });
  it('rolls a throwing preparing reservation back exactly once without keeping an empty seat', async () => {
    const queue = new HandoffQueue<string>({ async run() {}, expired() {}, failed() {} });
    expect(
      queue.admit('seat', Date.now() + 120000, () => {
        throw new Error('private');
      })
    ).toEqual({ accepted: false, why: 'invalid' });
    expect(queue.has('seat')).toBe(false);
    for (let i = 0; i < 25; i++)
      expect(queue.admit('seat', Date.now() + 120000, () => 'draft').accepted).toBe(true);
    expect(queue.admit('seat', Date.now() + 120000, () => 'overflow')).toEqual({
      accepted: false,
      why: 'capacity',
    });
    await queue.idle();
    expect(queue.has('seat')).toBe(false);
  });
  it('counts 1000 outstanding globally before calling a rejected factory', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(() => gate);
    const queue = new HandoffQueue<string>({ run, expired() {}, failed() {} });
    const rejectedFactory = vi.fn(() => 'rejected');
    try {
      for (let i = 0; i < 1000; i++)
        expect(
          queue.admit(`seat-${Math.floor(i / 25)}`, Date.now() + 120000, () => 'draft').accepted
        ).toBe(true);
      await Promise.resolve();
      expect(run).toHaveBeenCalledTimes(40);
      expect(queue.admit('another-seat', Date.now() + 120000, rejectedFactory)).toEqual({
        accepted: false,
        why: 'capacity',
      });
      expect(rejectedFactory).not.toHaveBeenCalled();
    } finally {
      release();
      await queue.idle();
    }
  });
  it('checks promotion time even before an expiry callback runs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const expired = vi.fn();
    const run = vi.fn(() => gate);
    const queue = new HandoffQueue<string>({ run, expired, failed() {} });
    queue.admit('seat', 120000, () => 'active');
    queue.admit('seat', 120000, () => 'waiting');
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(120000);
    release();
    await queue.idle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(expired).toHaveBeenCalledWith('waiting');
    expect(queue.has('seat')).toBe(false);
  });
  it('drains a sustained same-seat stream and settles idle after its final actual owner', async () => {
    const completed: number[] = [];
    let releaseLast!: () => void;
    const last = new Promise<void>((resolve) => {
      releaseLast = resolve;
    });
    const queue = new HandoffQueue<number>({
      async run(item) {
        if (item < 2000) {
          // Real public admission during execution, rather than a preloaded capacity overflow.
          expect(queue.admit('seat', Date.now() + 120000, () => item + 1).accepted).toBe(true);
        } else {
          await last;
        }
        completed.push(item);
      },
      expired() {
        throw new Error('Unexpected expiry');
      },
      failed() {
        throw new Error('Unexpected failure');
      },
    });
    queue.admit('seat', Date.now() + 120000, () => 0);
    let idleResolved = false;
    const idle = queue.idle().then(() => {
      idleResolved = true;
    });
    try {
      for (let i = 0; i < 10000 && completed.length < 2000; i++) await Promise.resolve();
      expect(completed).toEqual(Array.from({ length: 2000 }, (_, i) => i));
      expect(queue.has('seat')).toBe(true);
      expect(idleResolved).toBe(false);
    } finally {
      releaseLast();
      await idle;
    }
    expect(completed).toHaveLength(2001);
    expect(queue.has('seat')).toBe(false);
    // This is a sustained public scheduling/idle oracle, not a claim to measure heap retention.
  });
  it('clears owned queued timers once on stop and leaves the active owner until completion', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cancelled = vi.fn();
    const expired = vi.fn();
    const run = vi.fn(() => gate);
    const queue = new HandoffQueue<string>({ run, expired, failed() {}, cancelled });
    queue.admit('seat', Date.now() + 120000, () => 'active');
    queue.admit('seat', Date.now() + 120000, () => 'queued');
    await Promise.resolve();
    try {
      queue.stop();
      queue.stop();
      expect(cancelled).toHaveBeenCalledExactlyOnceWith('queued');
      const create = vi.fn(() => 'refused');
      expect(queue.admit('seat', Date.now() + 120000, create)).toEqual({
        accepted: false,
        why: 'stopped',
      });
      expect(create).not.toHaveBeenCalled();
      expect(queue.has('seat')).toBe(true);
      await vi.advanceTimersByTimeAsync(120000);
      expect(expired).not.toHaveBeenCalled();
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await queue.idle();
    }
    expect(queue.has('seat')).toBe(false);
  });
  it('expires a capacity-sized waiting burst without releasing its active owner', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const expired = vi.fn();
    const run = vi.fn(() => gate);
    const queue = new HandoffQueue<number>({ run, expired, failed() {} });
    try {
      for (let i = 0; i < 25; i++) queue.admit('seat', Date.now() + 120000, () => i);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(120000);
      expect(expired).toHaveBeenCalledTimes(24);
      expect(run).toHaveBeenCalledTimes(1);
      expect(queue.has('seat')).toBe(true);
    } finally {
      release();
      await queue.idle();
    }
  });
});
