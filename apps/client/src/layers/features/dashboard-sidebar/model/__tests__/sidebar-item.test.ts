import { describe, it, expect } from 'vitest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { agentAuthorRef, type AuthorRef, type RoomSummary } from '@dorkos/shared/room-schemas';
import { resolveAgentVisual } from '@/layers/shared/lib';
import { buildRoomVisualIndex, sidebarItemFaces, sidebarItemKey } from '../sidebar-item';

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
    archived: false,
    ambientMaxEntries: 30,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActivityAt: '2026-07-20T10:00:00.000Z',
    unreadCount: 0,
    participants: null,
    ...overrides,
  };
}

const AGENTS: Record<string, AgentManifest> = {
  [ANA_PATH]: manifest('ana-ulid'),
  [BO_PATH]: manifest('bo-ulid'),
};

/** The index as the panel builds it: the whole fleet, then the rooms. */
function index(rooms: RoomSummary[]) {
  return buildRoomVisualIndex({
    agentPaths: [ANA_PATH, BO_PATH],
    agentsByPath: AGENTS,
    rooms,
  });
}

/** One room's mark. */
function markOf(r: RoomSummary) {
  return index([r]).get(r.id);
}

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

describe('buildRoomVisualIndex', () => {
  const CHANNEL = room({ id: 'c1', kind: 'channel', slug: 'general', title: 'General' });
  const DM = room({
    id: 'dm1',
    kind: 'dm',
    title: 'Ana',
    participants: [author({ id: 'a1', displayName: 'Ana', agentRef: agentAuthorRef(ANA_PATH) })],
  });

  it('indexes every room it was given, and nothing else', () => {
    // Red when: the index grows an agent half again — the fleet walk that
    // resolved a face per agent and was never read (D8).
    expect([...index([CHANNEL, DM]).keys()]).toEqual(['c1', 'dm1']);
  });

  it('gives a channel the sigil, never a face', () => {
    expect(markOf(CHANNEL)).toEqual({ kind: 'sigil' });
    expect(sidebarItemFaces(markOf(CHANNEL)!)).toEqual([]);
  });

  it("draws a one-to-one DM with the SAME face the agent's own row draws (DOR-582)", () => {
    // No `emoji` and no `color` on the AuthorRef: the server only caches those
    // for an agent that has one stored, which is the exact condition that made
    // this mark a letter.
    expect(markOf(DM)).toEqual({ kind: 'identity', visual: resolveAgentVisual(AGENTS[ANA_PATH]!) });
  });

  it('stacks every agent in a group conversation, in roster order', () => {
    const group = room({
      id: 'dm2',
      kind: 'dm',
      title: 'Ana and Bo',
      participants: [
        author({ id: 'a-ana', displayName: 'Ana', agentRef: agentAuthorRef(ANA_PATH) }),
        author({ id: 'a-you', kind: 'human', displayName: 'You', handle: null }),
        author({ id: 'a-bo', displayName: 'Bo', agentRef: agentAuthorRef(BO_PATH) }),
      ],
    });
    expect(markOf(group)).toEqual({
      kind: 'stack',
      visuals: [resolveAgentVisual(AGENTS[ANA_PATH]!), resolveAgentVisual(AGENTS[BO_PATH]!)],
    });
  });

  it('falls back to the room’s own mark when no participant matches the fleet', () => {
    // An agent this cockpit cannot see. Inventing a face for it would be worse
    // than the letter disc, because the face would be confidently wrong.
    const gone = room({
      id: 'dm3',
      kind: 'dm',
      title: 'Gone',
      participants: [author({ id: 'a-gone', displayName: 'Gone', agentRef: 'deadbeefdeadbeef' })],
    });
    expect(markOf(gone)).toEqual({ kind: 'sigil' });
  });

  it('falls back to the room’s own mark for a DM with no roster carried', () => {
    expect(markOf(room({ id: 'dm4', kind: 'dm', title: 'Ana' }))).toEqual({ kind: 'sigil' });
  });

  it('answers nothing for a room it does not hold', () => {
    expect(index([CHANNEL]).get('dm1')).toBeUndefined();
  });
});
