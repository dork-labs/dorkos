/**
 * Interrupt-safe teardown. These tests do NOT raise a real signal — that would
 * end the vitest worker — so they assert the registry contract instead: handlers
 * appear only while something is registered, and the registered disposer is the
 * one the handler would call.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { onInterrupt, liveDisposerCount } from '../interrupt.js';

/** Registered releases, so a failing test cannot leak a handler into the next. */
const releases: (() => void)[] = [];

afterEach(() => {
  while (releases.length > 0) releases.pop()?.();
});

/** Register a no-op disposer and remember its release. */
function register(dispose: () => Promise<void> = async () => {}): () => void {
  const release = onInterrupt(dispose);
  releases.push(release);
  return release;
}

describe('onInterrupt', () => {
  it('installs SIGINT/SIGTERM handlers only while a disposer is registered', () => {
    const before = {
      int: process.listenerCount('SIGINT'),
      term: process.listenerCount('SIGTERM'),
    };

    const release = register();
    expect(process.listenerCount('SIGINT')).toBe(before.int + 1);
    expect(process.listenerCount('SIGTERM')).toBe(before.term + 1);

    release();
    // Importing the harness must not permanently change a host process's signal
    // behavior, so the handlers come back off with the last disposer.
    expect(process.listenerCount('SIGINT')).toBe(before.int);
    expect(process.listenerCount('SIGTERM')).toBe(before.term);
  });

  it('installs the handlers ONCE across concurrent evals', () => {
    const before = process.listenerCount('SIGINT');
    const first = register();
    const second = register();
    expect(process.listenerCount('SIGINT')).toBe(before + 1);
    expect(liveDisposerCount()).toBe(2);

    // Releasing one must NOT disarm teardown for the other.
    first();
    expect(process.listenerCount('SIGINT')).toBe(before + 1);
    second();
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('release is idempotent and does not double-count', () => {
    const release = register();
    release();
    release();
    expect(liveDisposerCount()).toBe(0);
  });
});
