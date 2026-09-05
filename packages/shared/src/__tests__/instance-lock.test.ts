import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  INSTANCE_LOCK_FILENAME,
  assessInstanceLockHolder,
  instanceLockPath,
  liveInstanceLockHolder,
  readInstanceLock,
} from '../instance-lock.js';

/**
 * Reading the claim on a data directory.
 *
 * The server's own `acquireInstanceLock` covers claiming and releasing
 * (`apps/server/src/lib/__tests__/instance-lock.test.ts`). What is pinned here
 * is the half the DESKTOP shell depends on: before "Reset All Data" deletes the
 * directory, it has to be able to tell "nobody has this" from "somebody has
 * this", and both wrong answers are expensive — a false "free" deletes a store
 * another server has open, and a false "held" makes the app's only reset story
 * permanently unavailable after any crash.
 */

/** A pid high enough that no process can hold it. */
const DEAD_PID = 2147483646;

/** The process that spawned this one: alive, and never our own pid. */
const LIVE_PID = process.ppid;

let dorkHome: string;

/** Write a claim naming `pid`, taken `agoMs` ago. */
function writeClaim(pid: number, agoMs = 0): void {
  fs.writeFileSync(
    instanceLockPath(dorkHome),
    JSON.stringify({
      pid,
      port: 4242,
      startedAt: new Date(Date.now() - agoMs).toISOString(),
      version: '1.2.3',
    })
  );
}

beforeEach(() => {
  dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-shared-lock-'));
});

afterEach(() => {
  fs.rmSync(dorkHome, { recursive: true, force: true });
});

describe('instanceLockPath', () => {
  it('names the file inside the data directory it is scoped to', () => {
    expect(instanceLockPath('/tmp/whatever')).toBe(
      path.join('/tmp/whatever', INSTANCE_LOCK_FILENAME)
    );
  });
});

describe('readInstanceLock', () => {
  it('reads a well-formed claim back', () => {
    writeClaim(LIVE_PID);

    expect(readInstanceLock(dorkHome)).toMatchObject({ pid: LIVE_PID, port: 4242 });
  });

  it('answers null when there is no claim at all', () => {
    expect(readInstanceLock(dorkHome)).toBeNull();
  });

  it.each([
    ['truncated JSON', '{"pid": 12'],
    ['the wrong shape', '{"pid": "not a number"}'],
    ['an out-of-range port', '{"pid":12,"port":0,"startedAt":"x","version":"1"}'],
  ])('answers null on %s rather than throwing', (_label, raw) => {
    // A file nobody can act on must not be able to wedge the server's boot or
    // the desktop's reset. Both treat "unreadable" as "no claim".
    fs.writeFileSync(instanceLockPath(dorkHome), raw);

    expect(readInstanceLock(dorkHome)).toBeNull();
  });
});

describe('assessInstanceLockHolder', () => {
  it('confirms a holder that really is still running', () => {
    // Started before it wrote its claim, which is the only order a real holder
    // can manage.
    expect(
      assessInstanceLockHolder({
        pid: LIVE_PID,
        port: 4242,
        startedAt: new Date().toISOString(),
        version: '1',
      })
    ).toBe('live-confirmed');
  });

  it('calls a dead pid gone, so a crashed instance never wedges the next one', () => {
    expect(
      assessInstanceLockHolder({
        pid: DEAD_PID,
        port: 4242,
        startedAt: new Date().toISOString(),
        version: '1',
      })
    ).toBe('gone');
  });

  it('calls a claim naming this very process gone', () => {
    // A lock file naming us is one we are about to replace, not a rival.
    expect(
      assessInstanceLockHolder({
        pid: process.pid,
        port: 4242,
        startedAt: new Date().toISOString(),
        version: '1',
      })
    ).toBe('gone');
  });

  it('calls a pid that started AFTER the claim gone — it is a recycled pid', () => {
    // The live process wearing this pid cannot be the one that wrote a claim
    // from before it existed. Trusting the pid alone would refuse every future
    // start forever, and name an innocent process to kill.
    expect(
      assessInstanceLockHolder({
        pid: LIVE_PID,
        port: 4242,
        startedAt: new Date(Date.now() - 10 * 365 * 24 * 60 * 60 * 1000).toISOString(),
        version: '1',
      })
    ).toBe('gone');
  });
});

describe('liveInstanceLockHolder', () => {
  it('names the instance still holding the directory', () => {
    writeClaim(LIVE_PID);

    expect(liveInstanceLockHolder(dorkHome)?.pid).toBe(LIVE_PID);
  });

  it('answers null for a free directory', () => {
    expect(liveInstanceLockHolder(dorkHome)).toBeNull();
  });

  it('answers null for a claim left behind by a process that is gone', () => {
    writeClaim(DEAD_PID);

    expect(liveInstanceLockHolder(dorkHome)).toBeNull();
  });
});
