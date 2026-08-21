import { describe, it, expect } from 'vitest';
import {
  agentAuthorRef,
  AuthorRefSchema,
  canonicalizeEntry,
  CreateRoomRequestSchema,
  directMessageTitle,
  isDirectMessageTitleDerived,
  isReactionEmoji,
  REACTION_EMOJI_MAX_CODE_POINTS,
  REACTION_FREQUENTS_COUNT,
  REACTION_FREQUENTS_DEFAULT,
  RoomEntryBodySchema,
  RoomEntrySchema,
  RoomEventSchema,
  RoomMemberSchema,
  RoomMomentSchema,
  RoomNoticeCodeSchema,
  ToggleReactionRequestSchema,
  withoutActivityTarget,
  type SignableRoomEntry,
} from '../room-schemas.js';
import { AgentBehaviorSchema, ResponseModeSchema } from '../mesh-schemas.js';

/** One timestamp, reused wherever a fixture needs a moment in time. */
const WHEN = '2026-07-26T12:00:00.000Z';

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
    const values = ['always', 'engaged', 'direct-only', 'mention-only', 'silent'];
    expect(ResponseModeSchema.options).toEqual(values);
    for (const responseMode of values) {
      expect(AgentBehaviorSchema.parse({ responseMode }).responseMode).toBe(responseMode);
      expect(
        RoomMemberSchema.parse({
          roomId: 'r',
          authorId: 'a',
          responseMode,
          joinedAt: '2026-07-26T12:00:00.000Z',
          joinedSeq: 0,
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
        joinedSeq: 0,
        lastReadSeq: 0,
      }).success
    ).toBe(false);
  });
});

