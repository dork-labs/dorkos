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

import {
  projectLockCount,
  projectLockQueueDepth,
  withProjectLock,
} from '../project-with-consent.js';

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
  it('AP-10: lets two different repositories run at the same time', async () => {
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

  it('AP-10: makes two turns on ONE repository take turns', async () => {
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
    // `'junction'` on Windows: a DIRECTORY symlink with no type asks for a file
    // link and fails with EPERM without Developer Mode. POSIX ignores the
    // argument (DOR-1855's Windows workflow).
    symlinkSync(real, link, process.platform === 'win32' ? 'junction' : undefined);
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

  it('counts every caller waiting on one repository, not just the repository', async () => {
    const repo = makeTempDir('lock-depth-');
    const before = projectLockCount();
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    // One turn held open, five more asked for behind it. Map SIZE says `1`
    // either way — it counts repositories — so the number that means anything
    // is the queue.
    const running = [withProjectLock(repo, () => held)];
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let i = 0; i < 5; i++) running.push(withProjectLock(repo, () => undefined));

    expect({ depth: projectLockQueueDepth(repo), locks: projectLockCount() }).toEqual({
      depth: 6,
      locks: before + 1,
    });

    release();
    await Promise.all(running);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // …and nothing is left behind once they have all had their turn.
    expect({ depth: projectLockQueueDepth(repo), locks: projectLockCount() }).toEqual({
      depth: 0,
      locks: before,
    });
  });

  it('refuses a re-entrant turn instead of waiting for itself for ever', async () => {
    const repo = makeTempDir('lock-reentrant-');
    let inner = 'never ran';

    // Measured before this guard existed: the outer promise never settled, and
    // the map entry stayed at 1 for the life of the process.
    await expect(
      withProjectLock(repo, async () => {
        await withProjectLock(repo, () => {
          inner = 'ran';
        });
      })
    ).rejects.toThrow(/re-entrant lock on .*lock-reentrant/);

    expect(inner).toBe('never ran');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect({ depth: projectLockQueueDepth(repo), locks: projectLockCount() }).toEqual({
      depth: 0,
      locks: 0,
    });
  });

  it('still lets an unrelated caller queue while a turn is running', async () => {
    // The half a module-level `Set` of in-flight keys would get wrong: while a
    // turn runs, its key is "in flight" for everybody, so a set-based check
    // would refuse the second install into one repo — the caller this lock is
    // FOR. Only the async context can tell the two apart.
    const repo = makeTempDir('lock-not-reentrant-');
    const order: string[] = [];
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = withProjectLock(repo, async () => {
      order.push('first');
      await held;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = withProjectLock(repo, () => {
      order.push('second');
    });

    release();
    await expect(Promise.all([first, second])).resolves.toBeDefined();
    expect(order).toEqual(['first', 'second']);
  });

  it('nests happily on a DIFFERENT repository', async () => {
    const outer = makeTempDir('lock-outer-');
    const inner = makeTempDir('lock-inner-');

    await expect(
      withProjectLock(outer, async () => withProjectLock(inner, () => 'both'))
    ).resolves.toBe('both');
  });

  it('resolves to whatever the body returned', async () => {
    const repo = makeTempDir('lock-value-');
    await expect(withProjectLock(repo, () => 41 + 1)).resolves.toBe(42);
    await expect(withProjectLock(repo, () => Promise.resolve('async'))).resolves.toBe('async');
  });
});
