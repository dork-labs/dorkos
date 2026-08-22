import { describe, it, expect } from 'vitest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { agentAuthorRef, type AuthorRef, type RoomSummary } from '@dorkos/shared/room-schemas';
import { resolveAgentVisual } from '@/layers/shared/lib';
import {
  agentSidebarItem,
  buildSidebarItems,
  lookupSidebarItem,
  lookupSidebarItems,
  roomSidebarItem,
  sidebarItemFaces,
  sidebarItemKey,
} from '../sidebar-item';

const ANA_PATH = '/repo/ana';
const BO_PATH = '/repo/bo';

/**
 * A manifest with NO `icon` and NO `color` — which is what nearly every real
 * agent looks like. Every face assertion below depends on that, because the
 * whole of DOR-582 was a mark that only worked for an agent with a stored emoji.
 */
function manifest(id: string, overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    id,
    name: id,
    description: '',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: '2026-07-01T00:00:00.000Z',
    registeredBy: 'test',
    personaEnabled: true,
    enabledToolGroups: {},
    mcpServers: [],
    ...overrides,
  } as AgentManifest;
}

function author(overrides: Partial<AuthorRef> & Pick<AuthorRef, 'id'>): AuthorRef {
  return { kind: 'agent', displayName: 'Someone', handle: null, ...overrides };
}

function room(overrides: Partial<RoomSummary> & Pick<RoomSummary, 'id' | 'kind'>): RoomSummary {
  return {
    slug: null,
    title: 'Untitled',
    topic: null,
    workspaceId: null,
    archived: false,
    ambientMaxEntries: 30,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActivityAt: '2026-07-20T10:00:00.000Z',
    unreadCount: 0,
    participants: null,
    ...overrides,
  };
}

/** The `agentRef` → path map `roomSidebarItem` matches participants through. */
const PATH_BY_REF = new Map([
  [agentAuthorRef(ANA_PATH), ANA_PATH],
  [agentAuthorRef(BO_PATH), BO_PATH],
]);

const AGENTS: Record<string, AgentManifest> = {
  [ANA_PATH]: manifest('ana-ulid'),
  [BO_PATH]: manifest('bo-ulid'),
};

function agentItem(path: string, overrides: Partial<Parameters<typeof agentSidebarItem>[0]> = {}) {
  return agentSidebarItem({
    path,
    agent: AGENTS[path] ?? null,
    displayName: 'Ana',
    attention: 'active',
    lastActivityAt: undefined,
    muted: false,
    ...overrides,
  });
}

describe('agentSidebarItem', () => {
  it('maps an agent onto the view model', () => {
    const item = agentItem(ANA_PATH, {
      displayName: 'Ana',
      attention: 'needs-attention',
      lastActivityAt: '2026-07-20T12:00:00.000Z',
      muted: true,
    });
    expect(item.ref).toEqual({ kind: 'agent', path: ANA_PATH });
    expect(item.name).toBe('Ana');
    expect(item.lastActiveAt).toBe(Date.parse('2026-07-20T12:00:00.000Z'));
    expect(item.attention).toBe('needs-attention');
    expect(item.muted).toBe(true);
  });

  it('has no last-active instant when the agent has never run a session', () => {
    expect(agentItem(ANA_PATH, { lastActivityAt: undefined }).lastActiveAt).toBeNull();
  });

  it('falls back to the path when the roster has not named the agent', () => {
    expect(agentItem(ANA_PATH, { displayName: undefined }).name).toBe(ANA_PATH);
  });

  it('resolves the face from the manifest id, not from a stored emoji', () => {
    // The manifest carries neither `icon` nor `color`, so a face here can only
    // have come from the client-side hash.
    const item = agentItem(ANA_PATH);
    expect(item.visual).toEqual({
      kind: 'identity',
      visual: resolveAgentVisual(AGENTS[ANA_PATH]!),
    });
    expect(sidebarItemFaces(item.visual)[0]!.emoji).not.toBe('');
  });

  it('hashes the path when the directory has no manifest, matching an unregistered row', () => {
    const item = agentSidebarItem({
      path: '/repo/unregistered',
      agent: null,
      displayName: 'Unregistered',
      attention: 'inactive',
      lastActivityAt: undefined,
      muted: false,
    });
    expect(item.visual).toEqual({
      kind: 'identity',
      visual: resolveAgentVisual({ id: '/repo/unregistered' }),
    });
  });

  // ── Faces never flip (DOR-1143, spec `sidebar-simplification` D6) ──

  it('paints the manifest face on the FIRST model, never the path face first', () => {
    // The two hashes disagree — one hashes the manifest id, the other the
    // directory — which is why every agent's face and name used to change a
    // beat after the panel drew. The panel's boot gate is what makes this
    // possible: no agent row paints before the manifests answer.
    //
    // Red when: the gate stops covering manifests and a row is built with
    // `agent: null` on a directory the roster CAN name.
    const painted = agentItem(ANA_PATH);
    const pathFace = resolveAgentVisual({ id: ANA_PATH });

    expect(sidebarItemFaces(painted.visual)[0]).toEqual(resolveAgentVisual(AGENTS[ANA_PATH]!));
    // …and the two really are different, or the assertion above would hold
    // whether or not the flip was ever fixed.
    expect(sidebarItemFaces(painted.visual)[0]).not.toEqual(pathFace);
  });

  it('keeps a manifest-less directory on its path face across rebuilds', () => {
    // For a directory with no manifest the path hash is not a placeholder, it
    // is the answer — so it must be the same answer every time the model is
    // rebuilt, which is several times a minute on a busy install.
    const first = agentSidebarItem({
      path: '/repo/unregistered',
      agent: null,
      displayName: 'Unregistered',
      attention: 'inactive',
      lastActivityAt: undefined,
      muted: false,
    });
    const later = agentSidebarItem({
      path: '/repo/unregistered',
      agent: undefined,
      displayName: 'Unregistered',
      attention: 'active',
      lastActivityAt: '2026-07-20T12:00:00.000Z',
      muted: true,
    });
    expect(sidebarItemFaces(later.visual)[0]).toEqual(sidebarItemFaces(first.visual)[0]);
  });
});

