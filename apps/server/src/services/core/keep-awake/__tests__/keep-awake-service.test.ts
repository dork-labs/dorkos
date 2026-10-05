/**
 * The DorkOS keep-awake service: each unit of work counts once, the setting is
 * followed live, the app is told (coalesced), and the idle ceiling bounds the
 * one leak the turn wrapper cannot see.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createKeepAwake, type KeepAwakeOptions } from '@dorkos/keep-awake';
import type { KeepAwakeStatus } from '@dorkos/shared/schemas';
import { KeepAwakeService, TURN_IDLE_CEILING_MS } from '../keep-awake-service.js';

/** A spawned-process stand-in: exits when signalled. */
class FakeChild extends EventEmitter {
  pid = 999;
  kill(): boolean {
    this.emit('exit', null, 'SIGTERM');
    return true;
  }
}

/** A real package handle on a pretend Mac whose holder never touches the OS. */
function fakeFactory(overrides: Partial<KeepAwakeOptions> = {}) {
  const spawned: string[][] = [];
  const factory = (options?: KeepAwakeOptions) =>
    createKeepAwake({
      ...options,
      platform: 'darwin',
      env: {},
      fileExists: () => false,
      readFile: () => null,
      spawn: (command, args) => {
        spawned.push([command, ...args]);
        return new FakeChild() as never;
      },
      ...overrides,
    });
  return { factory, spawned };
}

