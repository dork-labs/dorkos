/**
 * Modes, timed sessions, the screen and the power rules (DOR-2920): when the
 * service holds the computer on its own, at what level, and when a power rule
 * pauses it. Driven through a real package handle on a pretend Mac, so the
 * assertions read what the OS would have been told.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createKeepAwake, type KeepAwakeOptions, type PowerReading } from '@dorkos/keep-awake';
import type { KeepAwakeStatus } from '@dorkos/shared/schemas';
import { KeepAwakeService } from '../keep-awake-service.js';
import {
  activeSessionUntil,
  DEFAULT_KEEP_AWAKE_SETTINGS,
  powerBlock,
  type KeepAwakeSettings,
} from '../keep-awake-policy.js';

const NOW = new Date('2026-10-14T12:00:00Z').getTime();
const inMinutes = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

class FakeChild extends EventEmitter {
  pid = 999;
  kill(): boolean {
    this.emit('exit', null, 'SIGTERM');
    return true;
  }
}

/** A started service over a fake Mac, with settings and power you can change. */
function harness(initial: Partial<KeepAwakeSettings> = {}) {
  const service = new KeepAwakeService();
  const spawned: string[][] = [];
  const alive = new Set<FakeChild>();
  const broadcasts: KeepAwakeStatus[] = [];
  let settings: Partial<KeepAwakeSettings> = { ...DEFAULT_KEEP_AWAKE_SETTINGS, ...initial };
  let power: PowerReading | null = { onAc: true, percent: 100 };
  const readPower = vi.fn(async () => power);
  let listener: ((sections: readonly string[]) => void) | null = null;
  service.start({
    readSettings: () => settings,
    onSettingsChange: (next) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
    broadcast: (status) => broadcasts.push(status),
    readPower,
    createKeepAwake: (options?: KeepAwakeOptions) =>
      createKeepAwake({
        ...options,
        platform: 'darwin',
        env: {},
        fileExists: () => false,
        readFile: () => null,
        spawn: (command, args) => {
          spawned.push([command, ...args]);
          const child = new FakeChild();
          alive.add(child);
          child.once('exit', () => alive.delete(child));
          return child as never;
        },
      }),
  });
  return {
    service,
    spawned,
    broadcasts,
    readPower,
    /** Holders still running. */
    alive: () => alive.size,
    write(next: Partial<KeepAwakeSettings>) {
      settings = { ...settings, ...next };
      listener?.(['keepAwake']);
    },
    setPower(next: PowerReading | null) {
      power = next;
    },
  };
}

/** Let pending power reads settle. */
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('policy helpers', () => {
  it('treats a past, missing or unreadable session end as no session', () => {
    const at = (manualUntil: string | null) => ({ ...DEFAULT_KEEP_AWAKE_SETTINGS, manualUntil });
    expect(activeSessionUntil(at(inMinutes(5)), NOW)).toBe(inMinutes(5));
    expect(activeSessionUntil(at(inMinutes(-1)), NOW)).toBeNull();
    expect(activeSessionUntil(at(new Date(NOW).toISOString()), NOW)).toBeNull();
    expect(activeSessionUntil(at(null), NOW)).toBeNull();
    expect(activeSessionUntil(at('not a date'), NOW)).toBeNull();
  });

  it.each([
    [{ onlyOnPower: true }, { onAc: false, percent: 80 }, 'on-battery'],
    [{ onlyOnPower: true }, { onAc: true, percent: 80 }, null],
    [{ stopBelowBatteryPercent: 20 }, { onAc: false, percent: 19 }, 'low-battery'],
    [{ stopBelowBatteryPercent: 20 }, { onAc: false, percent: 20 }, null],
    [{ stopBelowBatteryPercent: 20 }, { onAc: true, percent: 5 }, null],
    [{ stopBelowBatteryPercent: 20 }, { onAc: false, percent: null }, null],
    [{ onlyOnPower: true, stopBelowBatteryPercent: 20 }, { onAc: false, percent: 5 }, 'on-battery'],
    [{ onlyOnPower: true }, null, null],
    [{}, { onAc: false, percent: 1 }, null],
  ] as const)('power rules %o on %o block as %s', (rules, reading, expected) => {
    expect(powerBlock({ ...DEFAULT_KEEP_AWAKE_SETTINGS, ...rules }, reading)).toBe(expected);
  });
});

