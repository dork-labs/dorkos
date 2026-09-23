import { expect, type Page, type Route } from '@playwright/test';

/**
 * Mocked Communities for the switcher's browser proofs (DOR-2186; spec
 * `specs/community-switcher-navigation`, tasks 4.1 and 4.2).
 *
 * Every Community is mocked at the local server's API, because the browser
 * never talks to a Community host directly. Every Community uses the SAME room
 * id (`general`), so only the Community ref and the app's fences keep their
 * messages apart. Responses can be held open to put reads and streams in flight
 * across a switch, then released in the worst order.
 *
 * @module e2e/tests/connections/community-mocks
 */

/** The one room id every mocked Community shares. */
export const ROOM = 'general';
/** Message text that must only ever be painted under its own Community. */
export const secret = (label: string) => `${label} private note`;

/** One mocked Community connection: its ref, name, reachability and attention counts. */
export interface CommunitySpec {
  ref: string;
  label: string;
  /** `verified` is online; `unverified` is offline. */
  access?: 'verified' | 'unverified';
  status?: 'connected' | 'reconnect-required';
  unread?: number;
  mentions?: number;
}

function capabilities(on: boolean) {
  return { read: on, post: on, enrollAgent: false, stream: on };
}

function descriptor(community: CommunitySpec) {
  const online = (community.access ?? 'verified') === 'verified';
  return {
    ref: community.ref,
    remoteCommunityId: `remote-${community.ref}`,
    label: community.label,
    pinnedOrigin: `https://${community.ref}.example.test`,
    connectedHumanMemberId: `person-${community.ref}`,
    status: community.status ?? 'connected',
    expiresAt: null,
    access: {
      state: community.access ?? 'verified',
      effective: capabilities(online),
      lastKnown: {
        lifecycle: 'active',
        capabilities: capabilities(true),
        verifiedAt: '2026-09-23T12:00:00.000Z',
      },
    },
    attention:
      community.unread === undefined
        ? { state: 'unavailable', unreadCount: null, mentionCount: null, verifiedAt: null }
        : {
            state: 'verified',
            unreadCount: community.unread,
            mentionCount: community.mentions ?? 0,
            verifiedAt: '2026-09-23T12:00:00.000Z',
          },
  };
}

function room(community: CommunitySpec) {
  const capability = capabilities(true);
  return {
    community: community.ref,
    roomId: ROOM,
    remoteCommunityId: `remote-${community.ref}`,
    kind: 'channel',
    title: 'General',
    slug: 'general',
    topic: null,
    archived: false,
    createdAt: '2026-09-23T12:00:00.000Z',
    lastActivityAt: '2026-09-23T12:00:00.000Z',
    unreadCount: 0,
    visibility: 'public',
    readable: true,
    writable: true,
    joined: true,
    stale: false,
    cacheCursor: null,
    lastRemoteSeq: 1,
    access: {
      state: 'verified',
      effective: capability,
      lastKnown: {
        lifecycle: 'active',
        capabilities: capability,
        verifiedAt: '2026-09-23T12:00:00.000Z',
      },
    },
  };
}

function entries(community: CommunitySpec) {
  return {
    community: community.ref,
    roomId: ROOM,
    entries: [
      {
        community: community.ref,
        roomId: ROOM,
        id: 'entry-1',
        authorId: `person-${community.ref}`,
        authorDisplayName: 'Alex',
        authorKind: 'human',
        text: secret(community.label),
        mentions: [],
        parentEntryId: null,
        threadRootEntryId: null,
        depth: 0,
        cursor: `cursor-${community.ref}-1`,
        createdAt: '2026-09-23T12:00:00.000Z',
        remoteSeq: 1,
        attachments: [],
      },
    ],
    nextCursor: null,
    lastRemoteSeq: 1,
    stale: false,
  };
}

/** A response the test is holding open, and the way to let it go. */
export interface Held {
  ref: string;
  kind: 'entries' | 'destination';
  release: () => void;
}

/** Everything a test can steer or inspect about the mocked Communities. */
export interface CommunityMock {
  /** Refs whose next `entries` / `destination` responses are held open. */
  holdEntries: Set<string>;
  holdDestination: Set<string>;
  /** Refs whose destination lookup fails instead of answering. */
  failDestination: Set<string>;
  held: Held[];
  /** Every Community content request the page made, in order. */
  requests: { ref: string; path: string; at: number }[];
}

/**
 * Ask the real server for this owner's key, so a failed owner check still
 * fails the test. `null` when the page abandoned the request first (a later
 * navigation cancels it mid-answer); that is the page's choice, not a failure.
 *
 * @param route - The intercepted navigation request.
 * @param label - Names the request in a failed status assertion.
 */
