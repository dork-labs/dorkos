import { describe, it, expect } from 'vitest';
import {
  agentAuthorRef,
  AuthorRefSchema,
  canonicalizeEntry,
  CreateRoomRequestSchema,
  RoomEntrySchema,
  RoomEventSchema,
  RoomMemberSchema,
  type SignableRoomEntry,
} from '../room-schemas.js';
import { AgentBehaviorSchema, ResponseModeSchema } from '../mesh-schemas.js';

const baseEntry: SignableRoomEntry = {
  roomId: '01JZROOM',
  id: '01JZENTRY',
  authorId: '01JZAUTHOR',
  kind: 'post',
  body: { text: 'ship it' },
  createdAt: '2026-07-26T12:00:00.000Z',
};

describe('canonicalizeEntry', () => {
  it('emits the six signable fields, key-sorted, with no whitespace', () => {
    expect(canonicalizeEntry(baseEntry)).toBe(
      '{"authorId":"01JZAUTHOR","body":{"text":"ship it"},"createdAt":"2026-07-26T12:00:00.000Z","id":"01JZENTRY","kind":"post","roomId":"01JZROOM"}'
    );
  });

  it('is byte-identical regardless of the order the input object was built in', () => {
    const shuffled: SignableRoomEntry = {
      createdAt: baseEntry.createdAt,
      kind: baseEntry.kind,
      roomId: baseEntry.roomId,
      body: baseEntry.body,
      id: baseEntry.id,
      authorId: baseEntry.authorId,
    };
    expect(canonicalizeEntry(shuffled)).toBe(canonicalizeEntry(baseEntry));
  });

  it('sorts nested keys too, at every depth', () => {
    const entry: SignableRoomEntry = {
      ...baseEntry,
      body: { subjectAuthorId: '01JZB', notice: 'cascade_stopped', text: 'stopped' },
    };
    expect(canonicalizeEntry(entry)).toBe(
      '{"authorId":"01JZAUTHOR","body":{"notice":"cascade_stopped","subjectAuthorId":"01JZB","text":"stopped"},"createdAt":"2026-07-26T12:00:00.000Z","id":"01JZENTRY","kind":"post","roomId":"01JZROOM"}'
    );
  });

  it('normalizes strings to NFC, so decomposed and composed input agree', () => {
    // Two spellings of "cafe" with an acute: U+00E9, and "e" + U+0301 combining
    // acute. They render identically and would otherwise sign to different bytes.
    const composed = canonicalizeEntry({ ...baseEntry, body: { text: 'caf\u00e9' } });
    const decomposed = canonicalizeEntry({ ...baseEntry, body: { text: 'cafe\u0301' } });
    expect(decomposed).toBe(composed);
    expect(composed).toContain('"text":"caf\u00e9"');
  });

  it('normalizes object KEYS to NFC as well, not just values', () => {
    const composedKey = { ...baseEntry, body: { text: 'x', ['caf\u00e9']: 1 } };
    const decomposedKey = { ...baseEntry, body: { text: 'x', ['cafe\u0301']: 1 } };
    expect(canonicalizeEntry(decomposedKey as unknown as SignableRoomEntry)).toBe(
      canonicalizeEntry(composedKey as unknown as SignableRoomEntry)
    );
  });

  it('drops undefined properties rather than emitting them', () => {
    const withUndefined = {
      ...baseEntry,
      body: { text: 'hi', notice: undefined, subjectAuthorId: undefined },
    } as SignableRoomEntry;
    expect(canonicalizeEntry(withUndefined)).toBe(
      '{"authorId":"01JZAUTHOR","body":{"text":"hi"},"createdAt":"2026-07-26T12:00:00.000Z","id":"01JZENTRY","kind":"post","roomId":"01JZROOM"}'
    );
  });

  it('ignores anything outside the signable subset', () => {
    const noisy = {
      ...baseEntry,
      seq: 7,
      mentions: ['01JZB'],
      cascadeRoot: '01JZENTRY',
      cascadeDepth: 0,
      signature: null,
    } as unknown as SignableRoomEntry;
    expect(canonicalizeEntry(noisy)).toBe(canonicalizeEntry(baseEntry));
  });
});

describe('responseMode reuse', () => {
  it('is the same enum the agent manifest already ships — one declaration, two scopes', () => {
    const values = ['always', 'direct-only', 'mention-only', 'silent'];
    expect(ResponseModeSchema.options).toEqual(values);
    for (const responseMode of values) {
      expect(AgentBehaviorSchema.parse({ responseMode }).responseMode).toBe(responseMode);
      expect(
        RoomMemberSchema.parse({
          roomId: 'r',
          authorId: 'a',
          responseMode,
          joinedAt: '2026-07-26T12:00:00.000Z',
          lastReadSeq: 0,
        }).responseMode
      ).toBe(responseMode);
    }
  });

  it('rejects a mode the manifest enum does not know', () => {
    expect(
      RoomMemberSchema.safeParse({
        roomId: 'r',
        authorId: 'a',
        responseMode: 'sometimes',
        joinedAt: '2026-07-26T12:00:00.000Z',
        lastReadSeq: 0,
      }).success
    ).toBe(false);
  });
});

