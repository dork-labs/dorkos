import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TestInfo } from '@playwright/test';
import { afterEach, describe, expect, it } from 'vitest';
import { SOLE_SIDEBAR_TAG, lockDirFor, soleAccess } from '../fixtures/sole-access';

/**
 * The lock behind `@sole-sidebar` (DOR-1420).
 *
 * Four properties, and the last two are the ones a reviewer broke by hand on the
 * first cut of this fixture: a hold that outlived the staleness threshold was
 * taken over while it was still being used, and the robbed holder then deleted
 * its successor's lock on the way out, so one stolen lock cascaded into a queue
 * that had stopped excluding anybody.
 *
 * What is NOT pinned here is the heartbeat, and it is worth saying so rather
 * than letting a green file imply otherwise: exercising it means holding a lock
 * past `STALE_AFTER_MS`, which is a minute of wall clock for one assertion. The
 * takeover rule has two halves and these cases pin the load-bearing one — a lock
 * is never taken from a process that still exists — so the heartbeat is the
 * second line rather than the only one.
 *
 * Every case uses a key of its own, so these run beside each other and beside a
 * real browser run on the same machine.
 */

/** Lock directories a case staged or took, removed however the case ended. */
const staged: string[] = [];

/**
 * A unique key, remembered for cleanup.
 *
 * @param label - Names the case in the directory, for a failure worth reading.
 */
function key(label: string): string {
  const value = `vitest-${label}-${randomUUID()}`;
  staged.push(lockDirFor(value));
  return value;
}

/**
 * A stand-in for the running test, recording what the fixture did to its
 * deadline.
 *
 * @param tags - What the notional spec is tagged with.
 * @param timeout - Its configured deadline, or `0` for none.
 */
function fakeTestInfo(tags: string[], timeout = 30_000) {
  const setTimeouts: number[] = [];
  const info = {
    tags,
    timeout,
    annotations: [] as TestInfo['annotations'],
    setTimeout(value: number) {
      setTimeouts.push(value);
      info.timeout = value;
    },
  };
  return { info: info as unknown as TestInfo, setTimeouts };
}

/**
 * A pid that is certainly not running.
 *
 * A real child, started and reaped, rather than a large number nobody is using:
 * `pid_max` differs by platform, so "surely nothing is this high" is a guess and
 * an exited child is a fact.
 */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  expect(child.pid, 'could not start a child to reap').toBeGreaterThan(0);
  return child.pid!;
}

/**
 * Put a lock in place as if some other run had taken it.
 *
 * @param lockKey - The key to stage a lock for.
 * @param holderPid - The process the holder file names.
 * @param ageMs - How long ago it was last touched.
 */
async function stageLock(lockKey: string, holderPid: number, ageMs: number): Promise<string> {
  const dir = lockDirFor(lockKey);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'holder'), `${holderPid}\n${randomUUID()}`);
  const when = new Date(Date.now() - ageMs);
  await utimes(dir, when, when);
  return dir;
}

/** Resolve after `ms`, for asking whether something has NOT happened yet. */
const after = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

afterEach(async () => {
  for (const dir of staged.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('sole access to the shared sidebar', () => {
  it('lets an untagged test straight through, even while the lock is held', async () => {
    const shared = key('untagged');
    await stageLock(shared, process.pid, 0);

    const { info } = fakeTestInfo(['@smoke']);
    let ran = false;
    await soleAccess(shared, info, async () => {
      ran = true;
    });

    expect(ran, 'an untagged test waited for a lock it never needed').toBe(true);
  });

  it('holds a tagged test until the one before it is done', async () => {
    const shared = key('exclusion');
    const order: string[] = [];

    const first = soleAccess(shared, fakeTestInfo([SOLE_SIDEBAR_TAG]).info, async () => {
      order.push('first in');
      await after(150);
      order.push('first out');
    });
    // Started second, and deliberately after a beat so the first has certainly
    // taken the lock — the claim is about waiting, not about scheduling luck.
    await after(20);
    const second = soleAccess(shared, fakeTestInfo([SOLE_SIDEBAR_TAG]).info, async () => {
      order.push('second in');
    });

    await Promise.all([first, second]);
    expect(order).toEqual(['first in', 'first out', 'second in']);
  });

  it('refunds the queue to the waiting test’s own deadline', async () => {
    const shared = key('refund');
    const held = soleAccess(shared, fakeTestInfo([SOLE_SIDEBAR_TAG]).info, () => after(300));
    await after(20);

    const { info, setTimeouts } = fakeTestInfo([SOLE_SIDEBAR_TAG], 30_000);
    await soleAccess(shared, info, async () => {});
    await held;

    // Raised before the wait, then brought back down to the configured deadline
    // plus exactly what the queue cost. The order matters as much as the values:
    // raising it only afterwards is what let a queued test die mid-wait.
    expect(setTimeouts).toHaveLength(2);
    expect(setTimeouts[0]!, 'the ceiling was not raised before waiting').toBeGreaterThan(30_000);
    expect(setTimeouts[1]!).toBeGreaterThanOrEqual(30_000);
    // The refund is the wait, not the whole timeout again.
    expect(setTimeouts[1]!).toBeLessThan(30_000 + 30_000);
  });

  it('takes over a lock whose holder is gone', async () => {
    const shared = key('abandoned');
    await stageLock(shared, deadPid(), 10 * 60_000);

    const { info } = fakeTestInfo([SOLE_SIDEBAR_TAG]);
    let ran = false;
    await soleAccess(shared, info, async () => {
      ran = true;
    });

    expect(ran, 'a lock left behind by a killed run was never reclaimed').toBe(true);
  });

  it('leaves a lock alone while its holder is alive, however old it is', async () => {
    // The reviewer's mutation. Nothing refreshed the lock's mtime on the first
    // cut, so a hold that simply lasted longer than the staleness threshold read
    // as abandoned and a second test took it — two concurrent holders of a lock
    // whose entire job is that there is only ever one.
    const shared = key('live-holder');
    const dir = await stageLock(shared, process.pid, 10 * 60_000);

    let ran = false;
    const waiting = soleAccess(shared, fakeTestInfo([SOLE_SIDEBAR_TAG]).info, async () => {
      ran = true;
    });

    await after(400);
    expect(ran, 'a live holder’s lock was stolen because it was old').toBe(false);

    // …and it is a wait, not a hang: the moment the holder lets go, it proceeds.
    await rm(dir, { recursive: true, force: true });
    await waiting;
    expect(ran).toBe(true);
  });

  it('never deletes a successor’s lock when its own was stolen', async () => {
    // The cascade. If a takeover ever does happen, an unconditional `rm` in the
    // release path deletes the THIEF's lock, and a third waiter walks into a lock
    // two tests already believe they hold — one broken exclusion becoming a
    // broken queue.
    const shared = key('stolen');
    let thiefDir = '';
    await soleAccess(shared, fakeTestInfo([SOLE_SIDEBAR_TAG]).info, async () => {
      thiefDir = lockDirFor(shared);
      await rm(thiefDir, { recursive: true, force: true });
      // Somebody else's hold, with its own nonce.
      await stageLock(shared, process.pid, 0);
    });

    expect(existsSync(thiefDir), 'the robbed holder deleted the lock that replaced its own').toBe(
      true
    );
  });
});
