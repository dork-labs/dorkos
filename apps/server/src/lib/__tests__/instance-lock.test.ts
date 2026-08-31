import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The lock is deliberately inert under NODE_ENV=test, so the tests that exercise
// it run with the env stand-in flipped to development.
const mockEnv = vi.hoisted(() => ({
  NODE_ENV: 'development' as 'development' | 'production' | 'test',
  DORKOS_SKIP_INSTANCE_LOCK: false,
}));
vi.mock('../../env.js', () => ({ env: mockEnv }));

import {
  acquireInstanceLock,
  isInstanceLockEnabled,
  releaseInstanceLock,
  INSTANCE_LOCK_FILENAME,
} from '../instance-lock.js';

/** A pid high enough that no process can hold it. */
const DEAD_PID = 2147483646;
/** The process that spawned this one: alive, and never our own pid. */
const LIVE_PID = process.ppid;

let dorkHome: string;
let lockPath: string;

/**
 * A lock claim that survives the recycled-pid corroboration: `startedAt` is now,
 * which is necessarily after the holding process actually started. This is the
 * shape a real running instance leaves behind.
 */
function liveClaim(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pid: LIVE_PID,
    port: 6242,
    startedAt: new Date().toISOString(),
    version: '0.9.0',
    ...overrides,
  };
}

function writeLockFile(contents: unknown): void {
  fs.writeFileSync(lockPath, typeof contents === 'string' ? contents : JSON.stringify(contents));
}

function readLockFile(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
}

