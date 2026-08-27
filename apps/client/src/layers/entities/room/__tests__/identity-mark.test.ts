/**
 * The one mark derivation every surface that draws a room now shares.
 *
 * These rules used to live in the sidebar's item view model and were asserted
 * there; they moved when a second surface needed them, and the assertions moved
 * with them. The claim that matters most is the first one: a direct message
 * draws its agent's real face, resolved from the manifest, and never the letter
 * disc that DOR-582 was filed for.
 */
import { describe, it, expect } from 'vitest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { agentAuthorRef, type AuthorRef, type RoomSummary } from '@dorkos/shared/room-schemas';
import { resolveAgentVisual } from '@/layers/shared/lib';
import { identityMarkFaces, roomIdentityMark } from '../lib/identity-mark';

const AGENT_PATH = '/code/api';

const manifest = (overrides: Partial<AgentManifest> = {}): AgentManifest =>
  ({
    id: 'agent-ulid-1',
    name: 'reviewer',
    projectPath: AGENT_PATH,
    icon: '🔍',
    color: '#6366f1',
    ...overrides,
  }) as AgentManifest;

const participant = (agentRef: string): AuthorRef =>
  ({ id: `author-${agentRef}`, kind: 'agent', displayName: 'reviewer', agentRef }) as AuthorRef;

const room = (overrides: Partial<RoomSummary> & Pick<RoomSummary, 'kind'>): RoomSummary => ({
  id: 'r1',
  slug: null,
  title: 'reviewer',
  topic: null,
  archived: false,
  ambientMaxEntries: 30,
  createdAt: '2026-07-01T00:00:00.000Z',
  lastActivityAt: '2026-08-01T10:00:00.000Z',
  unreadCount: 0,
  participants: null,
  ...overrides,
});

/** The fleet as every caller holds it: manifests by path, plus the ref index. */
function fleet(paths: string[], agents: Record<string, AgentManifest | null> = {}) {
  return {
    agentsByPath: agents,
    pathByAgentRef: new Map(paths.map((path) => [agentAuthorRef(path), path])),
  };
}

describe('roomIdentityMark', () => {
  it('draws a direct message with its agent’s own face, not a letter (DOR-582)', () => {
    const mark = roomIdentityMark({
      room: room({ kind: 'dm', participants: [participant(agentAuthorRef(AGENT_PATH))] }),
      ...fleet([AGENT_PATH], { [AGENT_PATH]: manifest() }),
    });

    expect(mark).toEqual({ kind: 'identity', visual: resolveAgentVisual(manifest()) });
    expect(identityMarkFaces(mark)[0]?.emoji).toBe('🔍');
  });

  it('falls back to the path hash for a directory with no manifest — the same face its own row draws', () => {
    const mark = roomIdentityMark({
      room: room({ kind: 'dm', participants: [participant(agentAuthorRef(AGENT_PATH))] }),
      ...fleet([AGENT_PATH], { [AGENT_PATH]: null }),
    });

    expect(mark).toEqual({ kind: 'identity', visual: resolveAgentVisual({ id: AGENT_PATH }) });
  });

  it('stacks the faces of a group conversation', () => {
    const other = '/code/web';
    const mark = roomIdentityMark({
      room: room({
        kind: 'dm',
        participants: [participant(agentAuthorRef(AGENT_PATH)), participant(agentAuthorRef(other))],
      }),
      ...fleet([AGENT_PATH, other], { [AGENT_PATH]: manifest(), [other]: null }),
    });

    expect(mark.kind).toBe('stack');
    expect(identityMarkFaces(mark)).toHaveLength(2);
  });

  it('gives a channel its own sigil, whoever is in it', () => {
    const mark = roomIdentityMark({
      room: room({ kind: 'channel', participants: [participant(agentAuthorRef(AGENT_PATH))] }),
      ...fleet([AGENT_PATH], { [AGENT_PATH]: manifest() }),
    });

    expect(mark).toEqual({ kind: 'sigil' });
    expect(identityMarkFaces(mark)).toEqual([]);
  });

  it('claims nothing for an agent this cockpit cannot see', () => {
    // Removed, or on another machine: there is no manifest to hash, and hashing
    // anything else would invent a face.
    const mark = roomIdentityMark({
      room: room({ kind: 'dm', participants: [participant('agent-from-elsewhere')] }),
      ...fleet([AGENT_PATH], { [AGENT_PATH]: manifest() }),
    });

    expect(mark).toEqual({ kind: 'sigil' });
  });

  it('ignores people and a roster it was never given', () => {
    const withPerson = roomIdentityMark({
      room: room({
        kind: 'dm',
        participants: [
          { id: 'author-me', kind: 'human', displayName: 'Kai', handle: 'kai' } as AuthorRef,
        ],
      }),
      ...fleet([AGENT_PATH]),
    });
    const withNoRoster = roomIdentityMark({
      room: room({ kind: 'dm', participants: null }),
      ...fleet([AGENT_PATH]),
    });

    expect(withPerson).toEqual({ kind: 'sigil' });
    expect(withNoRoster).toEqual({ kind: 'sigil' });
  });
});