describe('roomSidebarItem', () => {
  const build = (r: RoomSummary, muted = false) =>
    roomSidebarItem({ room: r, agentsByPath: AGENTS, pathByAgentRef: PATH_BY_REF, muted });

  it('names a channel by its slug and gives it the sigil, never a face', () => {
    const item = build(room({ id: 'c1', kind: 'channel', slug: 'general', title: 'General' }));
    expect(item.name).toBe('#general');
    expect(item.visual).toEqual({ kind: 'sigil' });
    expect(sidebarItemFaces(item.visual)).toEqual([]);
  });

  it("draws a one-to-one DM with the SAME face the agent's own row draws (DOR-582)", () => {
    const dm = build(
      room({
        id: 'dm1',
        kind: 'dm',
        title: 'Ana',
        // No `emoji` and no `color` on the AuthorRef: the server only caches
        // those for an agent that has one stored, which is the exact condition
        // that made this mark a letter.
        participants: [
          author({ id: 'author-you', kind: 'human', displayName: 'You', handle: null }),
          author({ id: 'author-ana', displayName: 'Ana', agentRef: agentAuthorRef(ANA_PATH) }),
        ],
      })
    );
    expect(dm.visual).toEqual(agentItem(ANA_PATH).visual);
  });

  it('stacks every agent in a group conversation, in roster order', () => {
    const dm = build(
      room({
        id: 'dm2',
        kind: 'dm',
        title: 'Ana and Bo',
        participants: [
          author({ id: 'a-ana', displayName: 'Ana', agentRef: agentAuthorRef(ANA_PATH) }),
          author({ id: 'a-you', kind: 'human', displayName: 'You', handle: null }),
          author({ id: 'a-bo', displayName: 'Bo', agentRef: agentAuthorRef(BO_PATH) }),
        ],
      })
    );
    expect(dm.visual).toEqual({
      kind: 'stack',
      visuals: [resolveAgentVisual(AGENTS[ANA_PATH]!), resolveAgentVisual(AGENTS[BO_PATH]!)],
    });
  });

  it('falls back to the room’s own mark when no participant matches the fleet', () => {
    // An agent this cockpit cannot see. Inventing a face for it would be worse
    // than the letter disc, because the face would be confidently wrong.
    const dm = build(
      room({
        id: 'dm3',
        kind: 'dm',
        title: 'Gone',
        participants: [author({ id: 'a-gone', displayName: 'Gone', agentRef: 'deadbeefdeadbeef' })],
      })
    );
    expect(dm.visual).toEqual({ kind: 'sigil' });
  });

  it('falls back to the room’s own mark for a DM with no roster carried', () => {
    expect(build(room({ id: 'dm4', kind: 'dm', title: 'Ana' })).visual).toEqual({ kind: 'sigil' });
  });

  it('asks for attention only when there is something unread', () => {
    const at = (unreadCount: number | null) =>
      build(room({ id: 'c', kind: 'channel', slug: 'x', title: 'x', unreadCount })).attention;
    expect(at(2)).toBe('needs-attention');
    expect(at(0)).toBe('active');
    // `null` means "you are not in this room", which is not zero and is not a
    // reason to badge it.
    expect(at(null)).toBe('active');
  });

  it('is never inactive, so it never falls behind the "N inactive agents" row', () => {
    const long = room({
      id: 'c2',
      kind: 'channel',
      slug: 'quiet',
      title: 'quiet',
      lastActivityAt: '2020-01-01T00:00:00.000Z',
      unreadCount: 0,
    });
    expect(build(long).attention).toBe('active');
  });

  it('reads its last-active instant from lastActivityAt', () => {
    expect(build(room({ id: 'c3', kind: 'channel', slug: 'a', title: 'a' })).lastActiveAt).toBe(
      Date.parse('2026-07-20T10:00:00.000Z')
    );
  });
});

