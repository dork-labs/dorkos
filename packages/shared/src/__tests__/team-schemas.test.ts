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
  person: { role: 'owner', email: 'dorian@dorkos.ai' },
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
    working: true,
    namespace: 'dorkos',
    projectPath: '/Users/dorian/agents/ana',
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
    expect(parsed.agent?.working).toBe(true);
    expect(parsed.agent?.runtime).toBe('claude-code');
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