export async function realOwnerKey(route: Route, label: string): Promise<string | null> {
  const real = await route.fetch().catch(() => null);
  if (!real) {
    await route.abort().catch(() => {});
    return null;
  }
  expect(real.status(), label).toBe(200);
  const body = (await real.json().catch(() => null)) as { ownerKey: string } | null;
  if (!body) await route.abort().catch(() => {});
  return body?.ownerKey ?? null;
}

/**
 * Serve a set of Communities from the local API, the way the local server
 * would after pairing. Navigation calls still reach the real server first so
 * the owner key is the real one; the answer is then this owner's saved state.
 */
export async function mockCommunities(
  page: Page,
  communities: CommunitySpec[]
): Promise<CommunityMock> {
  const byRef = new Map(communities.map((community) => [community.ref, community]));
  const mock: CommunityMock = {
    holdEntries: new Set(),
    holdDestination: new Set(),
    failDestination: new Set(),
    held: [],
    requests: [],
  };
  const hold = (ref: string, kind: Held['kind']) =>
    new Promise<void>((release) => mock.held.push({ ref, kind, release }));
  const navigationState = (ownerKey: string) => ({
    ownerKey,
    installationDestination: { path: '/', search: {} },
    order: communities.map((community) => community.ref),
    destinations: [],
  });

  await page.route('**/api/community-connections**', async (route) => {
    const method = route.request().method();
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/community-connections' && method === 'GET') {
      await route.fulfill({ json: { connections: communities.map(descriptor) } });
      return;
    }
    const destination = /^\/api\/community-connections\/navigation\/([^/]+)\/destination$/.exec(
      path
    );
    if (destination) {
      const ref = decodeURIComponent(destination[1]!);
      if (mock.failDestination.has(ref)) {
        await route.fulfill({ status: 503, json: { error: 'Community unavailable' } });
        return;
      }
      if (mock.holdDestination.has(ref)) await hold(ref, 'destination');
      await route
        .fulfill({
          json: { destination: { ref, roomId: ROOM, threadId: null, scrollAnchorEntryId: null } },
        })
        .catch(() => {});
      return;
    }
    if (path.startsWith('/api/community-connections/navigation')) {
      const ownerKey = await realOwnerKey(route, `${method} ${path}`);
      if (ownerKey) await route.fulfill({ json: navigationState(ownerKey) }).catch(() => {});
      return;
    }
    await route.fallback();
  });

  await page.route('**/api/communities/**', async (route) => {
    const url = new URL(route.request().url());
    const match = /^\/api\/communities\/([^/]+)(\/.*)?$/.exec(url.pathname);
    const community = match ? byRef.get(decodeURIComponent(match[1]!)) : undefined;
    if (!community) return route.fallback();
    const rest = match![2] ?? '';
    mock.requests.push({ ref: community.ref, path: rest, at: Date.now() });
    if (rest === '/rooms')
      return route.fulfill({
        json: { community: community.ref, rooms: [room(community)], stale: false },
      });
    if (rest === `/rooms/${ROOM}`) return route.fulfill({ json: { room: room(community) } });
    if (rest === `/rooms/${ROOM}/entries`) {
      if (mock.holdEntries.has(community.ref)) await hold(community.ref, 'entries');
      await route.fulfill({ json: entries(community) }).catch(() => {});
      return;
    }
    if (rest === `/rooms/${ROOM}/members`)
      return route.fulfill({
        json: { community: community.ref, roomId: ROOM, members: [], stale: false },
      });
    if (rest === '/agents') return route.fulfill({ json: { agents: [] } });
    if (rest === `/rooms/${ROOM}/events`) {
      // An open stream the test never answers: it stays in flight until the
      // app closes it, which `requestfailed` records below.
      return;
    }
    return route.fallback();
  });

  return mock;
}

/** Release every held response, in the order given by `order` (default: newest first). */
export async function releaseHeld(
  mock: CommunityMock,
  order: 'newest-first' | 'oldest-first' = 'newest-first'
) {
  const held = mock.held.splice(0);
  for (const item of order === 'newest-first' ? held.reverse() : held) item.release();
}

/** A Community with one direct mention and one other unread message. */
export const ALPHA: CommunitySpec = { ref: 'alpha', label: 'Alpha', unread: 2, mentions: 1 };
/** A quiet, online Community. */
export const BETA: CommunitySpec = { ref: 'beta', label: 'Beta' };