describe('sidebarItemFaces', () => {
  it('flattens each arm of the visual union', () => {
    const one = resolveAgentVisual({ id: 'a' });
    const two = resolveAgentVisual({ id: 'b' });
    expect(sidebarItemFaces({ kind: 'sigil' })).toEqual([]);
    expect(sidebarItemFaces({ kind: 'identity', visual: one })).toEqual([one]);
    expect(sidebarItemFaces({ kind: 'stack', visuals: [one, two] })).toEqual([one, two]);
  });
});

describe('sidebarItemKey', () => {
  it('tells the two kinds apart', () => {
    expect(sidebarItemKey({ kind: 'agent', path: '/a' })).not.toBe(
      sidebarItemKey({ kind: 'room', roomId: '/a' })
    );
  });
});

describe('buildSidebarItems', () => {
  const CHANNEL = room({ id: 'c1', kind: 'channel', slug: 'general', title: 'General' });
  const DM = room({
    id: 'dm1',
    kind: 'dm',
    title: 'Ana',
    participants: [author({ id: 'a1', displayName: 'Ana', agentRef: agentAuthorRef(ANA_PATH) })],
  });

  const index = buildSidebarItems({
    agentPaths: [ANA_PATH, BO_PATH],
    agentsByPath: AGENTS,
    displayNames: { [ANA_PATH]: 'Ana', [BO_PATH]: 'Bo' },
    attention: { [ANA_PATH]: 'needs-attention' },
    agentActivity: { [ANA_PATH]: '2026-07-20T12:00:00.000Z' },
    rooms: [CHANNEL, DM],
    mutedAgentPaths: new Set([BO_PATH]),
    mutedRoomIds: new Set(['c1']),
  });

  it('indexes every agent and every room', () => {
    expect([...index.byAgentPath.keys()]).toEqual([ANA_PATH, BO_PATH]);
    expect([...index.byRoomId.keys()]).toEqual(['c1', 'dm1']);
  });

  it('defaults an agent with no attention entry to inactive', () => {
    expect(index.byAgentPath.get(BO_PATH)!.attention).toBe('inactive');
  });

  it('carries each kind’s own mute list through', () => {
    expect(index.byAgentPath.get(ANA_PATH)!.muted).toBe(false);
    expect(index.byAgentPath.get(BO_PATH)!.muted).toBe(true);
    expect(index.byRoomId.get('c1')!.muted).toBe(true);
    expect(index.byRoomId.get('dm1')!.muted).toBe(false);
  });

  it('resolves a DM’s face against the fleet it was built with', () => {
    expect(index.byRoomId.get('dm1')!.visual).toEqual({
      kind: 'identity',
      visual: resolveAgentVisual(AGENTS[ANA_PATH]!),
    });
  });

  it('resolves one reference at a time, answering null for anything unknown', () => {
    expect(lookupSidebarItem(index, { kind: 'agent', path: ANA_PATH })?.name).toBe('Ana');
    expect(lookupSidebarItem(index, { kind: 'room', roomId: 'c1' })?.name).toBe('#general');
    expect(lookupSidebarItem(index, { kind: 'agent', path: '/gone' })).toBeNull();
    expect(lookupSidebarItem(index, { kind: 'room', roomId: 'gone' })).toBeNull();
  });

  it('resolves a membership list in order, dropping stale references without reordering', () => {
    const items = lookupSidebarItems(index, [
      { kind: 'agent', path: BO_PATH },
      { kind: 'room', roomId: 'gone' },
      { kind: 'room', roomId: 'c1' },
      { kind: 'agent', path: '/gone' },
      { kind: 'agent', path: ANA_PATH },
    ]);
    expect(items.map((i) => i.name)).toEqual(['Bo', '#general', 'Ana']);
  });
});
