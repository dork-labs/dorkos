import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  SESSION_POINTER_PATTERN,
  agentAuthorRef,
  AuthorRefSchema,
  canonicalizeEntry,
  CreateRoomRequestSchema,
  directMessageTitle,
  isDirectMessageTitleDerived,
  isReactionEmoji,
  REACTION_EMOJI_MAX_CODE_POINTS,
  REACTION_FREQUENTS_DEFAULT,
  RoomEntryBodySchema,
  RoomPresenceStateSchema,
  RoomMomentSchema,
  RoomNoticeCodeSchema,
  RoomWithRosterSchema,
  PostToRoomResponseSchema,
  ToggleReactionRequestSchema,
  withoutActivityTarget,
  type SignableRoomEntry,
} from '../room-schemas.js';

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

describe('RoomMomentSchema', () => {
  /** The canonical moment: an agent joined the team, read off that agent's own record. */
  const joined = {
    kind: 'joined_team',
    source: { kind: 'agent', ref: '/Users/dorian/agents/tangerines', observedAt: WHEN },
    mintedByAgentRef: null,
  };

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

  it('records which agent minted an agent-minted moment, and refuses one that does not', () => {
    const minted = {
      kind: 'agent_minted',
      source: { kind: 'session', ref: '01JZSESSION', observedAt: WHEN },
      mintedByAgentRef: agentAuthorRef('/Users/dorian/agents/ana'),
    };
    expect(RoomMomentSchema.parse(minted).mintedByAgentRef).toBe(minted.mintedByAgentRef);
    expect(RoomMomentSchema.safeParse({ ...minted, mintedByAgentRef: null }).success).toBe(false);
  });
});

describe('CreateRoomRequestSchema', () => {
  it('refuses a DM named only by a slug, which used to render as a bare "#"', () => {
    expect(CreateRoomRequestSchema.safeParse({ kind: 'dm', slug: 'ana' }).success).toBe(false);
    expect(CreateRoomRequestSchema.safeParse({ kind: 'dm', title: 'Ana' }).success).toBe(true);
  });

  it('refuses a slug with characters a URL would have to escape', () => {
    expect(CreateRoomRequestSchema.safeParse({ kind: 'channel', slug: 'Back End!' }).success).toBe(
      false
    );
  });
});

describe('agentAuthorRef', () => {
  it('is fixed width and reveals no path', () => {
    const ref = agentAuthorRef('/Users/dorian/agents/ana');
    expect(ref).toMatch(/^[0-9a-f]{16}$/);
    expect(ref).not.toContain('dorian');
  });
});

