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
      writeLockFile({ pid: LIVE_PID, port: 4242, startedAt: '2026-01-01T00:00:00Z', version: '1' });
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
      writeLockFile({
        pid: LIVE_PID,
        port: 6242,
        startedAt: '2026-01-01T00:00:00Z',
        version: '0.9.0',
      });

      const result = acquireInstanceLock({ dorkHome, port: 4242, version: '1.2.3' });

      expect(result.acquired).toBe(false);
      if (result.acquired) throw new Error('unreachable');
      expect(result.holder.pid).toBe(LIVE_PID);
      expect(result.holder.port).toBe(6242);
      expect(result.reason).toContain(String(LIVE_PID));
      expect(result.reason).toContain('6242');
      expect(result.reason).toContain(dorkHome);
      expect(result.reason).toContain('DORKOS_SKIP_INSTANCE_LOCK');
    });

    it('leaves the existing lock file untouched', () => {
      writeLockFile({ pid: LIVE_PID, port: 6242, startedAt: '2026-01-01T00:00:00Z', version: '1' });
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
      writeLockFile({ pid: LIVE_PID, port: 6242, startedAt: '2026-01-01T00:00:00Z', version: '1' });
      releaseInstanceLock(dorkHome);
      expect(fs.existsSync(lockPath)).toBe(true);
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
