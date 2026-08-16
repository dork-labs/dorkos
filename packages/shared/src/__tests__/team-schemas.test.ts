/**
 * The team roster payload's shape (spec `identity-consistency` §W2.2, ADR
 * 260806-222535).
 *
 * Two of these assertions are the point of the file rather than coverage:
 * `ownerId` is REQUIRED and nullable, and `warnings` is absent on a clean read.
 * A schema that lets `ownerId` be omitted is how "every agent shows who it
 * belongs to" quietly becomes "most agents do", and an envelope that tolerates
 * `warnings: []` is how a client learns to render an empty degradation banner.
 */
import { describe, it, expect } from 'vitest';
import {
  TeamMemberSchema,
  TeamRosterResponseSchema,
  TeamSourceWarningSchema,
} from '../team-schemas.js';

/** A person row with every optional field present. */
const FULL_PERSON = {
  id: 'author-1',
  kind: 'human',
  displayName: 'Dorian',
  handle: 'dorian',
  emoji: '🧑',
  color: '#6366f1',
  imageUrl: '/api/team/avatars/author-1.png',
  isSelf: true,
  ownerId: null,
  origin: 'local',
  person: { role: 'owner', email: 'dorian@dorkos.ai', lastSeenAt: '2026-08-16T10:00:00.000Z' },
};

/** An agent row with every optional field present. */
const FULL_AGENT = {
  id: 'agent-1',
  kind: 'agent',
  displayName: 'Ana',
  handle: 'ana',
  emoji: '🤖',
  color: '#22c55e',
  isSelf: false,
  ownerId: 'author-1',
  origin: 'local',
  agent: {
    manifestId: 'agent-1',
    runtime: 'claude-code',
    model: 'opus',
    healthStatus: 'active',
    recentlyActive: true,
    namespace: 'dorkos',
    projectPath: '/Users/dorian/agents/ana',
    activity: {
      working: { roomId: 'room-1', roomName: 'team', since: '2026-08-16T09:55:00.000Z' },
      lastActiveAt: '2026-08-16T09:55:00.000Z',
    },
    isDefault: false,
    isSystem: false,
    registeredAt: '2026-08-06T00:00:00.000Z',
  },
};

/** The smallest row the schema accepts: nothing optional, nothing inferred. */
const MINIMAL_MEMBER = {
  id: 'author-1',
  kind: 'human',
  displayName: 'Someone',
  handle: null,
  isSelf: false,
  ownerId: null,
  origin: 'local',
};