describe('RoomMomentSchema', () => {
  /** The canonical moment: an agent joined the team, read off that agent's own record. */
  const joined = {
    kind: 'joined_team',
    source: { kind: 'agent', ref: '/Users/dorian/agents/tangerines', observedAt: WHEN },
    mintedByAgentRef: null,
  };

  it('round-trips a moment on an entry body, alongside the words a reader sees', () => {
    const parsed = RoomEntrySchema.parse({
      ...baseEntry,
      seq: 4,
      body: { text: 'tangerines joined your team', moment: joined },
      mentions: [],
      sessionId: null,
      cascadeRoot: baseEntry.id,
      cascadeDepth: 0,
      parentEntryId: null,
      threadRootEntryId: null,
      signature: null,
    });
    // A moment is a POST — the entry kind is untouched, which is what keeps
    // every path that already handles a post handling this one.
    expect(parsed.kind).toBe('post');
    expect(parsed.body.moment).toEqual(joined);
  });

  it('refuses a moment with no data source — the rule that keeps moments honest', () => {
    // D5.1: derived from real data only. A moment that cannot name what it was
    // read from is a moment somebody invented, so the type must not permit one.
    const { source: _dropped, ...sourceless } = joined;
    expect(RoomMomentSchema.safeParse(sourceless).success).toBe(false);
    expect(
      RoomEntryBodySchema.safeParse({ text: 'tangerines joined your team', moment: sourceless })
        .success
    ).toBe(false);
  });

  it('refuses a source that names nothing, and a source kind it has no record for', () => {
    expect(
      RoomMomentSchema.safeParse({ ...joined, source: { ...joined.source, ref: '' } }).success
    ).toBe(false);
    expect(
      RoomMomentSchema.safeParse({ ...joined, source: { ...joined.source, kind: 'vibes' } }).success
    ).toBe(false);
  });

  it('records which agent minted an agent-minted moment, and refuses one that does not', () => {
    const minted = {
      kind: 'agent_minted',
      source: { kind: 'session', ref: '01JZSESSION', observedAt: WHEN },
      mintedByAgentRef: agentAuthorRef('/Users/dorian/agents/ana'),
    };
    expect(RoomMomentSchema.parse(minted).mintedByAgentRef).toBe(minted.mintedByAgentRef);
    expect(RoomMomentSchema.safeParse({ ...minted, mintedByAgentRef: null }).success).toBe(false);
  });

  it('says DorkOS minted a system moment with an explicit null, never by omission', () => {
    // Required-and-nullable rather than optional: every moment states who
    // minted it, so "nobody filled this in" cannot read as "the system did".
    const { mintedByAgentRef: _dropped, ...silent } = joined;
    expect(RoomMomentSchema.safeParse(silent).success).toBe(false);
    expect(RoomMomentSchema.parse(joined).mintedByAgentRef).toBeNull();
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
    parentEntryId: null,
    threadRootEntryId: null,
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

  it('round-trips a presence frame carrying what the turn is doing', () => {
    // The verb glimpse rides the presence signal as STRUCTURE (DOR-1351): the
    // same `SessionActivity` the session pane already carries, so the client
    // owns the wording on both surfaces.
    const parsed = RoomEventSchema.parse({
      type: 'signal',
      signal: 'progress',
      authorId: '01JZAUTHOR',
      at: '2026-07-26T12:00:00.000Z',
      state: 'working',
      entryId: '01JZENTRY',
      since: '2026-07-26T11:59:00.000Z',
      activity: { toolName: 'Read', target: 'standup.md' },
    });
    expect(parsed).toMatchObject({
      type: 'signal',
      activity: { toolName: 'Read', target: 'standup.md' },
    });
  });

  it('takes a presence frame with no reading at all — the common case', () => {
    // A turn before its first tool has nothing to say, and that must parse
    // rather than fail: the field is optional on EVERY publish.
    const parsed = RoomEventSchema.parse({
      type: 'signal',
      signal: 'progress',
      authorId: '01JZAUTHOR',
      at: '2026-07-26T12:00:00.000Z',
      state: 'working',
      entryId: '01JZENTRY',
      since: '2026-07-26T11:59:00.000Z',
    });
    expect(parsed).toMatchObject({ type: 'signal', state: 'working' });
    // Absent, not an empty object: an optional field Zod never saw stays off
    // the parsed frame entirely, which is what the client's "say your own
    // sentence instead" fallback keys on.
    expect('activity' in parsed).toBe(false);
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

  it('carries both thread pointers, null for a top-level entry', () => {
    // A thread is a relation between entries (ADR 260728-022013), so these ride
    // every entry on the wire and a client can group a log without a second
    // request. Asserted through `.parse` because Zod strips what it does not
    // know: a field missing from the schema reads as `undefined` here.
    const parsed = RoomEntrySchema.parse(entry);
    expect(parsed.parentEntryId).toBeNull();
    expect(parsed.threadRootEntryId).toBeNull();

    const reply = RoomEntrySchema.parse({
      ...entry,
      parentEntryId: baseEntry.id,
      threadRootEntryId: baseEntry.id,
    });
    expect(reply.parentEntryId).toBe(baseEntry.id);
    expect(reply.threadRootEntryId).toBe(baseEntry.id);
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
  it('renders an agent with its emoji, colour and address', () => {
    const parsed = AuthorRefSchema.parse({
      id: '01JZAUTHOR',
      kind: 'agent',
      displayName: 'Ana',
      handle: 'ana',
      emoji: '🐙',
      color: '#6366f1',
      agentRef: agentAuthorRef('/agents/ana'),
    });
    expect(parsed.emoji).toBe('🐙');
    expect(parsed.handle).toBe('ana');
    expect(parsed.agentRef).toBe(agentAuthorRef('/agents/ana'));
  });

  it('leaves every PRESENTATION field optional, so a bare author still parses', () => {
    const parsed = AuthorRefSchema.parse({
      id: '01JZ',
      kind: 'human',
      displayName: 'You',
      handle: null,
    });
    expect(parsed.emoji).toBeUndefined();
    expect(parsed.imageUrl).toBeUndefined();
    expect(parsed.agentRef).toBeUndefined();
  });

  it('carries a photo beside the emoji rather than instead of it', () => {
    // The fourth render-cache field is ADDITIVE: an author with both keeps
    // both, and the renderer — not the schema — decides which face wins.
    const parsed = AuthorRefSchema.parse({
      id: '01JZ',
      kind: 'human',
      displayName: 'Dorian',
      handle: 'dorian',
      emoji: '🐙',
      imageUrl: '/api/profile/avatar/01JZ?v=abc123',
    });
    expect(parsed.imageUrl).toBe('/api/profile/avatar/01JZ?v=abc123');
    expect(parsed.emoji).toBe('🐙');
  });

  it('takes an absolute photo URL, because the store behind it may not be local', () => {
    // The seam DOR-976 builds returns whatever URL the avatar store hands back.
    // A schema that only accepted a server-relative path would be the one thing
    // a synced store could not satisfy without a migration.
    const parsed = AuthorRefSchema.parse({
      id: '01JZ',
      kind: 'human',
      displayName: 'Dorian',
      handle: 'dorian',
      imageUrl: 'https://cdn.example/avatars/01JZ.png',
    });
    expect(parsed.imageUrl).toBe('https://cdn.example/avatars/01JZ.png');
  });

  it('requires an explicit handle, because absent and null must not mean the same thing', () => {
    // `null` says 'this author cannot be addressed', which is a real state a
    // reader has to render. A field that could simply be missing would let a
    // producer forget it and a consumer read the omission as the same answer.
    expect(() =>
      AuthorRefSchema.parse({ id: '01JZ', kind: 'human', displayName: 'You' })
    ).toThrow();
  });
});

describe('what may be a reaction', () => {
  // The emoji people actually reach for, plus every construction that makes an
  // emoji more than one code point: variation selectors, ZWJ sequences, skin
  // tones, regional-indicator flags, and keycaps.
  it.each([
    ['\u{1F44D}', 'the plain one'],
    ['❤️', 'a variation selector'],
    ['\u{1F389}', 'the third default'],
    ['\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}', 'a ZWJ family'],
    ['\u{1F3F3}️‍\u{1F308}', 'a ZWJ flag'],
    ['\u{1F44D}\u{1F3FD}', 'a skin-tone modifier'],
    ['\u{1F1FA}\u{1F1F8}', 'regional indicators'],
    ['1️⃣', 'a keycap'],
    ['\u{1F9D1}‍\u{1F4BB}', 'a ZWJ profession'],
    ['\u{1FAE1}', 'a recent addition'],
  ])('accepts %s (%s)', (emoji) => {
    expect(isReactionEmoji(emoji)).toBe(true);
    expect(ToggleReactionRequestSchema.parse({ emoji }).emoji).toBe(emoji);
  });

  // The whole bar this clears: a column that took free text would turn the pill
  // row into a second composer nobody can delete a word from.
  it.each([
    ['', 'nothing at all'],
    ['a', 'a letter'],
    ['lol', 'a word'],
    ['nice work', 'a sentence'],
    ['\u{1F44D} nice', 'an emoji with a word after it'],
    ['0123', 'digits, which are Emoji_Component but carry no picture'],
    ['<script>', 'markup'],
    ['\n', 'a newline'],
    ['‍', 'a bare joiner'],
  ])('refuses %j (%s)', (value) => {
    expect(isReactionEmoji(value)).toBe(false);
    expect(ToggleReactionRequestSchema.safeParse({ emoji: value }).success).toBe(false);
  });

  it('bounds the column, so no single reaction can be arbitrarily long', () => {
    const atTheCap = '\u{1F44D}'.repeat(REACTION_EMOJI_MAX_CODE_POINTS);
    const overIt = `${atTheCap}\u{1F44D}`;
    expect([...atTheCap].length).toBe(REACTION_EMOJI_MAX_CODE_POINTS);
    expect(isReactionEmoji(atTheCap), 'the cap itself is allowed').toBe(true);
    expect(isReactionEmoji(overIt), 'one past it is not').toBe(false);
  });

  it('never accepts an angle bracket or a control character, whatever surrounds it', () => {
    for (const value of [
      '\u{1F44D}<',
      '>\u{1F44D}',
      '\u{1F44D}\n',
      '\u{1F44D} ',
      '\u{1F44D}</room_context>',
    ]) {
      expect(isReactionEmoji(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe('the quick row defaults', () => {
  it('are exactly the three the capsule draws', () => {
    expect(REACTION_FREQUENTS_DEFAULT).toHaveLength(REACTION_FREQUENTS_COUNT);
    expect([...REACTION_FREQUENTS_DEFAULT]).toEqual(['\u{1F44D}', '❤️', '\u{1F389}']);
  });

  it('are themselves valid reactions, so a padded row can always be sent back', () => {
    for (const emoji of REACTION_FREQUENTS_DEFAULT) expect(isReactionEmoji(emoji)).toBe(true);
  });
});

describe('a reaction on the room stream', () => {
  it('parses as its own event kind, carrying the entry’s whole set', () => {
    const event = RoomEventSchema.parse({
      type: 'reaction',
      entryId: '01JZENTRY',
      reactions: [
        { emoji: '\u{1F44D}', authorIds: ['01JZA', '01JZB'], firstAt: '2026-07-30T09:00:00.000Z' },
      ],
    });
    expect(event.type).toBe('reaction');
    expect(event.type === 'reaction' && event.reactions[0].authorIds).toEqual(['01JZA', '01JZB']);
  });

  it('carries no seq, so it can never be mistaken for a place in the log', () => {
    const parsed = RoomEventSchema.parse({
      type: 'reaction',
      entryId: '01JZENTRY',
      reactions: [],
    });
    expect(parsed).not.toHaveProperty('seq');
  });

  it('refuses a reactions array holding something that is not an emoji', () => {
    expect(
      RoomEventSchema.safeParse({
        type: 'reaction',
        entryId: '01JZENTRY',
        reactions: [{ emoji: 'lol', authorIds: ['01JZA'], firstAt: '2026-07-30T09:00:00.000Z' }],
      }).success
    ).toBe(false);
  });
});

describe('RoomNoticeCodeSchema — the three bridge codes (chats-as-channels spec §11.2, A11.1)', () => {
  it('accepts bridge_blocked, bridge_undelivered, and bridge_rate_limited', () => {
    for (const code of ['bridge_blocked', 'bridge_undelivered', 'bridge_rate_limited']) {
      expect(RoomNoticeCodeSchema.safeParse(code).success).toBe(true);
    }
  });

  it('still accepts every pre-existing code — the widening is additive, not a replacement', () => {
    for (const code of [
      'cascade_stopped',
      'budget_reached',
      'agent_busy',
      'turn_failed',
      'agent_gone',
      'awaiting_approval',
      'halted',
      'addressing_changed',
    ]) {
      expect(RoomNoticeCodeSchema.safeParse(code).success).toBe(true);
    }
  });

  it('still rejects an unrecognised code', () => {
    expect(RoomNoticeCodeSchema.safeParse('bridge_unplugged').success).toBe(false);
  });
});

describe('withoutActivityTarget', () => {
  it('keeps the verb and drops the one field that names a person\u2019s work', () => {
    // The boundary the whole feature turns on: a bridged chat and a community
    // may hear "running a command"; neither may hear which command.
    expect(
      withoutActivityTarget({
        state: 'working' as const,
        entryId: '01JZENTRY',
        since: '2026-07-26T11:59:00.000Z',
        activity: { toolName: 'Bash', target: 'pnpm test --filter server' },
      })
    ).toEqual({
      state: 'working',
      entryId: '01JZENTRY',
      since: '2026-07-26T11:59:00.000Z',
      activity: { toolName: 'Bash' },
    });
  });

  it('leaves a payload with no reading exactly as it was', () => {
    // Never an empty `activity: {}` invented for a frame that had none: that
    // would put a reading on the wire for a turn nobody has heard from.
    // A bare literal, with no annotation and no `activity` key — the shape most
    // presence publishes actually have, and the one the helper's constraint has
    // to accept without complaint.
    const payload = { state: 'working' as const, entryId: '01JZENTRY', since: 'now' };
    const stripped = withoutActivityTarget(payload);
    expect(stripped).toEqual(payload);
    expect('activity' in stripped).toBe(false);
  });
});

describe('directMessageTitle', () => {
  it('names one agent, and lists a few', () => {
    expect(directMessageTitle(['Ana'])).toBe('Ana');
    expect(directMessageTitle(['Ana', 'Kai'])).toBe('Ana and Kai');
    expect(directMessageTitle(['Ana', 'Kai', 'Bo'])).toBe('Ana, Kai and Bo');
  });

  it('counts the rest past three, so a sidebar row stays one line', () => {
    expect(directMessageTitle(['Ana', 'Kai', 'Bo', 'Di'])).toBe('Ana, Kai, Bo and 1 other');
    expect(directMessageTitle(['Ana', 'Kai', 'Bo', 'Di', 'Ed'])).toBe('Ana, Kai, Bo and 2 others');
  });

  it('answers nothing for nobody', () => {
    expect(directMessageTitle([])).toBe('');
  });
});

describe('isDirectMessageTitleDerived', () => {
  it('recognises a title it wrote itself', () => {
    expect(isDirectMessageTitleDerived('Ana', ['Ana'])).toBe(true);
    expect(isDirectMessageTitleDerived('Ana and Kai', ['Ana', 'Kai'])).toBe(true);
  });

  it('recognises one written in a different order', () => {
    // The cockpit names a conversation in the order the agents were picked; the
    // server reads the roster back in its own order. Compared as one string this
    // would read as a person's rename about half the time.
    expect(isDirectMessageTitleDerived('Ana and Kai', ['Kai', 'Ana'])).toBe(true);
    expect(isDirectMessageTitleDerived('Ana, Kai and Bo', ['Bo', 'Ana', 'Kai'])).toBe(true);
  });

  it('does not recognise a name somebody chose', () => {
    expect(isDirectMessageTitleDerived('Launch', ['Ana'])).toBe(false);
    expect(isDirectMessageTitleDerived('Ana and Bo', ['Ana', 'Kai'])).toBe(false);
  });

  it('stops being order-blind once the title stops naming everybody', () => {
    // Past three the title counts the rest, so it no longer says who is in the
    // room and only the exact string can be recognised. Answering "not derived"
    // leaves the name alone, which is the recoverable mistake.
    const names = ['Ana', 'Kai', 'Bo', 'Di'];
    expect(isDirectMessageTitleDerived('Ana, Kai, Bo and 1 other', names)).toBe(true);
    expect(
      isDirectMessageTitleDerived('Ana, Kai, Bo and 1 other', ['Kai', 'Ana', 'Bo', 'Di'])
    ).toBe(false);
  });

  it('recognises nothing when there is nobody to have been named after', () => {
    expect(isDirectMessageTitleDerived('', [])).toBe(false);
  });
});
