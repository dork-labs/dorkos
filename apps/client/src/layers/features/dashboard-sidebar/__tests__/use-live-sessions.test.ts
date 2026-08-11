// @vitest-environment jsdom
/**
 * The chip and the switcher must count the same sessions.
 *
 * These are the two rules of "live" — a lifecycle in flight, and a human
 * origin — checked against the real store, plus the agreement test that would
 * have caught the defect that shipped: the chip counted every live session
 * matching an agent's `cwd`, while the switcher's "Live now" group was built
 * from `partitionSessionsByOrigin(...).conversations`. Two scheduled tasks
 * therefore drew a green "2 live" over a dialog with no Live-now group at all.
 *
 * @module features/dashboard-sidebar/__tests__/use-live-sessions
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Session, SessionOrigin } from '@dorkos/shared/types';
import type { SessionStatus } from '@dorkos/shared/session-stream';
import { partitionSessionsByOrigin, useSessionListStore } from '@/layers/entities/session';
import { isLiveLifecycle, useLiveSessionCount } from '../model/use-live-sessions';

const AGENT = '/agents/dorkos';
const OTHER = '/agents/somebody-else';

function status(lifecycle: SessionStatus['lifecycle']): SessionStatus {
  return {
    contextUsage: null,
    cost: null,
    usage: null,
    cacheStats: null,
    model: null,
    permissionMode: 'default',
    todoCounts: null,
    runningSubagentCount: 0,
    lifecycle,
    lastError: null,
  };
}

function session(id: string, origin?: SessionOrigin, cwd = AGENT): Session {
  return {
    id,
    title: id,
    createdAt: '2026-08-09T10:00:00.000Z',
    updatedAt: '2026-08-09T10:00:00.000Z',
    permissionMode: 'default',
    runtime: 'claude-code',
    cwd,
    ...(origin === undefined ? {} : { origin }),
  };
}

/** Put a session in the store with metadata, a status and a cwd. */
function seed(s: Session, lifecycle: SessionStatus['lifecycle']): void {
  const store = useSessionListStore.getState();
  store.upsertSession(s);
  store.setSessionStatus(s.id, status(lifecycle), s.cwd);
}

function count(agentPath = AGENT): number {
  return renderHook(() => useLiveSessionCount(agentPath)).result.current;
}

beforeEach(() => {
  useSessionListStore.setState({ sessions: {}, statuses: {}, statusCwds: {}, unseen: {} });
});

describe('useLiveSessionCount', () => {
  it('counts a streaming and a blocked conversation', () => {
    seed(session('a'), 'streaming');
    seed(session('b', 'user'), 'blocked');
    expect(count()).toBe(2);
  });

  it('ignores settled conversations', () => {
    seed(session('a'), 'streaming');
    seed(session('b'), 'error');
    seed(session('c'), 'interrupted');
    expect(count()).toBe(1);
  });

  it('ignores another agent’s live work', () => {
    seed(session('a'), 'streaming');
    seed(session('mine-not', undefined, OTHER), 'streaming');
    expect(count()).toBe(1);
  });

  // --- The rule design-decisions §18 locks: automation raises no badge ---

  it('counts no automated session, whatever its origin', () => {
    for (const origin of ['task', 'channel', 'room', 'agent', 'external'] as const) {
      useSessionListStore.setState({ sessions: {}, statuses: {}, statusCwds: {}, unseen: {} });
      seed(session(`auto-${origin}`, origin), 'streaming');
      expect({ origin, count: count() }).toEqual({ origin, count: 0 });
    }
  });

  it('the reported scenario: two live scheduled tasks and no conversation draw no chip', () => {
    seed(session('nightly-1', 'task'), 'streaming');
    seed(session('nightly-2', 'task'), 'streaming');
    expect(count()).toBe(0);
  });

  it('does not count a live session whose metadata has not arrived', () => {
    // Status and cwd, but no `session_upserted` yet — origin is unknowable, and
    // guessing "conversation" is how automation would sneak a badge through.
    useSessionListStore.getState().setSessionStatus('ghost', status('streaming'), AGENT);
    expect(count()).toBe(0);
  });

  // --- The anti-drift guard ---

  it('agrees with the switcher’s Live-now grouping on the same store state', () => {
    const sessions = [
      session('human-live'),
      session('human-user-live', 'user'),
      session('human-idle'),
      session('task-live', 'task'),
      session('channel-live', 'channel'),
      session('room-live', 'room'),
    ];
    const live = new Set([
      'human-live',
      'human-user-live',
      'task-live',
      'channel-live',
      'room-live',
    ]);
    for (const s of sessions) seed(s, live.has(s.id) ? 'streaming' : 'idle');

    // Exactly what `SessionSwitcher` does to fill its "Live now" group.
    const { conversations } = partitionSessionsByOrigin(sessions);
    const switcherLiveRows = conversations.filter((s) =>
      isLiveLifecycle(useSessionListStore.getState().statuses[s.id]?.lifecycle)
    ).length;

    expect(switcherLiveRows).toBe(2);
    expect(count()).toBe(switcherLiveRows);
  });
});
