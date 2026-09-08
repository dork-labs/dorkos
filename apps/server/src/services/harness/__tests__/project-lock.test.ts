/**
 * `withProjectLock` — the primitive every projection trigger takes a turn under.
 *
 * Four things have to hold for it to be worth having, and each is a way it could
 * quietly stop working: two repositories must never wait on each other (or a
 * busy repo stalls every other project on the machine), one repository must
 * serialize (or it is decoration), a failing turn must release (or one thrown
 * error wedges a repo until the server restarts), and two spellings of the same
 * directory must share one lock (or a caller that says `/var/…` and a caller
 * that says `/private/var/…` each take their own and serialize nothing).
 *
 * The overlap is measured rather than assumed: each body records when it entered
 * and when it left, and the assertion is about whether those intervals cross.
 *
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../core/config-manager.js', () => ({
  configManager: { get: vi.fn(), set: vi.fn() },
}));

import { projectLockCount, withProjectLock } from '../project-with-consent.js';

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh temp directory that is cleaned up after the test. */
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** A run of one locked body: when it started and when it finished. */
interface Interval {
  /** The label the body was given. */
  label: string;
  /** Tick the body entered on. */
  enter: number;
  /** Tick the body left on. */
  exit: number;
}

/** Whether two runs were ever inside their bodies at the same time. */
function overlaps(a: Interval, b: Interval): boolean {
  return a.enter < b.exit && b.enter < a.exit;
}

/**
 * A locked body that yields to the event loop in the middle, so anything the
 * lock is not holding back has every chance to run inside it.
 */
function tracked(clock: { now: number }, log: Interval[], label: string): () => Promise<void> {
  return async () => {
    const enter = clock.now++;
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    log.push({ label, enter, exit: clock.now++ });
  };
}

describe('withProjectLock', () => {
  it('lets two different repositories run at the same time', async () => {
    const clock = { now: 0 };
    const log: Interval[] = [];
    const a = makeTempDir('lock-a-');
    const b = makeTempDir('lock-b-');

    await Promise.all([
      withProjectLock(a, tracked(clock, log, 'a')),
      withProjectLock(b, tracked(clock, log, 'b')),
    ]);

    const [first, second] = log;
    expect(log).toHaveLength(2);
    expect({ overlapped: overlaps(first!, second!) }).toEqual({ overlapped: true });
  });

  it('makes two turns on ONE repository take turns', async () => {
    const clock = { now: 0 };
    const log: Interval[] = [];
    const repo = makeTempDir('lock-same-');

    await Promise.all([
      withProjectLock(repo, tracked(clock, log, 'first')),
      withProjectLock(repo, tracked(clock, log, 'second')),
    ]);

    expect(log.map((i) => i.label)).toEqual(['first', 'second']);
    expect({ overlapped: overlaps(log[0]!, log[1]!) }).toEqual({ overlapped: false });
  });

  it('treats two spellings of one directory as one repository', async () => {
    const clock = { now: 0 };
    const log: Interval[] = [];
    // The shape macOS hands every test that uses `tmpdir()`: `/var/folders/…`
    // and `/private/var/folders/…` are one directory reached two ways.
    const real = makeTempDir('lock-real-');
    const linkHome = makeTempDir('lock-link-');
    const link = join(linkHome, 'repo');
    symlinkSync(real, link);
    expect(realpathSync(link)).toBe(realpathSync(real));

    await Promise.all([
      withProjectLock(real, tracked(clock, log, 'by-real-path')),
      withProjectLock(link, tracked(clock, log, 'through-the-link')),
    ]);

    expect(log.map((i) => i.label)).toEqual(['by-real-path', 'through-the-link']);
    expect({ overlapped: overlaps(log[0]!, log[1]!) }).toEqual({ overlapped: false });
  });

  it('releases the lock when a turn throws, and reports the throw to its own caller', async () => {
    const repo = makeTempDir('lock-throw-');
    const ran: string[] = [];

    const failing = withProjectLock(repo, () => {
      ran.push('failing');
      throw new Error('apply blew up');
    });
    const after = withProjectLock(repo, () => {
      ran.push('after');
      return 'landed';
    });

    await expect(failing).rejects.toThrow('apply blew up');
    // The next turn runs, and gets its own result rather than the failure.
    await expect(after).resolves.toBe('landed');
    expect(ran).toEqual(['failing', 'after']);
  });

  it('holds no lock for a repository nothing is projecting into', async () => {
    const repo = makeTempDir('lock-idle-');
    const before = projectLockCount();

    await withProjectLock(repo, () => undefined);
    // The entry is dropped in a microtask after the turn settles, so let the
    // queue drain before asking.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect({ locks: projectLockCount() }).toEqual({ locks: before });
  });

  it('resolves to whatever the body returned', async () => {
    const repo = makeTempDir('lock-value-');
    await expect(withProjectLock(repo, () => 41 + 1)).resolves.toBe(42);
    await expect(withProjectLock(repo, () => Promise.resolve('async'))).resolves.toBe('async');
  });
});