describe('instance-lock', () => {
  beforeEach(() => {
    mockEnv.NODE_ENV = 'development';
    mockEnv.DORKOS_SKIP_INSTANCE_LOCK = false;
    dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-lock-'));
    lockPath = path.join(dorkHome, INSTANCE_LOCK_FILENAME);
  });

  afterEach(() => {
    fs.rmSync(dorkHome, { recursive: true, force: true });
  });

  describe('isInstanceLockEnabled', () => {
    it('is off under NODE_ENV=test', () => {
      mockEnv.NODE_ENV = 'test';
      expect(isInstanceLockEnabled()).toBe(false);
    });

    it('is off behind the DORKOS_SKIP_INSTANCE_LOCK escape hatch', () => {
      mockEnv.DORKOS_SKIP_INSTANCE_LOCK = true;
      expect(isInstanceLockEnabled()).toBe(false);
    });

    it('is on otherwise', () => {
      expect(isInstanceLockEnabled()).toBe(true);
    });
  });

  describe('when disabled', () => {
    it('acquires without writing a lock file under NODE_ENV=test', () => {
      mockEnv.NODE_ENV = 'test';
      const result = acquireInstanceLock({ dorkHome, port: 4242, version: '1.2.3' });
      expect(result.acquired).toBe(true);
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('acquires even when a live instance holds the directory', () => {
      mockEnv.DORKOS_SKIP_INSTANCE_LOCK = true;
      writeLockFile(liveClaim({ port: 4242 }));
      const result = acquireInstanceLock({ dorkHome, port: 4242, version: '1.2.3' });
      expect(result.acquired).toBe(true);
    });
  });

  describe('acquiring a free directory', () => {
    it('records pid, port, startedAt, and version', () => {
      const result = acquireInstanceLock({ dorkHome, port: 4242, version: '1.2.3' });

      expect(result.acquired).toBe(true);
      const written = readLockFile();
      expect(written.pid).toBe(process.pid);
      expect(written.port).toBe(4242);
      expect(written.version).toBe('1.2.3');
      expect(typeof written.startedAt).toBe('string');
      expect(new Date(written.startedAt as string).toISOString()).toBe(written.startedAt);
    });

    it('creates the data directory when it does not exist yet', () => {
      const fresh = path.join(dorkHome, 'nested', '.dork');
      const result = acquireInstanceLock({ dorkHome: fresh, port: 4242, version: '1.2.3' });
      expect(result.acquired).toBe(true);
      expect(fs.existsSync(path.join(fresh, INSTANCE_LOCK_FILENAME))).toBe(true);
    });
  });

  describe('when another instance holds the directory', () => {
    it('refuses, naming that instance and the data directory', () => {
      writeLockFile(liveClaim());

      const result = acquireInstanceLock({ dorkHome, port: 4242, version: '1.2.3' });

      expect(result.acquired).toBe(false);
      if (result.acquired) throw new Error('unreachable');
      expect(result.holder?.pid).toBe(LIVE_PID);
      expect(result.holder?.port).toBe(6242);
      expect(result.reason).toContain(String(LIVE_PID));
      expect(result.reason).toContain('6242');
      expect(result.reason).toContain(dorkHome);
      expect(result.reason).toContain('DORKOS_SKIP_INSTANCE_LOCK');
    });

    it('leaves the existing lock file untouched', () => {
      writeLockFile(liveClaim());
      acquireInstanceLock({ dorkHome, port: 4242, version: '1.2.3' });
      expect(readLockFile().pid).toBe(LIVE_PID);
    });
  });

  describe('stale locks', () => {
    it('takes over a lock naming a process that is gone', () => {
      writeLockFile({ pid: DEAD_PID, port: 6242, startedAt: '2026-01-01T00:00:00Z', version: '1' });

      const result = acquireInstanceLock({ dorkHome, port: 4242, version: '1.2.3' });

      expect(result.acquired).toBe(true);
      expect(readLockFile().pid).toBe(process.pid);
    });

    it('takes over an unreadable lock file rather than refusing to boot', () => {
      writeLockFile('{ not json');
      const result = acquireInstanceLock({ dorkHome, port: 4242, version: '1.2.3' });
      expect(result.acquired).toBe(true);
      expect(readLockFile().pid).toBe(process.pid);
    });

    it('takes over a lock naming this very process', () => {
      writeLockFile({
        pid: process.pid,
        port: 1,
        startedAt: '2026-01-01T00:00:00Z',
        version: '1',
      });
      const result = acquireInstanceLock({ dorkHome, port: 4242, version: '1.2.3' });
      expect(result.acquired).toBe(true);
      expect(readLockFile().port).toBe(4242);
    });

    // The test above doesn't actually pin the self-pid guard: its fabricated
    // `startedAt` (2026-01-01) is old enough that recycled-pid corroboration
    // alone would already call it 'gone', so the assertion passes even with
    // the explicit `holder.pid === process.pid` check deleted. This one
    // closes that gap: `startedAt` is "right now", which is exactly what
    // corroboration would call `'live-confirmed'` for THIS process (it really
    // is alive, and its own real start time is at or before now) — so only
    // the self-pid check, not corroboration, can be why this succeeds.
    it('takes over a lock naming this process even when its startedAt would otherwise corroborate as live', () => {
      writeLockFile({
        pid: process.pid,
        port: 1,
        startedAt: new Date().toISOString(),
        version: '1',
      });

      const result = acquireInstanceLock({ dorkHome, port: 4242, version: '1.2.3' });

      expect(result.acquired).toBe(true);
      expect(readLockFile().port).toBe(4242);
    });

    // Corroboration needs a parseable `startedAt` to compare against — an
    // unparseable one used to fall through to 'live-unconfirmed' regardless
    // of whether the pid was even alive, which refuses to boot over a dead
    // process's garbled lock file. A dead pid is dead independent of what its
    // `startedAt` says, and must still read as 'gone'.
    it('takes over a lock with an unparseable startedAt when the pid is dead (gone, not merely unconfirmed)', () => {
      writeLockFile({ pid: DEAD_PID, port: 6242, startedAt: 'not-a-real-date', version: '1' });

      const result = acquireInstanceLock({ dorkHome, port: 4242, version: '1.2.3' });

      expect(result.acquired).toBe(true);
      expect(readLockFile().pid).toBe(process.pid);
    });

    // The mirror case: an unparseable startedAt with a genuinely LIVE pid
    // (never THIS process — see the self-pid case above) must still refuse,
    // since there is nothing to corroborate a rival's claim against.
    it('refuses a lock with an unparseable startedAt naming a pid that is alive', () => {
      writeLockFile({ pid: LIVE_PID, port: 6242, startedAt: 'not-a-real-date', version: '1' });

      const result = acquireInstanceLock({ dorkHome, port: 4242, version: '1.2.3' });

      expect(result.acquired).toBe(false);
    });

    // A SIGKILL leaves the file behind; later the OS wraps pids onto some
    // unrelated process. Pid existence alone would then refuse every start
    // forever and tell the operator to kill an innocent process. The holder must
    // have started BEFORE it wrote the lock, and a recycled pid never has.
    it('takes over a lock whose pid was recycled onto a newer process', () => {
      writeLockFile(liveClaim({ startedAt: '2020-01-01T00:00:00Z' }));

      const result = acquireInstanceLock({ dorkHome, port: 4242, version: '1.2.3' });

      expect(result.acquired).toBe(true);
      expect(readLockFile().pid).toBe(process.pid);
    });
  });

  describe('unreadable contention', () => {
    // The fallback used to invent `{ pid: 0 }` and print `kill 0`, which in a
    // shell signals the caller's whole process group — the shell itself.
    it('never advises `kill 0` when it cannot read the lock file', () => {
      // A directory at the lock path: it always exists (so `wx` keeps failing)
      // and never parses as a claim, which is exactly the contended-and-
      // unreadable state.
      fs.mkdirSync(lockPath);

      const result = acquireInstanceLock({ dorkHome, port: 4242, version: '1.2.3' });

      expect(result.acquired).toBe(false);
      if (result.acquired) throw new Error('unreachable');
      expect(result.reason).not.toContain('kill 0');
      expect(result.reason).not.toMatch(/\bkill\b/);
      expect(result.holder).toBeUndefined();
      expect(result.reason).toContain(lockPath);
      expect(result.reason).toContain('DORKOS_SKIP_INSTANCE_LOCK');

      fs.rmdirSync(lockPath);
    });

    // Found by the test above: a lock path that will not unlink used to escape
    // as a raw EISDIR SystemError, aborting the boot with a stack trace instead
    // of the message that tells the operator what to do.
    it('reports contention instead of throwing when the lock path cannot be removed', () => {
      fs.mkdirSync(lockPath);
      expect(() => acquireInstanceLock({ dorkHome, port: 4242, version: '1.2.3' })).not.toThrow();
      fs.rmdirSync(lockPath);
    });
  });

  describe('release', () => {
    it('removes this process claim', () => {
      const result = acquireInstanceLock({ dorkHome, port: 4242, version: '1.2.3' });
      if (!result.acquired) throw new Error('expected to acquire');

      result.release();

      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('is safe to call twice', () => {
      const result = acquireInstanceLock({ dorkHome, port: 4242, version: '1.2.3' });
      if (!result.acquired) throw new Error('expected to acquire');
      result.release();
      expect(() => result.release()).not.toThrow();
    });

    it('leaves another live instance claim alone', () => {
      writeLockFile(liveClaim());
      releaseInstanceLock(dorkHome);
      expect(fs.existsSync(lockPath)).toBe(true);
    });

    // Liveness is deliberately not consulted here: a file naming any other pid
    // is left alone. Leaving a dead process's file behind costs nothing (the
    // next start clears it), while deleting a file we do not own could free the
    // directory out from under a running instance.
    it('leaves a claim naming a dead other process alone too', () => {
      writeLockFile(liveClaim({ pid: DEAD_PID }));
      releaseInstanceLock(dorkHome);
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(readLockFile().pid).toBe(DEAD_PID);
    });

    it('does not throw when there is no lock file', () => {
      expect(() => releaseInstanceLock(dorkHome)).not.toThrow();
    });
  });

  describe('scoping', () => {
    it('is per data directory, so dev and production never collide', () => {
      const other = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-lock-other-'));
      try {
        const first = acquireInstanceLock({ dorkHome, port: 6242, version: '1.2.3' });
        const second = acquireInstanceLock({ dorkHome: other, port: 4242, version: '1.2.3' });
        expect(first.acquired).toBe(true);
        expect(second.acquired).toBe(true);
      } finally {
        fs.rmSync(other, { recursive: true, force: true });
      }
    });
  });
});
