/**
 * The reference count and the holder lifecycle: these are the properties that
 * make it safe to open a hold on every agent turn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKeepAwake, type KeepAwakeOptions } from '../keep-awake.js';
import { fakeSpawner, type FakeSpawner } from './fake-spawn.js';

const PID = 4242;

/** A Mac with no container markers, a fake spawner, and a recording logger. */
function mac(spawner: FakeSpawner, overrides: Partial<KeepAwakeOptions> = {}) {
  const logger = { info: vi.fn(), warn: vi.fn() };
  const keepAwake = createKeepAwake({
    platform: 'darwin',
    watchPid: PID,
    fileExists: () => false,
    readFile: () => null,
    env: {},
    spawn: spawner.spawn,
    logger,
    ...overrides,
  });
  return { keepAwake, logger };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-05T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('reference counting', () => {
  it('starts exactly one holder for two holds and keeps it while one remains', () => {
    // Purpose: the assertion is ONE process however many turns run at once.
    const spawner = fakeSpawner();
    const { keepAwake } = mac(spawner);

    const a = keepAwake.hold('chat');
    const b = keepAwake.hold('task');
    expect(spawner.calls).toHaveLength(1);
    expect(keepAwake.status()).toMatchObject({
      holds: 2,
      asserted: true,
      reasons: ['chat', 'task'],
    });

    a.release();
    vi.advanceTimersByTime(60_000);
    expect(spawner.alive()).toHaveLength(1);
    expect(keepAwake.status()).toMatchObject({ holds: 1, asserted: true, reasons: ['task'] });
    b.release();
  });

  it('lingers after the last release, then stops the holder', () => {
    // Purpose: the computer may sleep again, but not before the linger.
    const spawner = fakeSpawner();
    const { keepAwake } = mac(spawner, { lingerMs: 30_000 });

    keepAwake.hold('chat').release();
    vi.advanceTimersByTime(29_999);
    expect(spawner.last().signals).toEqual([]);
    expect(keepAwake.status().asserted).toBe(true);

    vi.advanceTimersByTime(1);
    expect(spawner.last().signals).toEqual(['SIGTERM']);
    expect(keepAwake.status()).toMatchObject({ holds: 0, asserted: false });
  });

  it('lingers three minutes by default, so gaps between turns stay awake', () => {
    // Purpose: an agent's next turn often starts a minute or two after the last.
    const spawner = fakeSpawner();
    const { keepAwake } = mac(spawner);

    keepAwake.hold('chat').release();
    vi.advanceTimersByTime(3 * 60_000 - 1);
    expect(keepAwake.status().asserted).toBe(true);
    vi.advanceTimersByTime(1);
    expect(keepAwake.status().asserted).toBe(false);
  });

  it('keeps the same holder when a hold arrives during the linger', () => {
    // Purpose: back-to-back turns must not flap the assertion.
    const spawner = fakeSpawner();
    const { keepAwake } = mac(spawner);

    keepAwake.hold('first').release();
    vi.advanceTimersByTime(10_000);
    const second = keepAwake.hold('second');
    vi.advanceTimersByTime(60_000);

    expect(spawner.calls).toHaveLength(1);
    expect(spawner.last().signals).toEqual([]);
    second.release();
  });

  it('decrements once when a hold is released twice', () => {
    // Purpose: a caller may release in more than one `finally` safely.
    const spawner = fakeSpawner();
    const { keepAwake } = mac(spawner);

    const a = keepAwake.hold('a');
    keepAwake.hold('b');
    a.release();
    a.release();
    expect(keepAwake.status().holds).toBe(1);
  });

  it('never lets a throwing listener break a hold', () => {
    // Purpose: status plumbing cannot fail a turn.
    const spawner = fakeSpawner();
    const { keepAwake, logger } = mac(spawner);
    keepAwake.onChange(() => {
      throw new Error('listener boom');
    });

    expect(() => keepAwake.hold('chat').release()).not.toThrow();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('tells listeners about count and assertion changes', () => {
    const spawner = fakeSpawner();
    const { keepAwake } = mac(spawner);
    const seen: Array<[number, boolean]> = [];
    keepAwake.onChange((s) => seen.push([s.holds, s.asserted]));

    keepAwake.hold('chat').release();
    vi.advanceTimersByTime(3 * 60_000);

    expect(seen).toEqual([
      [1, true],
      [0, true],
      [0, false],
    ]);
  });
});

describe('the setting', () => {
  it('stops at once when disabled, keeps counting, and restarts at once when enabled', () => {
    // Purpose: toggling mid-turn takes effect immediately, both ways.
    const spawner = fakeSpawner();
    const { keepAwake } = mac(spawner);
    keepAwake.hold('chat');

    keepAwake.setEnabled(false);
    expect(spawner.calls[0]!.child.signals).toEqual(['SIGTERM']);
    expect(keepAwake.status()).toMatchObject({ holds: 1, asserted: false });

    keepAwake.hold('another');
    expect(spawner.calls).toHaveLength(1);
    expect(keepAwake.status().holds).toBe(2);

    keepAwake.setEnabled(true);
    expect(spawner.calls).toHaveLength(2);
    expect(keepAwake.status().asserted).toBe(true);
  });

  it('spawns nothing while created disabled', () => {
    const spawner = fakeSpawner();
    const { keepAwake } = mac(spawner, { enabled: false });
    keepAwake.hold('chat');
    expect(spawner.calls).toHaveLength(0);
    expect(keepAwake.status()).toMatchObject({ holds: 1, asserted: false, supported: true });
  });
});

describe('caffeinate holders', () => {
  it('runs caffeinate -i -w <pid> -t 300 with no shell', () => {
    const spawner = fakeSpawner();
    const { keepAwake } = mac(spawner);
    keepAwake.hold('chat');

    expect(spawner.calls[0]).toMatchObject({
      command: '/usr/bin/caffeinate',
      args: ['-i', '-w', String(PID), '-t', '300'],
      options: { stdio: 'ignore', detached: false, windowsHide: true },
    });
    expect(spawner.calls[0]!.options).not.toHaveProperty('shell');
  });

  it('renews by spawning the new holder before stopping the old one', () => {
    // Purpose: coverage never gaps across a renewal.
    const spawner = fakeSpawner();
    const { keepAwake } = mac(spawner);
    keepAwake.hold('chat');

    vi.advanceTimersByTime(240_000);
    expect(spawner.log).toEqual(['spawn:0', 'spawn:1', 'kill:0:SIGTERM']);
    expect(spawner.alive()).toHaveLength(1);
    expect(keepAwake.status().asserted).toBe(true);

    vi.advanceTimersByTime(240_000);
    expect(spawner.log.slice(3)).toEqual(['spawn:2', 'kill:1:SIGTERM']);
  });

  it('restarts quietly when caffeinate ran out its own -t (renewal was late)', () => {
    const spawner = fakeSpawner();
    const { keepAwake, logger } = mac(spawner);
    keepAwake.hold('chat');
    // The computer slept: the wall clock passed the 300 s `-t` before the
    // 240 s renewal timer could fire.
    vi.setSystemTime(Date.now() + 301_000);

    spawner.calls[0]!.child.exit(0);
    expect(spawner.calls).toHaveLength(2);
    expect(keepAwake.status()).toMatchObject({ supported: true, asserted: true });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('treats an exit 0 right after starting as a refusal, never a tight respawn loop', () => {
    // Purpose: `-w` on a pid caffeinate cannot watch exits 0 immediately;
    // reading that as a `-t` timeout respawned in a tight loop.
    const spawner = fakeSpawner((child) => {
      setTimeout(() => child.exit(0), 5);
    });
    const { keepAwake } = mac(spawner, { watchPid: 999_999 });
    keepAwake.hold('chat');
    vi.advanceTimersByTime(1_000);

    expect(spawner.calls).toHaveLength(1);
    expect(keepAwake.status()).toMatchObject({
      holds: 1,
      asserted: false,
      supported: false,
      reason: 'denied',
    });

    // It is retried on the backoff like any refusal.
    vi.advanceTimersByTime(30_000);
    expect(spawner.calls).toHaveLength(2);
  });

  it('sends SIGKILL when a holder ignores SIGTERM for two seconds', () => {
    // Purpose: no holder outlives a release.
    const spawner = fakeSpawner((child) => {
      child.exitsOnTerm = false;
    });
    const { keepAwake } = mac(spawner, { lingerMs: 0 });
    keepAwake.hold('chat').release();
    vi.advanceTimersByTime(0);
    expect(spawner.last().signals).toEqual(['SIGTERM']);

    vi.advanceTimersByTime(2_000);
    expect(spawner.last().signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(spawner.alive()).toHaveLength(0);
  });
});

describe('failures', () => {
  it('reports tool-missing on ENOENT, warns once, and keeps counting', () => {
    const spawner = fakeSpawner((child) => child.failToSpawn('ENOENT'));
    const { keepAwake, logger } = mac(spawner);

    for (let i = 0; i < 5; i++) keepAwake.hold(`chat ${i}`);

    expect(spawner.calls).toHaveLength(1);
    expect(keepAwake.status()).toMatchObject({
      supported: false,
      reason: 'tool-missing',
      asserted: false,
      holds: 5,
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('reports tool-missing when spawn itself throws ENOENT', () => {
    const { keepAwake } = mac({
      ...fakeSpawner(),
      spawn: () => {
        throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      },
    });
    expect(() => keepAwake.hold('chat')).not.toThrow();
    expect(keepAwake.status()).toMatchObject({ supported: false, reason: 'tool-missing' });
  });

  it('reports denied when the holder exits non-zero within a second (polkit refusal)', () => {
    const spawner = fakeSpawner((child) => {
      setTimeout(() => child.exit(1), 50);
    });
    const { keepAwake } = mac(spawner, { platform: 'linux' });
    keepAwake.hold('chat');
    vi.advanceTimersByTime(50);

    expect(keepAwake.status()).toMatchObject({
      supported: false,
      reason: 'denied',
      mechanism: 'systemd-inhibit',
    });
  });

  it('restarts an unexpected exit once, then reports denied on a second within a minute', () => {
    // Purpose: no restart storms.
    const spawner = fakeSpawner();
    const { keepAwake } = mac(spawner, { platform: 'linux' });
    keepAwake.hold('chat');

    vi.advanceTimersByTime(5_000);
    spawner.calls[0]!.child.exit(1);
    expect(spawner.calls).toHaveLength(2);
    expect(keepAwake.status().supported).toBe(true);

    vi.advanceTimersByTime(5_000);
    spawner.calls[1]!.child.exit(1);
    expect(spawner.calls).toHaveLength(2);
    expect(keepAwake.status()).toMatchObject({ supported: false, reason: 'denied' });
  });

  it('restarts again when the unexpected exits are more than a minute apart', () => {
    const spawner = fakeSpawner();
    const { keepAwake } = mac(spawner, { platform: 'linux' });
    keepAwake.hold('chat');

    vi.advanceTimersByTime(5_000);
    spawner.calls[0]!.child.exit(1);
    vi.advanceTimersByTime(61_000);
    spawner.calls[1]!.child.exit(1);
    expect(spawner.calls).toHaveLength(3);
    expect(keepAwake.status().supported).toBe(true);
  });

  it('never retries a missing tool', () => {
    // Purpose: what the environment rules out stays ruled out.
    const spawner = fakeSpawner((child) => child.failToSpawn('ENOENT'));
    const { keepAwake } = mac(spawner);
    keepAwake.hold('chat');

    vi.advanceTimersByTime(60 * 60_000);
    keepAwake.hold('another');
    expect(spawner.calls).toHaveLength(1);
    expect(keepAwake.status()).toMatchObject({ supported: false, reason: 'tool-missing' });
  });

  it('holds nothing in a container but still counts', () => {
    const spawner = fakeSpawner();
    const { keepAwake } = mac(spawner, {
      platform: 'linux',
      fileExists: (p) => p === '/.dockerenv',
    });
    keepAwake.hold('chat');

    expect(spawner.calls).toHaveLength(0);
    expect(keepAwake.status()).toMatchObject({
      supported: false,
      reason: 'container',
      mechanism: 'none',
      holds: 1,
    });
  });
});

/** A spawner whose holders refuse: each exits 1 fifty milliseconds after starting. */
function refusingSpawner(): FakeSpawner {
  return fakeSpawner((child) => {
    setTimeout(() => child.exit(1), 50);
  });
}

describe('retrying a denial', () => {
  it('tries a denied holder again after 30 s and recovers when it holds', () => {
    // Purpose: a passing refusal does not leave the computer unheld until restart.
    let refuse = true;
    const spawner = fakeSpawner((child) => {
      if (refuse) setTimeout(() => child.exit(1), 50);
    });
    const { keepAwake } = mac(spawner, { platform: 'linux' });
    keepAwake.hold('chat');
    vi.advanceTimersByTime(50);
    expect(keepAwake.status()).toMatchObject({ supported: false, reason: 'denied' });

    refuse = false;
    vi.advanceTimersByTime(30_000 - 1);
    expect(spawner.calls).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(spawner.calls).toHaveLength(2);
    expect(keepAwake.status()).toMatchObject({ supported: true, asserted: true });
    expect(keepAwake.status().reason).toBeUndefined();
  });

  it('backs off 30 s, 1 m, 2 m, 5 m, then every 10 m', () => {
    // Purpose: a refusal that persists is retried, but never in a storm.
    const spawner = refusingSpawner();
    const { keepAwake } = mac(spawner, { platform: 'linux' });
    keepAwake.hold('chat');
    vi.advanceTimersByTime(50);

    const waits = [30_000, 60_000, 120_000, 300_000, 600_000, 600_000];
    for (const [i, wait] of waits.entries()) {
      vi.advanceTimersByTime(wait - 1);
      expect(spawner.calls).toHaveLength(i + 1);
      vi.advanceTimersByTime(1);
      expect(spawner.calls).toHaveLength(i + 2);
      // The retried holder refuses too; the next wait is measured from here.
      vi.advanceTimersByTime(50);
      expect(keepAwake.status()).toMatchObject({ supported: false, reason: 'denied' });
    }
  });

  it('does not retry while nothing is held, then tries at once on the next hold', () => {
    const spawner = refusingSpawner();
    const { keepAwake } = mac(spawner, { platform: 'linux' });
    const hold = keepAwake.hold('chat');
    vi.advanceTimersByTime(50);
    hold.release();

    vi.advanceTimersByTime(60 * 60_000);
    expect(spawner.calls).toHaveLength(1);

    keepAwake.hold('next');
    expect(spawner.calls).toHaveLength(2);
  });

  it('waits out the backoff when a hold opens before it ends', () => {
    const spawner = refusingSpawner();
    const { keepAwake } = mac(spawner, { platform: 'linux' });
    keepAwake.hold('chat');
    vi.advanceTimersByTime(50);

    vi.advanceTimersByTime(10_000);
    keepAwake.hold('another');
    expect(spawner.calls).toHaveLength(1);
  });

  it('re-arms at once, with the backoff reset, when the setting is turned off and on', () => {
    // Purpose: the switch is how a person asks for another try.
    const spawner = refusingSpawner();
    const { keepAwake } = mac(spawner, { platform: 'linux' });
    keepAwake.hold('chat');
    vi.advanceTimersByTime(50);
    vi.advanceTimersByTime(30_000 + 50); // second refusal: the next wait is 1 m
    expect(spawner.calls).toHaveLength(2);

    keepAwake.setEnabled(false);
    expect(keepAwake.status()).toMatchObject({ supported: true, asserted: false });
    keepAwake.setEnabled(true);
    expect(spawner.calls).toHaveLength(3);

    // Refused again: back to the first step, 30 s.
    vi.advanceTimersByTime(50);
    vi.advanceTimersByTime(30_000);
    expect(spawner.calls).toHaveLength(4);
  });

  it('stops retrying once disposed', async () => {
    const spawner = refusingSpawner();
    const { keepAwake } = mac(spawner, { platform: 'linux' });
    keepAwake.hold('chat');
    vi.advanceTimersByTime(50);
    await keepAwake.dispose();
    vi.advanceTimersByTime(60 * 60_000);
    expect(spawner.calls).toHaveLength(1);
  });
});

describe('display level', () => {
  it('raises to display while a screen hold is open, new holder first, then drops back', () => {
    // Purpose: the level is the union of open holds, and a swap never leaves a gap.
    const spawner = fakeSpawner();
    const { keepAwake } = mac(spawner);

    const work = keepAwake.hold('chat');
    expect(spawner.calls[0]!.args).toEqual(['-i', '-w', String(PID), '-t', '300']);
    expect(keepAwake.status().level).toBe('system');

    const screen = keepAwake.hold('display', { display: true });
    expect(spawner.calls).toHaveLength(2);
    expect(spawner.calls[1]!.args).toEqual(['-i', '-d', '-w', String(PID), '-t', '300']);
    // The new holder was spawned before the old one was signalled.
    expect(spawner.log).toEqual(['spawn:0', 'spawn:1', 'kill:0:SIGTERM']);
    expect(spawner.alive()).toHaveLength(1);
    expect(keepAwake.status()).toMatchObject({ level: 'display', asserted: true, holds: 2 });

    screen.release();
    expect(spawner.calls).toHaveLength(3);
    expect(spawner.calls[2]!.args).toEqual(['-i', '-w', String(PID), '-t', '300']);
    expect(spawner.log.slice(3)).toEqual(['spawn:2', 'kill:1:SIGTERM']);
    expect(keepAwake.status().level).toBe('system');
    work.release();
  });

  it('does not swap when a second screen hold opens or one of two closes', () => {
    // Purpose: only a real level change costs a process.
    const spawner = fakeSpawner();
    const { keepAwake } = mac(spawner);

    const a = keepAwake.hold('a', { display: true });
    const b = keepAwake.hold('b', { display: true });
    keepAwake.hold('c');
    a.release();
    expect(spawner.calls).toHaveLength(1);
    expect(keepAwake.status().level).toBe('display');
    b.release();
    expect(spawner.calls).toHaveLength(2);
    expect(keepAwake.status().level).toBe('system');
  });

  it('keeps the level through the linger, then lets go', () => {
    // Purpose: the last release never spawns a holder only to stop it minutes later.
    const spawner = fakeSpawner();
    const { keepAwake } = mac(spawner, { lingerMs: 30_000 });

    keepAwake.hold('display', { display: true }).release();
    expect(spawner.calls).toHaveLength(1);
    expect(keepAwake.status()).toMatchObject({ level: 'display', asserted: true });
    vi.advanceTimersByTime(30_000);
    expect(keepAwake.status()).toMatchObject({ level: null, asserted: false });
  });

  it('renews at the same level', () => {
    const spawner = fakeSpawner();
    const { keepAwake } = mac(spawner);

    const screen = keepAwake.hold('display', { display: true });
    vi.advanceTimersByTime(240_000);
    expect(spawner.calls).toHaveLength(2);
    expect(spawner.calls[1]!.args).toContain('-d');
    screen.release();
  });

  it('starts at display when the first hold asks for the screen', () => {
    const spawner = fakeSpawner();
    const { keepAwake } = mac(spawner);
    const screen = keepAwake.hold('display', { display: true });
    expect(spawner.calls).toHaveLength(1);
    expect(spawner.calls[0]!.args).toContain('-d');
    expect(screen.display).toBe(true);
    screen.release();
  });

  it('stays at system on Linux, where the screen cannot be promised', () => {
    // Purpose: status never claims a level the mechanism cannot hold.
    const spawner = fakeSpawner();
    const keepAwake = createKeepAwake({
      platform: 'linux',
      watchPid: PID,
      fileExists: () => false,
      readFile: () => null,
      env: {},
      spawn: spawner.spawn,
    });
    keepAwake.hold('chat');
    keepAwake.hold('display', { display: true });
    expect(spawner.calls).toHaveLength(1);
    expect(keepAwake.status().level).toBe('system');
  });

  it('reports no level while disabled, and opens at the wanted level when enabled', () => {
    const spawner = fakeSpawner();
    const { keepAwake } = mac(spawner, { enabled: false });
    keepAwake.hold('display', { display: true });
    expect(spawner.calls).toHaveLength(0);
    expect(keepAwake.status().level).toBeNull();
    keepAwake.setEnabled(true);
    expect(spawner.calls[0]!.args).toContain('-d');
    expect(keepAwake.status().level).toBe('display');
  });
});

describe('dispose', () => {
  it('stops the holder, is idempotent, and makes later holds inert', async () => {
    const spawner = fakeSpawner();
    const { keepAwake } = mac(spawner);
    keepAwake.hold('chat');

    await keepAwake.dispose();
    await keepAwake.dispose();
    expect(spawner.calls[0]!.child.signals).toEqual(['SIGTERM']);
    expect(keepAwake.status().asserted).toBe(false);

    keepAwake.hold('late');
    expect(spawner.calls).toHaveLength(1);
  });
});
