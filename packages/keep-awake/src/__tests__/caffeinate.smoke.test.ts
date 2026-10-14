/**
 * Real-OS smoke for the macOS holder: a real `caffeinate`, a real
 * `pmset -g assertions`, no fake spawn.
 *
 * The unit tests prove the engine's bookkeeping against a fake spawner; this is
 * the one place that proves the OS agrees — that a hold really shows up as a
 * PreventUserIdleSystemSleep assertion, that a release really removes it, and
 * that the owner dying really ends it (`caffeinate -w`).
 *
 * OPT-IN AND MAC-ONLY. It runs only when `DORKOS_KEEP_AWAKE_SMOKE=1` is set on
 * a Mac (`pnpm --filter @dorkos/keep-awake smoke`). Everywhere else it is
 * collected and skipped, so `pnpm test` and CI never touch the OS. The variable
 * is not passed through by any turbo task, so CI cannot arm it by accident.
 * Manual test plan and the human scenarios: contributing/keep-awake.md.
 *
 * Other apps hold their own assertions (ChatGPT, video calls, powerd while the
 * display is on). The checks below only look at assertions made on behalf of
 * this test's own owner pid, so those never mask a result here.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createKeepAwake, type KeepAwake } from '../keep-awake.js';
import type { ChildLike, SpawnLike } from '../holders/types.js';

// eslint-disable-next-line no-restricted-syntax -- a test-only opt-in flag; this package has no env.ts
const ARMED = process.env.DORKOS_KEEP_AWAKE_SMOKE === '1' && process.platform === 'darwin';

/** One caffeinate assertion as `pmset -g assertions` lists it. */
interface CaffeinateAssertion {
  /** The caffeinate process holding the assertion. */
  holderPid: number;
  /** The pid caffeinate was told to watch (`-w`), from the Details line. */
  onBehalfOf: number | null;
  /** The assertion type, e.g. PreventUserIdleSystemSleep. */
  type: string;
}

/** Every assertion caffeinate holds right now, parsed from `pmset -g assertions`. */
function caffeinateAssertions(): CaffeinateAssertion[] {
  const out = execFileSync('/usr/bin/pmset', ['-g', 'assertions'], { encoding: 'utf8' });
  const lines = out.split('\n');
  const found: CaffeinateAssertion[] = [];
  lines.forEach((line, i) => {
    const head = /^\s*pid (\d+)\(caffeinate\): \[[^\]]+\] \S+ (\w+) named:/.exec(line);
    if (!head) return;
    const details = /on behalf of Process ID (\d+)/.exec(lines[i + 1] ?? '');
    found.push({
      holderPid: Number(head[1]),
      onBehalfOf: details ? Number(details[1]) : null,
      type: head[2]!,
    });
  });
  return found;
}

/** The idle-sleep assertions made on behalf of `ownerPid`. */
function heldFor(ownerPid: number): CaffeinateAssertion[] {
  return caffeinateAssertions().filter(
    (a) => a.onBehalfOf === ownerPid && a.type === 'PreventUserIdleSystemSleep'
  );
}

/** Poll until `check` is true, or fail with `what` after `timeoutMs`. */
async function waitFor(what: string, check: () => boolean, timeoutMs = 5_000): Promise<number> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs)
      throw new Error(`timed out after ${timeoutMs} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return Date.now() - started;
}

/** Whether `pid` still exists. A just-exited child counts until Node reaps it, hence the polling. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Every pid this file started, so afterEach can stop them even when a check fails. */
const started = new Set<number>();
let keepAwake: KeepAwake | null = null;

/** The real `child_process.spawn`, recording each holder's pid for the checks and the cleanup. */
const holderPids: number[] = [];
const recordingSpawn: SpawnLike = (command, args, options) => {
  const child = spawn(command, [...args], options);
  if (child.pid !== undefined) {
    holderPids.push(child.pid);
    started.add(child.pid);
  }
  return child as unknown as ChildLike;
};

/** A throwaway owner: a node process that idles until it is killed. */
function startOwner(): ChildProcess {
  const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
  if (owner.pid === undefined) throw new Error('could not start the owner process');
  started.add(owner.pid);
  return owner;
}

afterEach(async () => {
  await keepAwake?.dispose();
  keepAwake = null;
  for (const pid of started) {
    if (isAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Gone between the check and the kill.
      }
    }
  }
  started.clear();
  holderPids.length = 0;
});

describe.skipIf(!ARMED)('caffeinate on this Mac (DORKOS_KEEP_AWAKE_SMOKE=1)', () => {
  it('asserts on hold, drops on release, and drops when the owner dies', async () => {
    const owner = startOwner();
    const ownerPid = owner.pid!;
    keepAwake = createKeepAwake({ watchPid: ownerPid, lingerMs: 50, spawn: recordingSpawn });
    expect(keepAwake.status()).toMatchObject({ supported: true, mechanism: 'caffeinate' });
    expect(heldFor(ownerPid)).toEqual([]);

    // 1. A hold shows up in pmset, held by the holder this engine spawned.
    const first = keepAwake.hold('smoke');
    const assertMs = await waitFor('the assertion to appear', () => heldFor(ownerPid).length > 0);
    const [asserted] = heldFor(ownerPid);
    expect(holderPids).toContain(asserted!.holderPid);
    expect(keepAwake.status().asserted).toBe(true);
    console.info(
      `[smoke] hold → asserted by caffeinate pid ${asserted!.holderPid} in ${assertMs} ms`
    );

    // 2. Release: after the linger the holder is stopped and the assertion is gone.
    first.release();
    const releaseMs = await waitFor('the assertion to clear', () => heldFor(ownerPid).length === 0);
    await waitFor('the first holder to exit', () => !isAlive(asserted!.holderPid));
    expect(keepAwake.status().asserted).toBe(false);
    console.info(`[smoke] release → assertion gone in ${releaseMs} ms`);

    // 3. Hold again, then kill the owner: caffeinate -w ends the assertion.
    // A dead owner makes every new caffeinate exit 0 at once, which the engine
    // reads as its -t running out and respawns, until dispose. Unreachable in
    // DorkOS (the server watches its own pid, so the engine dies with the
    // owner); the count below makes it visible rather than hiding it.
    keepAwake.hold('smoke again');
    await waitFor('the second assertion to appear', () => heldFor(ownerPid).length > 0);
    const [second] = heldFor(ownerPid);
    expect(second!.holderPid).not.toBe(asserted!.holderPid);
    const spawnedBeforeKill = holderPids.length;
    owner.kill('SIGKILL');
    const ownerGoneMs = await waitFor(
      'the assertion to clear after the owner died',
      () => heldFor(ownerPid).length === 0
    );
    await waitFor('the second holder to exit', () => !isAlive(second!.holderPid));
    console.info(
      `[smoke] owner killed → assertion gone in ${ownerGoneMs} ms; ` +
        `holders spawned after the kill: ${holderPids.length - spawnedBeforeKill}`
    );
  }, 30_000);
});