describe('TeamMemberSchema', () => {
  it('parses a full person row, keeping the self-only email', () => {
    const parsed = TeamMemberSchema.parse(FULL_PERSON);
    expect(parsed.person?.email).toBe('dorian@dorkos.ai');
    expect(parsed.person?.role).toBe('owner');
    expect(parsed.imageUrl).toBe('/api/team/avatars/author-1.png');
  });

  it('parses a full agent row with its owner attribution and facts', () => {
    const parsed = TeamMemberSchema.parse(FULL_AGENT);
    expect(parsed.ownerId).toBe('author-1');
    expect(parsed.agent?.recentlyActive).toBe(true);
    expect(parsed.agent?.runtime).toBe('claude-code');
  });

  describe('activity (spec `profile-unification` §3.1)', () => {
    // The whole point of the field: one object, always there, both members
    // nullable — so a renderer distinguishes "working", "idle since" and "never
    // run" without ever having to read an absent field as a state.
    it('refuses an agent row that omits it', () => {
      const { activity: _omitted, ...withoutActivity } = FULL_AGENT.agent;
      expect(TeamMemberSchema.safeParse({ ...FULL_AGENT, agent: withoutActivity }).success).toBe(
        false
      );
    });

    it('accepts the idle and never-run states, which are not the same state', () => {
      const idle = TeamMemberSchema.parse({
        ...FULL_AGENT,
        agent: {
          ...FULL_AGENT.agent,
          activity: { working: null, lastActiveAt: '2026-08-16T09:00:00.000Z' },
        },
      });
      expect(idle.agent?.activity.working).toBeNull();
      expect(idle.agent?.activity.lastActiveAt).toBe('2026-08-16T09:00:00.000Z');

      const never = TeamMemberSchema.parse({
        ...FULL_AGENT,
        agent: { ...FULL_AGENT.agent, activity: { working: null, lastActiveAt: null } },
      });
      expect(never.agent?.activity).toEqual({ working: null, lastActiveAt: null });
    });

    it('keeps working without a room name, because the label is what degrades', () => {
      const parsed = TeamMemberSchema.parse({
        ...FULL_AGENT,
        agent: {
          ...FULL_AGENT.agent,
          activity: {
            working: { roomId: 'room-1', roomName: null, since: '2026-08-16T09:55:00.000Z' },
            lastActiveAt: null,
          },
        },
      });
      expect(parsed.agent?.activity.working?.roomName).toBeNull();
    });

    it('refuses a working block that omits the room name rather than nulling it', () => {
      expect(
        TeamMemberSchema.safeParse({
          ...FULL_AGENT,
          agent: {
            ...FULL_AGENT.agent,
            activity: {
              working: { roomId: 'room-1', since: '2026-08-16T09:55:00.000Z' },
              lastActiveAt: null,
            },
          },
        }).success
      ).toBe(false);
    });
  });

  it('refuses a person row that omits lastSeenAt rather than nulling it', () => {
    const { lastSeenAt: _omitted, ...withoutLastSeen } = FULL_PERSON.person;
    expect(TeamMemberSchema.safeParse({ ...FULL_PERSON, person: withoutLastSeen }).success).toBe(
      false
    );
  });

  it('parses a minimal row — every render-cache field is optional', () => {
    const parsed = TeamMemberSchema.parse(MINIMAL_MEMBER);
    expect(parsed.emoji).toBeUndefined();
    expect(parsed.agent).toBeUndefined();
    expect(parsed.person).toBeUndefined();
  });

  it('refuses a row that omits ownerId', () => {
    const { ownerId: _omitted, ...withoutOwner } = MINIMAL_MEMBER;
    expect(TeamMemberSchema.safeParse(withoutOwner).success).toBe(false);
  });

  it('accepts a null ownerId — nothing owns a person or a system agent', () => {
    expect(TeamMemberSchema.parse({ ...MINIMAL_MEMBER, ownerId: null }).ownerId).toBeNull();
  });

  it('refuses a row that omits handle rather than nulling it', () => {
    const { handle: _omitted, ...withoutHandle } = MINIMAL_MEMBER;
    expect(TeamMemberSchema.safeParse(withoutHandle).success).toBe(false);
  });

  it('carries a person from outside this machine in the same shape', () => {
    const parsed = TeamMemberSchema.parse({
      ...MINIMAL_MEMBER,
      origin: { platform: 'telegram' },
    });
    expect(parsed.origin).toEqual({ platform: 'telegram' });
  });

  it('refuses an unknown kind', () => {
    expect(TeamMemberSchema.safeParse({ ...MINIMAL_MEMBER, kind: 'person' }).success).toBe(false);
  });
});

describe('TeamSourceWarningSchema', () => {
  it('needs a named source and a message', () => {
    expect(TeamSourceWarningSchema.parse({ source: 'agents', message: 'boom' })).toEqual({
      source: 'agents',
      message: 'boom',
    });
    expect(TeamSourceWarningSchema.safeParse({ source: '', message: 'boom' }).success).toBe(false);
    expect(TeamSourceWarningSchema.safeParse({ source: 'agents' }).success).toBe(false);
  });
});

describe('TeamRosterResponseSchema', () => {
  it('accepts an envelope with no warnings key at all', () => {
    const parsed = TeamRosterResponseSchema.parse({ members: [MINIMAL_MEMBER] });
    expect(parsed.warnings).toBeUndefined();
    expect('warnings' in parsed).toBe(false);
  });

  it('carries per-source warnings when a source degraded', () => {
    const parsed = TeamRosterResponseSchema.parse({
      members: [MINIMAL_MEMBER],
      warnings: [{ source: 'agents', message: "Couldn't read your agents" }],
    });
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings?.[0]?.source).toBe('agents');
  });

  it('accepts an empty roster only as a list, never as a missing key', () => {
    expect(TeamRosterResponseSchema.parse({ members: [] }).members).toEqual([]);
    expect(TeamRosterResponseSchema.safeParse({}).success).toBe(false);
  });
});

describe('TeamMemberSchema fact blocks are tied to kind', () => {
  it('refuses agent facts on a human row', () => {
    const result = TeamMemberSchema.safeParse({
      ...MINIMAL_MEMBER,
      agent: { manifestId: 'dorkbot', isDefault: false, isSystem: true },
    });
    expect(result.success).toBe(false);
  });

  it('refuses person facts on an agent row', () => {
    const result = TeamMemberSchema.safeParse({
      ...MINIMAL_MEMBER,
      kind: 'agent',
      person: { role: null },
    });
    expect(result.success).toBe(false);
  });

  it('refuses either block on a system row', () => {
    expect(
      TeamMemberSchema.safeParse({ ...MINIMAL_MEMBER, kind: 'system', person: { role: null } })
        .success
    ).toBe(false);
  });
});