function started(overrides: Partial<KeepAwakeOptions> = {}) {
  const service = new KeepAwakeService();
  const { factory, spawned } = fakeFactory(overrides);
  const broadcasts: KeepAwakeStatus[] = [];
  let settings = { whileAgentsWork: true };
  let settingsListener: ((sections: readonly string[]) => void) | null = null;
  service.start({
    readSettings: () => settings,
    onSettingsChange: (listener) => {
      settingsListener = listener;
      return () => {
        settingsListener = null;
      };
    },
    broadcast: (status) => broadcasts.push(status),
    createKeepAwake: factory,
  });
  const writeSettings = (next: { whileAgentsWork: boolean }, sections = ['keepAwake']) => {
    settings = next;
    settingsListener?.(sections);
  };
  return { service, spawned, broadcasts, writeSettings };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('counting: every unit of work appears once', () => {
  it('labels a plain turn a chat and a roomTurn a room', () => {
    const service = new KeepAwakeService();
    service.holdTurn({ sessionId: 'a', room: false });
    service.holdTurn({ sessionId: 'b', room: true });
    expect(service.status().working).toEqual({ chats: 1, rooms: 1, tasks: 0, waking: false });
  });

  it('counts a task run with its turn in flight as one task and no chat', () => {
    const service = new KeepAwakeService();
    const task = service.holdTask('run-1');
    task.attachSession('session-1');
    service.holdTurn({ sessionId: 'session-1', room: false });
    expect(service.status().working).toMatchObject({ chats: 0, rooms: 0, tasks: 1 });
  });

  it('counts a run before it knows its session, and a stranger’s turn as a chat', () => {
    const service = new KeepAwakeService();
    service.holdTask('run-1');
    service.holdTurn({ sessionId: 'someone-else', room: false });
    expect(service.status().working).toMatchObject({ chats: 1, tasks: 1 });
  });

  it('releases each hold once, however often release is called', () => {
    const service = new KeepAwakeService();
    const turn = service.holdTurn({ sessionId: 'a', room: false });
    const task = service.holdTask('run-1');
    turn.release();
    turn.release();
    task.release();
    task.release();
    expect(service.status().working).toEqual({ chats: 0, rooms: 0, tasks: 0, waking: false });
  });
});

describe('start', () => {
  it('carries holds opened before boot into the real holder', () => {
    const service = new KeepAwakeService();
    service.holdTurn({ sessionId: 'early', room: false });
    const { factory, spawned } = fakeFactory();
    service.start({
      readSettings: () => ({ whileAgentsWork: true }),
      onSettingsChange: () => () => {},
      broadcast: () => {},
      createKeepAwake: factory,
    });
    expect(spawned).toEqual([
      ['/usr/bin/caffeinate', '-i', '-w', String(process.pid), '-t', '300'],
    ]);
    expect(service.status()).toMatchObject({ asserted: true, working: { chats: 1 } });
  });

  it('holds nothing, and says why, in a container', () => {
    const { service, spawned } = started({ fileExists: (p) => p === '/.dockerenv' });
    service.holdTurn({ sessionId: 'a', room: false });
    expect(spawned).toHaveLength(0);
    expect(service.status()).toMatchObject({
      supported: false,
      reason: 'container',
      asserted: false,
      working: { chats: 1 },
    });
  });
});

describe('the setting', () => {
  it('follows a settings write live, both ways, without losing the count', () => {
    const { service, writeSettings } = started();
    service.holdTurn({ sessionId: 'a', room: false });
    expect(service.status()).toMatchObject({ enabled: true, asserted: true });

    writeSettings({ whileAgentsWork: false });
    expect(service.status()).toMatchObject({
      enabled: false,
      asserted: false,
      working: { chats: 1 },
    });

    writeSettings({ whileAgentsWork: true });
    expect(service.status()).toMatchObject({ enabled: true, asserted: true });
  });

  it('ignores writes to other sections', () => {
    const { service, writeSettings } = started();
    writeSettings({ whileAgentsWork: false }, ['scheduler']);
    expect(service.status().enabled).toBe(true);
  });

  it('turns Codex’s own inhibitor on only while enabled and supported', () => {
    expect(new KeepAwakeService().preventsIdleSleep()).toBe(false);

    const { service, writeSettings } = started();
    expect(service.preventsIdleSleep()).toBe(true);
    writeSettings({ whileAgentsWork: false });
    expect(service.preventsIdleSleep()).toBe(false);

    expect(started({ env: { container: 'docker' } }).service.preventsIdleSleep()).toBe(false);
  });
});

describe('broadcasting', () => {
  it('sends the first change at once and folds a burst into one trailing update', () => {
    const { service, broadcasts } = started();
    const a = service.holdTurn({ sessionId: 'a', room: false });
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({ asserted: true, working: { chats: 1 } });

    service.holdTurn({ sessionId: 'b', room: true });
    a.release();
    service.holdTask('run-1');
    expect(broadcasts).toHaveLength(1);

    vi.advanceTimersByTime(500);
    expect(broadcasts).toHaveLength(2);
    expect(broadcasts[1]!.working).toEqual({ chats: 0, rooms: 1, tasks: 1, waking: false });
  });

  it('reports the same shape the route serves', () => {
    const { service, broadcasts } = started();
    service.holdTurn({ sessionId: 'a', room: false });
    expect(broadcasts[0]).toEqual(service.status());
    expect(service.status().wake).toEqual({
      enabled: false,
      setup: 'unsupported',
      nextWakeAt: null,
      setupCommand: null,
    });
  });
});

describe('the idle ceiling', () => {
  it('releases a turn silent for two hours when no helper is working, with a warning', () => {
    const service = new KeepAwakeService();
    const now = Date.now();
    service.holdTurn({ sessionId: 'stuck', room: false, isHelperWorking: () => false });
    service.sweepIdleTurns(now + TURN_IDLE_CEILING_MS - 1);
    expect(service.status().working.chats).toBe(1);

    service.sweepIdleTurns(now + TURN_IDLE_CEILING_MS);
    expect(service.status().working.chats).toBe(0);
  });

  it('keeps a quiet turn whose background helper is still working', () => {
    const service = new KeepAwakeService();
    service.holdTurn({ sessionId: 'busy', room: false, isHelperWorking: () => true });
    service.sweepIdleTurns(Date.now() + TURN_IDLE_CEILING_MS * 3);
    expect(service.status().working.chats).toBe(1);
  });

  it('resets the idle clock on every event', () => {
    const service = new KeepAwakeService();
    const start = Date.now();
    const turn = service.holdTurn({ sessionId: 'chatty', room: false });
    vi.setSystemTime(start + TURN_IDLE_CEILING_MS - 1000);
    turn.touch();
    service.sweepIdleTurns(start + TURN_IDLE_CEILING_MS + 1000);
    expect(service.status().working.chats).toBe(1);
  });

  it('runs on its own once started', () => {
    const { service } = started();
    service.holdTurn({ sessionId: 'stuck', room: false, isHelperWorking: () => false });
    vi.advanceTimersByTime(TURN_IDLE_CEILING_MS + 60_000);
    expect(service.status().working.chats).toBe(0);
  });
});

describe('stop', () => {
  it('stops the holder and is idempotent', async () => {
    const { service } = started();
    service.holdTurn({ sessionId: 'a', room: false });
    await service.stop();
    await service.stop();
    expect(service.status()).toMatchObject({ asserted: false, working: { chats: 1 } });
  });
});