describe('CreateRoomRequestSchema', () => {
  it('accepts a channel named by title alone', () => {
    expect(CreateRoomRequestSchema.safeParse({ kind: 'channel', title: 'Backend' }).success).toBe(
      true
    );
  });

  it('refuses a room with neither a title nor a slug', () => {
    expect(CreateRoomRequestSchema.safeParse({ kind: 'channel' }).success).toBe(false);
  });

  it('refuses a thread — threads are opened off an entry, not created bare', () => {
    expect(CreateRoomRequestSchema.safeParse({ kind: 'thread', title: 'x' }).success).toBe(false);
  });

  it('refuses a DM named only by a slug, which used to render as a bare "#"', () => {
    expect(CreateRoomRequestSchema.safeParse({ kind: 'dm', slug: 'ana' }).success).toBe(false);
    expect(CreateRoomRequestSchema.safeParse({ kind: 'dm', title: 'Ana' }).success).toBe(true);
  });

  it('takes agent directories, so a DM is one call', () => {
    const parsed = CreateRoomRequestSchema.parse({
      kind: 'dm',
      title: 'Ana',
      agentPaths: ['/Users/dorian/agents/ana'],
    });
    expect(parsed.agentPaths).toEqual(['/Users/dorian/agents/ana']);
    // Both seeding lists default, so an existing caller keeps working.
    expect(CreateRoomRequestSchema.parse({ kind: 'dm', title: 'Ana' }).agentPaths).toEqual([]);
  });

  it('refuses a slug with characters a URL would have to escape', () => {
    expect(CreateRoomRequestSchema.safeParse({ kind: 'channel', slug: 'Back End!' }).success).toBe(
      false
    );
  });
});

describe('RoomEventSchema', () => {
  const entry = {
    ...baseEntry,
    seq: 1,
    mentions: [],
    sessionId: null,
    cascadeRoot: baseEntry.id,
    cascadeDepth: 0,
    signature: null,
  };

  it('parses a durable entry event', () => {
    const parsed = RoomEventSchema.parse({ type: 'entry', seq: 1, entry });
    expect(parsed.type).toBe('entry');
  });

  it('parses an ephemeral signal event using the relay signal vocabulary', () => {
    const parsed = RoomEventSchema.parse({
      type: 'signal',
      signal: 'typing',
      authorId: '01JZAUTHOR',
      at: '2026-07-26T12:00:00.000Z',
    });
    expect(parsed.type).toBe('signal');
  });

  it('refuses a signal name the relay does not define', () => {
    expect(
      RoomEventSchema.safeParse({
        type: 'signal',
        signal: 'thinking',
        authorId: '01JZAUTHOR',
        at: '2026-07-26T12:00:00.000Z',
      }).success
    ).toBe(false);
  });

  it('keeps signature null in v1', () => {
    expect(RoomEntrySchema.parse(entry).signature).toBeNull();
  });
});

describe('agentAuthorRef', () => {
  // Byte-exact, like `canonicalizeEntry`: this handle is persisted in nothing,
  // but a consumer compares it against one it computed itself, so a change to
  // the fold silently stops every such comparison matching. Pinning the output
  // makes that a failing test rather than a menu that quietly goes empty.
  // Cross-checked against a plain `Math.imul(h, 16777619)` FNV-1a, so this pins
  // the algorithm and not just whatever the current code happens to emit.
  it('pins its output for a known path', () => {
    expect(agentAuthorRef('/Users/dorian/agents/ana')).toBe('ed3a6c6692f64d84');
  });

  it('is stable, and different for different paths', () => {
    expect(agentAuthorRef('/agents/ana')).toBe(agentAuthorRef('/agents/ana'));
    expect(agentAuthorRef('/agents/ana')).not.toBe(agentAuthorRef('/agents/bo'));
  });

  it('is fixed width and reveals no path', () => {
    const ref = agentAuthorRef('/Users/dorian/agents/ana');
    expect(ref).toMatch(/^[0-9a-f]{16}$/);
    expect(ref).not.toContain('dorian');
  });
});

describe('AuthorRefSchema', () => {
  it('renders an agent with its emoji, colour and handle', () => {
    const parsed = AuthorRefSchema.parse({
      id: '01JZAUTHOR',
      kind: 'agent',
      displayName: 'Ana',
      emoji: '🐙',
      color: '#6366f1',
      agentRef: agentAuthorRef('/agents/ana'),
    });
    expect(parsed.emoji).toBe('🐙');
    expect(parsed.agentRef).toBe(agentAuthorRef('/agents/ana'));
  });

  it('leaves every presentation field optional, so a bare author still parses', () => {
    const parsed = AuthorRefSchema.parse({ id: '01JZ', kind: 'human', displayName: 'You' });
    expect(parsed.emoji).toBeUndefined();
    expect(parsed.agentRef).toBeUndefined();
  });
});
