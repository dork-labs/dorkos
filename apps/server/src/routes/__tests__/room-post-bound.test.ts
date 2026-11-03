/**
 * A person's message into a Direct chat that doesn't prove the owner (DOR-3088, Security's G2):
 * held to the stranger's bound only on an install with an owner account, never for an agent, and
 * the same through a room post and a message sent straight to the chat's session.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ login: false, ownerId: 'user_owner' as string | null }));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn((key: string) => (key === 'auth' ? { enabled: state.login } : undefined)),
  },
}));
vi.mock('../../services/core/auth/index.js', () => ({
  readOwnerAccount: () => (state.ownerId ? { id: state.ownerId } : null),
  hasAnyUser: () => state.ownerId !== null,
}));
const flag = vi.hoisted(() => ({ todos: true }));
vi.mock('../../env.js', async (importOriginal) => {
  const actual = await importOriginal<{ env: Record<string, unknown> }>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (target, key) => (key === 'DORKOS_TODOS_ENABLED' ? flag.todos : target[key as string]),
    }),
  };
});
const chats = vi.hoisted(() => ({ direct: new Set<string>() }));
vi.mock('../../services/rooms/direct-chat/index.js', () => ({
  getDirectChats: () => ({
    forSession: (id: string) =>
      chats.direct.has(id) ? { roomId: 'room-dm', sessionId: id } : null,
  }),
}));

import type { RequestUser } from '../../services/core/auth/session-gate.js';
import { requestFactsFor } from '../../http/__tests__/described-request.js';
import { personTurnBound, roomPostBound } from '../room-post-bound.js';
import { httpLaunchOf } from '../session-launcher.js';

const OWNER_COOKIE: RequestUser = { userId: 'user_owner', credential: 'cookie' };
const hasOwner = () => state.ownerId !== null;

/** A request from this computer. */
function here(described: Parameters<typeof requestFactsFor>[0] = {}) {
  return requestFactsFor({
    ...described,
    headers: { host: 'localhost:4242', ...described.headers },
  });
}

afterEach(() => {
  state.login = false;
  state.ownerId = 'user_owner';
  chats.direct.clear();
  flag.todos = true;
});

describe('roomPostBound', () => {
  it("holds an unproven post into a Direct chat when an owner exists, and not the owner's own", async () => {
    expect(roomPostBound(await here(), 'dm', 'person', hasOwner)).toBe('runtime-default');
    expect(roomPostBound(await here({ user: OWNER_COOKIE }), 'dm', 'person', hasOwner)).toBe(
      undefined
    );
  });

  it('leaves Direct chats as they were on an install with no owner account', async () => {
    state.ownerId = null;
    expect(roomPostBound(await here(), 'dm', 'person', hasOwner)).toBe(undefined);
  });

  it('changes nothing while to-dos are off, since no to-do runs in a Direct chat then', async () => {
    flag.todos = false;
    expect(roomPostBound(await here(), 'dm', 'person', hasOwner)).toBe(undefined);
    chats.direct.add('session-dm');
    expect(httpLaunchOf(await here(), 'session-dm').permissionCeiling).toBeUndefined();
  });

  it("never binds an agent's own replies, or a post into a channel", async () => {
    expect(roomPostBound(await here(), 'dm', 'agent', hasOwner)).toBe(undefined);
    expect(roomPostBound(await here(), 'channel', 'person', hasOwner)).toBe(undefined);
  });
});

describe("a message straight to a Direct chat's session", () => {
  it('is held the same way the room post is, and only in a Direct chat', async () => {
    chats.direct.add('session-dm');
    expect(httpLaunchOf(await here(), 'session-dm').permissionCeiling).toBe('runtime-default');
    expect(httpLaunchOf(await here(), 'session-other').permissionCeiling).toBeUndefined();
    expect(
      httpLaunchOf(await here({ user: OWNER_COOKIE }), 'session-dm').permissionCeiling
    ).toBeUndefined();
    state.ownerId = null;
    expect(httpLaunchOf(await here(), 'session-dm').permissionCeiling).toBeUndefined();
  });
});

describe("a mini app's forward and a widget's action (H1 of the review)", () => {
  it('hold an unproven caller in a Direct chat, and leave the owner and other chats alone', async () => {
    expect(personTurnBound(await here(), true)).toBe('runtime-default');
    expect(personTurnBound(await here({ user: OWNER_COOKIE }), true)).toBe(undefined);
    expect(personTurnBound(await here(), false)).toBe(undefined);
    flag.todos = false;
    expect(personTurnBound(await here(), true)).toBe(undefined);
  });
});
