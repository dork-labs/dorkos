/**
 * Event wakes (spec `heartbeats` §3.3): coalescing, failures once a day, the
 * hub doing nothing until installed, and two of the hooked sources.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventWakes, WAKE_COALESCE_MS, wakeAgent, wakeAgentAt } from '../event-wakes.js';
import type { BeatWake } from '../beat-runner.js';
import { systemClock } from '../beat-scheduler.js';
import { createRunTerminalListener } from '../../tasks/run-terminal-broadcaster.js';

vi.mock('../../notifications/emitters/run-completed.js', () => ({
  notifyRunCompleted: vi.fn(async () => undefined),
}));

let beats: Array<{ agentId: string; wake: BeatWake }>;
let newManagers: string[];
let day: string;
let hub: EventWakes;

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-10-12T14:00:00Z') });
  beats = [];
  newManagers = [];
  day = '2026-10-12';
  hub = new EventWakes({
    clock: systemClock,
    localDay: () => day,
    beat: (agentId, wake) => beats.push({ agentId, wake }),
    agentIdAt: (path) => (path === '/agents/juno' ? 'agent-juno' : undefined),
    agentsForConnection: (id) => (id === 'conn-1' ? ['agent-juno', 'agent-otto'] : []),
    noteNewManager: (agentId) => newManagers.push(agentId),
    refresh: () => undefined,
  });
  hub.install();
});

afterEach(() => {
  hub.uninstall();
  vi.useRealTimers();
});

describe('coalescing', () => {
  it('turns events for one agent within a minute into one beat, woken by the first', () => {
    wakeAgent('agent-juno', { type: 'room-mention', eventId: 'e1' });
    vi.advanceTimersByTime(30_000);
    wakeAgent('agent-juno', { type: 'commitment-due', eventId: 'c1' });
    expect(beats).toEqual([]);
    vi.advanceTimersByTime(WAKE_COALESCE_MS);
    expect(beats).toEqual([
      { agentId: 'agent-juno', wake: { wake: 'event:room-mention', causedBy: 'e1' } },
    ]);
    wakeAgent('agent-juno', { type: 'room-mention', eventId: 'e2' });
    vi.advanceTimersByTime(WAKE_COALESCE_MS);
    expect(beats).toHaveLength(2);
  });
});

describe('failure sources', () => {
  it('wake an agent at most once per source per local day', () => {
    for (let hour = 0; hour < 5; hour += 1) {
      wakeAgent('agent-juno', { type: 'run-failed', eventId: `run-${hour}`, source: 'sched-1' });
      vi.advanceTimersByTime(60 * 60_000);
    }
    expect(beats).toHaveLength(1);
    wakeAgent('agent-juno', { type: 'run-failed', eventId: 'other', source: 'sched-2' });
    vi.advanceTimersByTime(WAKE_COALESCE_MS);
    expect(beats).toHaveLength(2);
    day = '2026-10-13';
    wakeAgent('agent-juno', { type: 'run-failed', eventId: 'next-day', source: 'sched-1' });
    vi.advanceTimersByTime(WAKE_COALESCE_MS);
    expect(beats).toHaveLength(3);
  });

  it('wakes every agent a connection that lost access serves', () => {
    hub.connectionLost('conn-1');
    vi.advanceTimersByTime(WAKE_COALESCE_MS);
    expect(beats.map((b) => b.agentId).sort()).toEqual(['agent-juno', 'agent-otto']);
  });
});

describe('the hub', () => {
  it('resolves an agent by its home directory, and ignores one it does not know', () => {
    wakeAgentAt('/agents/juno', { type: 'room-mention' });
    wakeAgentAt('/agents/stranger', { type: 'room-mention' });
    vi.advanceTimersByTime(WAKE_COALESCE_MS);
    expect(beats.map((b) => b.agentId)).toEqual(['agent-juno']);
  });

  it('notes a new manager when reports-to changes', () => {
    wakeAgent('agent-juno', { type: 'reports-to-changed' });
    expect(newManagers).toEqual(['agent-juno']);
  });

  it('does nothing, and leaves no timer, once uninstalled', () => {
    wakeAgent('agent-juno', { type: 'room-mention' });
    hub.uninstall();
    expect(vi.getTimerCount()).toBe(0);
    wakeAgent('agent-juno', { type: 'room-mention' });
    vi.advanceTimersByTime(WAKE_COALESCE_MS);
    expect(beats).toEqual([]);
  });
});

describe('the task scheduler hook', () => {
  it('wakes the owning agent for a failed or parked run, and not for a completed one', () => {
    const listener = createRunTerminalListener(null);
    const task = { id: 'sched-1', agentId: 'agent-juno' } as never;
    listener({ id: 'run-ok', status: 'completed', scheduleId: 'sched-1' } as never, task);
    listener({ id: 'run-bad', status: 'failed', scheduleId: 'sched-1' } as never, task);
    vi.advanceTimersByTime(WAKE_COALESCE_MS);
    expect(beats).toEqual([
      { agentId: 'agent-juno', wake: { wake: 'event:run-failed', causedBy: 'run-bad' } },
    ]);
  });
});
