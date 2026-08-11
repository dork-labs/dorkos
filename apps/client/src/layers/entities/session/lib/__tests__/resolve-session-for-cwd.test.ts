/**
 * Clicking an agent opens the conversation you were having with it — not
 * whatever ran there most recently (BC-34, P2 AC-D7).
 *
 * The defect these pin: the resolver took `sessions[0]` from a list that
 * includes every session that ever ran in the directory. `@`-mention an agent in
 * `#team` and its newest session is a room-triggered run — so clicking its row
 * dropped the operator inside a conversation BC-19 then keeps out of Today,
 * leaving them somewhere the sidebar refuses to name.
 *
 * @module entities/session/lib/__tests__/resolve-session-for-cwd
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { Session, SessionOrigin } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';
import { sessionKeys } from '../../api/query-keys';
import { cachedSessionForCwd, resolveSessionForCwd } from '../resolve-session-for-cwd';

const CWD = '/agents/tangerines';

/**
 * A session in the directory, `minutesAgo` old.
 *
 * The list is built newest-first, exactly as the server returns it, so a test
 * that expects the older human session to win is expecting the resolver to look
 * PAST a newer row rather than merely to pick index 0 of a friendlier list.
 */
function session(id: string, minutesAgo: number, origin?: SessionOrigin): Session {
  return {
    id,
    title: id,
    createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    permissionMode: 'default',
    runtime: 'claude-code',
    cwd: CWD,
    ...(origin === undefined ? {} : { origin }),
  };
}

function clientWith(sessions: Session[]): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(sessionKeys.list(CWD), sessions);
  return queryClient;
}

const transport = createMockTransport();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveSessionForCwd', () => {
  it('opens the newest HUMAN conversation, looking past a newer automated run', async () => {
    // The exact reported shape: a room-origin run is the newest thing here.
    const queryClient = clientWith([
      session('room-run', 1, 'room'),
      session('the-conversation', 30),
      session('older-conversation', 90),
    ]);

    const resolved = await resolveSessionForCwd({ queryClient, transport }, CWD);

    expect(resolved).toEqual({ sessionId: 'the-conversation', isNew: false });
  });

  it('looks past every automated origin, not just rooms', async () => {
    for (const origin of ['room', 'task', 'channel', 'agent', 'external'] as const) {
      const queryClient = clientWith([session(`auto-${origin}`, 1, origin), session('mine', 30)]);
      const resolved = await resolveSessionForCwd({ queryClient, transport }, CWD);
      expect({ origin, id: resolved?.sessionId }).toEqual({ origin, id: 'mine' });
    }
  });

  it('treats an unmarked session as the conversation it is', async () => {
    // Absent `origin` means `user` — the unmarked default the whole vocabulary
    // rests on. Reading it as "unknown, skip it" would open a fresh session for
    // every runtime that does not report origins at all.
    const queryClient = clientWith([session('unmarked', 5)]);
    const resolved = await resolveSessionForCwd({ queryClient, transport }, CWD);
    expect(resolved).toEqual({ sessionId: 'unmarked', isNew: false });
  });

  // --- BC-34's else-branch ---

  it('starts a FRESH session for an agent that has only ever run automated work', async () => {
    const queryClient = clientWith([
      session('nightly', 10, 'task'),
      session('telegram', 400, 'channel'),
    ]);

    const resolved = await resolveSessionForCwd({ queryClient, transport }, CWD);

    expect(resolved?.isNew).toBe(true);
    // Emphatically NOT the automated run it looked past.
    expect(resolved?.sessionId).not.toBe('nightly');
    expect(resolved?.sessionId).not.toBe('telegram');
  });

  it('still starts a fresh session for a directory with nothing at all', async () => {
    // The cache holds an empty list, so this asks the server, which answers none.
    transport.listSessions = vi.fn().mockResolvedValue({ sessions: [] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const resolved = await resolveSessionForCwd({ queryClient, transport }, CWD);

    expect(resolved?.isNew).toBe(true);
  });

  it('still says "could not find out" rather than minting when the lookup fails', async () => {
    // The distinction this module exists to keep, re-pinned: the origin filter
    // must not turn an unreachable server into "no conversations, start fresh".
    transport.listSessions = vi.fn().mockRejectedValue(new Error('offline'));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const resolved = await resolveSessionForCwd({ queryClient, transport }, CWD);

    expect(resolved).toBeNull();
  });

  it('asks the server when the cache holds only automated sessions', async () => {
    // A cached list is "believable" when non-empty, and it stays believable here
    // — the filter changes which session is chosen, never whether the cache is
    // trusted. Asking again on every automated-only agent would reintroduce
    // DOR-928's request-per-click.
    const queryClient = clientWith([session('nightly', 10, 'task')]);
    transport.listSessions = vi.fn().mockResolvedValue({ sessions: [] });

    await resolveSessionForCwd({ queryClient, transport }, CWD);

    expect(transport.listSessions).not.toHaveBeenCalled();
  });
});

describe('cachedSessionForCwd', () => {
  it('names the newest conversation, so a row’s href matches its own click', async () => {
    const queryClient = clientWith([session('room-run', 1, 'room'), session('mine', 30)]);
    expect(cachedSessionForCwd(queryClient, CWD)).toBe('mine');
  });

  it('answers null when the cache holds only automated runs', () => {
    // `null` means "not known here" — the caller leaves `?session=` off and lets
    // the loader resolve it, which is the honest answer rather than an href
    // pointing at a run the click would refuse to open.
    const queryClient = clientWith([session('nightly', 10, 'task')]);
    expect(cachedSessionForCwd(queryClient, CWD)).toBeNull();
  });
});