describe('modes × timed session × work', () => {
  // Each row: the settings, whether work is open, and whether the computer is
  // held. A timed session wins even over `off`; `always` needs no work.
  it.each([
    ['off', null, false, false],
    ['off', null, true, false],
    ['agents', null, false, false],
    ['agents', null, true, true],
    ['always', null, false, true],
    ['always', null, true, true],
    ['off', 30, false, true],
    ['off', 30, true, true],
    ['agents', 30, false, true],
    ['off', -5, true, false],
    ['agents', -5, false, false],
  ] as const)('mode %s, session %s min, work %s → held %s', (mode, minutes, work, held) => {
    const h = harness({ mode, manualUntil: minutes === null ? null : inMinutes(minutes) });
    if (work) h.service.holdTurn({ sessionId: 'a', room: false });
    expect(h.service.status().asserted).toBe(held);
    expect(h.service.status().mode).toBe(mode);
    expect(h.service.status().enabled).toBe(mode !== 'off');
    expect(h.service.status().manual).toEqual(
      minutes !== null && minutes > 0 ? { until: inMinutes(minutes) } : null
    );
  });

  it('counts a timed session or `always` as no work', () => {
    const h = harness({ mode: 'always' });
    expect(h.service.status().working).toEqual({ chats: 0, rooms: 0, tasks: 0, waking: false });
  });

  it('ends a timed session on time, without rewriting the setting', async () => {
    const h = harness({ mode: 'off', manualUntil: inMinutes(60) });
    expect(h.service.status()).toMatchObject({ asserted: true, manual: { until: inMinutes(60) } });

    await vi.advanceTimersByTimeAsync(60 * 60_000 + 1);
    expect(h.service.status().manual).toBeNull();
    // The holder lingers a few minutes, as after any last hold, then lets go.
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(h.service.status().asserted).toBe(false);
    expect(h.alive()).toBe(0);
    expect(h.broadcasts.at(-1)).toMatchObject({ manual: null, asserted: false });
  });

  it('starts, moves and ends a session live when the setting changes', async () => {
    const h = harness({ mode: 'off' });
    expect(h.service.status().asserted).toBe(false);

    h.write({ manualUntil: inMinutes(10) });
    expect(h.service.status()).toMatchObject({ asserted: true, manual: { until: inMinutes(10) } });

    h.write({ manualUntil: inMinutes(120) });
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(h.service.status().manual).toEqual({ until: inMinutes(120) });

    h.write({ manualUntil: null });
    expect(h.service.status().manual).toBeNull();
    // Mode `off`: the package is switched off, which stops the holder at once.
    expect(h.service.status().asserted).toBe(false);
  });

  it('switching from `always` to `agents` lets go once nothing works', async () => {
    const h = harness({ mode: 'always' });
    const turn = h.service.holdTurn({ sessionId: 'a', room: false });
    h.write({ mode: 'agents' });
    expect(h.service.status().asserted).toBe(true);
    turn.release();
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(h.service.status().asserted).toBe(false);
  });
});

describe('the screen', () => {
  it('holds the screen too while work runs, from the first holder', () => {
    const h = harness({ keepDisplayAwake: true });
    h.service.holdTurn({ sessionId: 'a', room: false });
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]).toContain('-d');
    expect(h.service.status().level).toBe('display');
  });

  it('holds the screen for a timed session', () => {
    const h = harness({ mode: 'off', manualUntil: inMinutes(30), keepDisplayAwake: true });
    expect(h.spawned).toHaveLength(1);
    expect(h.service.status().level).toBe('display');
  });

  it('raises and lowers the level live, new holder first', () => {
    const h = harness();
    h.service.holdTurn({ sessionId: 'a', room: false });
    expect(h.service.status().level).toBe('system');

    h.write({ keepDisplayAwake: true });
    expect(h.service.status().level).toBe('display');
    expect(h.spawned).toHaveLength(2);
    expect(h.alive()).toBe(1);

    h.write({ keepDisplayAwake: false });
    expect(h.service.status().level).toBe('system');
    expect(h.alive()).toBe(1);
  });

  it('holds nothing for the screen alone when nothing else is held', () => {
    const h = harness({ keepDisplayAwake: true });
    expect(h.spawned).toHaveLength(0);
    expect(h.service.status()).toMatchObject({ asserted: false, level: null });
  });
});

describe('power rules', () => {
  it('stops on battery with onlyOnPower, says why, and resumes on mains', async () => {
    const h = harness({ onlyOnPower: true });
    h.setPower({ onAc: false, percent: 80 });
    h.service.holdTurn({ sessionId: 'a', room: false });
    await flush();
    expect(h.service.status()).toMatchObject({ asserted: false, blocked: 'on-battery' });
    expect(h.service.preventsIdleSleep()).toBe(false);

    h.setPower({ onAc: true, percent: 80 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.service.status()).toMatchObject({ asserted: true, blocked: null });
  });

  it('stops below the battery floor and resumes once charging', async () => {
    const h = harness({ mode: 'always', stopBelowBatteryPercent: 20 });
    h.setPower({ onAc: false, percent: 15 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.service.status()).toMatchObject({ asserted: false, blocked: 'low-battery' });

    h.setPower({ onAc: true, percent: 16 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.service.status()).toMatchObject({ asserted: true, blocked: null });
  });

  it('pauses a timed session on battery too', async () => {
    const h = harness({ mode: 'off', manualUntil: inMinutes(60), onlyOnPower: true });
    // Read at boot on mains; the cable comes out; the next sweep sees it.
    h.setPower({ onAc: false, percent: 50 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.service.status()).toMatchObject({
      asserted: false,
      blocked: 'on-battery',
      manual: { until: inMinutes(60) },
    });
  });

  it('reads power at once when a rule is set, and lifts the block when it is cleared', async () => {
    const h = harness({ mode: 'always' });
    h.setPower({ onAc: false, percent: 50 });
    await flush();
    expect(h.readPower).not.toHaveBeenCalled();

    h.write({ onlyOnPower: true });
    await flush();
    expect(h.readPower).toHaveBeenCalledTimes(1);
    expect(h.service.status().blocked).toBe('on-battery');

    h.write({ onlyOnPower: false });
    expect(h.service.status()).toMatchObject({ blocked: null, asserted: true });
  });

  it('never reads power while nothing is wanted, and never blocks on an unknown reading', async () => {
    const h = harness({ onlyOnPower: true });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(h.readPower).not.toHaveBeenCalled();
    expect(h.service.status().blocked).toBeNull();

    h.setPower(null);
    h.service.holdTurn({ sessionId: 'a', room: false });
    await flush();
    expect(h.readPower).toHaveBeenCalledTimes(1);
    expect(h.service.status()).toMatchObject({ asserted: true, blocked: null });
  });

  it('keeps going when the power read throws', async () => {
    const h = harness({ mode: 'always', onlyOnPower: true });
    h.readPower.mockRejectedValueOnce(new Error('boom'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.service.status().asserted).toBe(true);
  });
});
