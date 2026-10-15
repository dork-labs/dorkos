/**
 * Heartbeats at boot (spec `heartbeats` §3.6, PR 3 review A5): off is really
 * off — no beat timer, no outbox tick, no wake window — and turning it on and
 * off again follows the setting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';

const config = vi.hoisted(() => ({
  enabled: false,
  listeners: [] as Array<(change: { sections: string[]; paths: string[] }) => void>,
}));

vi.mock('../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) =>
      key === 'heartbeats'
        ? { enabled: config.enabled }
        : { timezone: 'America/New_York', workingHours: null, away: null },
    onChange: (listener: (change: { sections: string[]; paths: string[] }) => void) => {
      config.listeners.push(listener);
      return () => undefined;
    },
  },
}));

const lifecycle = vi.hoisted(() => ({
  listeners: [] as Array<(event: { phase: string; sessionId: string; messageId: string }) => void>,
}));

vi.mock('../../session/message-dispatcher.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session/message-dispatcher.js')>()),
  onDispatchLifecycle: (listener: (typeof lifecycle.listeners)[number]) => {
    lifecycle.listeners.push(listener);
    return () => undefined;
  },
}));

import { startHeartbeats, stopHeartbeats } from '../heartbeats-wiring.js';
import { wakeAgent } from '../event-wakes.js';
import { isBeatTurn, registerBeatTurn, resetBeatTurns } from '../beat-turns.js';

/** Tell the wiring the setting changed. */
function changed(): void {
  for (const listener of config.listeners)
    listener({ sections: ['heartbeats'], paths: ['heartbeats'] });
}

/** Let the runner's async start and stop settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  config.enabled = false;
  config.listeners = [];
});

afterEach(() => {
  stopHeartbeats();
  resetBeatTurns();
  lifecycle.listeners = [];
  vi.useRealTimers();
});

describe('startHeartbeats', () => {
  it('arms nothing with heartbeats off, follows the switch on, and clears everything off again', async () => {
    const observe = vi.fn(() => () => undefined);
    const handle = startHeartbeats({
      routes: {},
      origins: {},
      db: createTestDb(),
      meshCore: () => undefined,
      rooms: { postFromTool: vi.fn() } as never,
      roomAuthors: { resolveAgent: vi.fn() } as never,
      notifyDm: undefined,
      relay: () => undefined,
      commitments: { observe, list: () => [] } as never,
    });
    await settle();
    expect(vi.getTimerCount()).toBe(0);
    // A promise coming due, or any other source's wake, reaches no hub while
    // off: no coalescing window opens.
    const due = (observe.mock.calls[0] as unknown as [(event: unknown) => void])[0];
    due({ type: 'commitment.due', commitment: { id: 'c1', agentId: 'agent-juno' } });
    wakeAgent('agent-juno', { type: 'room-mention' });
    expect(vi.getTimerCount()).toBe(0);

    config.enabled = true;
    changed();
    await settle();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    expect(handle.runner.armedTimers).toBeGreaterThan(0);

    config.enabled = false;
    changed();
    await settle();
    expect(vi.getTimerCount()).toBe(0);
    expect(handle.runner.armedTimers).toBe(0);
    // Turned off, the hub answers no source either.
    wakeAgent('agent-juno', { type: 'room-mention' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats a turn started by another message in a beat chat as that message's, not the beat's", () => {
    startHeartbeats({
      routes: {},
      origins: {},
      db: createTestDb(),
      meshCore: () => undefined,
      rooms: { postFromTool: vi.fn() } as never,
      roomAuthors: { resolveAgent: vi.fn() } as never,
      notifyDm: undefined,
      relay: () => undefined,
      commitments: { observe: () => () => undefined, list: () => [] } as never,
    });
    registerBeatTurn('beat-chat', { agentId: 'agent-juno', beatId: 'b1', messageId: 'beat-msg' });
    for (const listener of lifecycle.listeners) {
      listener({ phase: 'started', sessionId: 'beat-chat', messageId: 'beat-msg' });
    }
    expect(isBeatTurn('beat-chat')).toBe(true);
    for (const listener of lifecycle.listeners) {
      listener({ phase: 'started', sessionId: 'beat-chat', messageId: 'person-msg' });
    }
    expect(isBeatTurn('beat-chat')).toBe(false);
  });

  it('re-arms only report timers when a person’s hours or away change, never timed beats', async () => {
    config.enabled = true;
    const manifest = { id: 'agent-juno', name: 'juno', runtime: 'claude-code' };
    const handle = startHeartbeats({
      routes: {},
      origins: {},
      db: createTestDb(),
      meshCore: () =>
        ({
          list: () => [manifest],
          get: (id: string) => (id === manifest.id ? manifest : undefined),
          getProjectPath: () => '/agents/juno',
          getByPath: () => manifest,
        }) as never,
      rooms: { postFromTool: vi.fn() } as never,
      roomAuthors: { resolveAgent: vi.fn() } as never,
      notifyDm: undefined,
      relay: () => undefined,
      commitments: { observe: vi.fn(() => () => undefined), list: () => [] } as never,
    });
    await settle();
    const beats = vi.spyOn(handle.runner, 'refreshAgent');
    const reports = vi.spyOn(handle.runner, 'refreshReport');
    for (const listener of config.listeners)
      listener({ sections: ['profile'], paths: ['profile.away'] });
    await settle();
    expect(reports).toHaveBeenCalledWith('agent-juno');
    expect(beats).not.toHaveBeenCalled();
  });
});