describe('AuthorRefSchema', () => {
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

  // The black flag plus the letters of a region and an end mark: the only emoji
  // spelled this way that pickers offer are England, Scotland and Wales.
  const flagOf = (letters: string) =>
    `\u{1F3F4}${[...letters].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('')}\u{E007F}`;

  it.each([
    ['England', flagOf('gbeng')],
    ['Scotland', flagOf('gbsct')],
    ['Wales', flagOf('gbwls')],
  ])('accepts subdivision flags: %s', (_name, emoji) => {
    expect(isReactionEmoji(emoji)).toBe(true);
    expect(ToggleReactionRequestSchema.parse({ emoji }).emoji).toBe(emoji);
  });

  it.each([
    ['flag letters after a different emoji', `\u{1F44D}${flagOf('gbeng').slice(2)}`],
    ['a flag with no end mark', flagOf('gbeng').slice(0, -2)],
    ['flag letters with no flag in front', flagOf('gbeng').slice(2)],
    ['a region pickers do not offer', flagOf('usca')],
    ['more letters after a real flag', `${flagOf('gbeng')}${flagOf('ok').slice(2)}`],
    ['an end mark with no letters', '\u{1F3F4}\u{E007F}'],
  ])('rejects a flag-like sequence that isn’t one: %s', (_reason, value) => {
    expect(isReactionEmoji(value)).toBe(false);
    expect(ToggleReactionRequestSchema.safeParse({ emoji: value }).success).toBe(false);
  });

  it('rejects a run of flags too long for one reaction', () => {
    const three = `${flagOf('gbeng')}${flagOf('gbsct')}${flagOf('gbwls')}`;
    expect([...three].length).toBeGreaterThan(REACTION_EMOJI_MAX_CODE_POINTS);
    expect(isReactionEmoji(three)).toBe(false);
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

describe('RoomNoticeCodeSchema — the three bridge codes (chats-as-channels spec §11.2, A11.1)', () => {
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
});

describe('directMessageTitle', () => {
  it('counts the rest past three, so a sidebar row stays one line', () => {
    expect(directMessageTitle(['Ana', 'Kai', 'Bo', 'Di'])).toBe('Ana, Kai, Bo and 1 other');
    expect(directMessageTitle(['Ana', 'Kai', 'Bo', 'Di', 'Ed'])).toBe('Ana, Kai, Bo and 2 others');
  });
});

describe('isDirectMessageTitleDerived', () => {
  it('recognises one written in a different order', () => {
    // The app names a conversation in the order the agents were picked; the
    // server reads the roster back in its own order. Compared as one string this
    // would read as a person's rename about half the time.
    expect(isDirectMessageTitleDerived('Ana and Kai', ['Kai', 'Ana'])).toBe(true);
    expect(isDirectMessageTitleDerived('Ana, Kai and Bo', ['Bo', 'Ana', 'Kai'])).toBe(true);
  });

  it('does not recognise a name somebody chose', () => {
    expect(isDirectMessageTitleDerived('Launch', ['Ana'])).toBe(false);
    expect(isDirectMessageTitleDerived('Ana and Bo', ['Ana', 'Kai'])).toBe(false);
  });
});

describe('PostToRoomResponseSchema — who a message reached (DOR-786)', () => {
  const identity = { accepted: true as const, entryId: '01JZENTRY', seq: 7 };

  it('still parses a body from before either field existed', () => {
    // The reason both are optional. A client on an older server must not fail to
    // read a 202 for a message that was accepted.
    const parsed = PostToRoomResponseSchema.parse(identity);
    expect(parsed.triggered).toBeUndefined();
    expect(parsed.skipped).toBeUndefined();
  });

  it('keeps "nobody" and "cannot say" as different answers', () => {
    // The distinction the whole field rests on: `[]` is a claim about the room,
    // absent is a claim about the source. Nothing may collapse one into the other.
    const nobody = PostToRoomResponseSchema.parse({ ...identity, triggered: [], skipped: [] });
    expect(nobody.triggered).toEqual([]);
    expect(nobody.skipped).toEqual([]);
  });
});

describe('RoomWithRosterSchema.workingAgents — presence on the room read (DOR-786)', () => {
  const room = {
    id: '01JZROOM',
    kind: 'channel' as const,
    slug: 'backend',
    title: '#backend',
    topic: null,
    archived: false,
    ambientMaxEntries: 40,
    createdAt: WHEN,
    lastActivityAt: WHEN,
    members: [],
    viewerAuthorId: '01JZHUMAN',
    reactionFrequents: [...REACTION_FREQUENTS_DEFAULT],
  };

  it('is optional, so a room read from an older server still parses', () => {
    expect(RoomWithRosterSchema.parse(room).workingAgents).toBeUndefined();
  });
});

describe("a done presence signal's outcome (tool-only-room-replies §D7)", () => {
  /** A `done` frame, as the dispatcher publishes one. */
  const done = {
    type: 'signal' as const,
    signal: 'progress' as const,
    authorId: '01JZANA',
    at: WHEN,
    state: 'done' as const,
    entryId: '01JZENTRY',
    since: WHEN,
  };

  it('AC 15 — an OLDER schema build still parses a frame carrying it', () => {
    // The whole reason this is an optional field rather than a fifth
    // `RoomPresenceState`. That enum is parsed by every client and reused by the
    // `CommunityAdapter` presence payload, and `useRoomPresenceStore.observe`
    // DROPS a frame it cannot parse — so a new enum member would make a desktop
    // build one release behind fail to parse the RELEASE frame and leave the
    // working pill spinning forever.
    //
    // The older build is reconstructed rather than described: the same object
    // schema minus this field, which is exactly what shipped before it.
    const olderBuild = z.object({
      type: z.literal('signal'),
      signal: z.string(),
      authorId: z.string().min(1),
      at: z.string(),
      state: RoomPresenceStateSchema.optional(),
      entryId: z.string().optional(),
      since: z.string().optional(),
    });
    expect(olderBuild.safeParse({ ...done, outcome: 'silent' }).success).toBe(true);
    // And the state itself is untouched, which is what that build keys on.
    expect(RoomPresenceStateSchema.options).toEqual(['working', 'working_late', 'held', 'done']);
  });
});

describe("the words a notice uses to send a reader to an agent's chat (DOR-2789)", () => {
  it('still links a notice written before the rename, which says "session"', () => {
    // Room logs keep their lines as written, so an old notice must keep its link.
    expect(
      SESSION_POINTER_PATTERN.exec("Kai is waiting for you. Open Kai's session to answer.")?.[0]
    ).toBe("Open Kai's session");
  });
});
