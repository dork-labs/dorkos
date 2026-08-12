import { describe, it, expect } from 'vitest';
import {
  CONTEXT_TAG,
  ClientContextSchema,
  AdditionalContextEntrySchema,
  type ContextKind,
} from '../additional-context.js';
import { SendMessageRequestSchema, SEED_CONTEXT_MAX_LENGTH } from '../schemas.js';

const ALL_KINDS: ContextKind[] = [
  'git_status',
  'ui_state',
  'queue_note',
  'staged_context',
  'env',
  'relay_context',
  'room_context',
  'seed_context',
];

/** A minimal but complete room context — every field the union requires. */
const SAMPLE_ROOM_CONTEXT = {
  room: { id: 'room-1', kind: 'channel', name: '#build', bridged: false },
  thread: null,
  members: [{ handle: 'ana', displayName: 'Ana', isPerson: false, isSelf: true, origin: 'local' }],
  working: [],
  pending: [],
  pendingTruncated: false,
  ownRecent: [],
  acknowledgments: [],
  triggerAttachments: [],
  addressing: {
    responseMode: 'always',
    engagedUntil: null,
    engagedPostsLeft: null,
    addressedNow: false,
  },
  budget: {
    automaticRepliesLeftInThisRoomThisHour: 41,
    automaticRepliesLeftInTotalThisHour: 187,
    repliesLeftInThisChain: 2,
  },
};

const SAMPLE_UI_STATE = {
  canvas: { open: false, contentType: null },
  panels: { settings: false, tasks: false, relay: false, picker: false },
  sidebar: { open: true, activeTab: 'sessions' },
  agent: { id: 'abc', cwd: '/proj' },
};

describe('CONTEXT_TAG', () => {
  it('has exactly one entry per ContextKind member', () => {
    // Runtime exhaustiveness mirror of the compile-time `satisfies` check.
    expect(Object.keys(CONTEXT_TAG).sort()).toEqual([...ALL_KINDS].sort());
    expect(Object.keys(CONTEXT_TAG)).toHaveLength(ALL_KINDS.length);
  });

  it('maps each kind to a non-empty tag name', () => {
    for (const kind of ALL_KINDS) {
      expect(CONTEXT_TAG[kind]).toBeTypeOf('string');
      expect(CONTEXT_TAG[kind].length).toBeGreaterThan(0);
    }
  });
});

describe('ClientContextSchema', () => {
  it('accepts { uiState, queued: true }', () => {
    const parsed = ClientContextSchema.parse({ uiState: SAMPLE_UI_STATE, queued: true });
    expect(parsed.queued).toBe(true);
    expect(parsed.uiState).toBeDefined();
  });

  it('accepts an empty object (all fields optional)', () => {
    expect(ClientContextSchema.parse({})).toEqual({});
  });

  it('accepts { queued: true } with no uiState', () => {
    expect(ClientContextSchema.parse({ queued: true })).toEqual({ queued: true });
  });

  it('rejects a malformed uiState shape', () => {
    const result = ClientContextSchema.safeParse({ uiState: { canvas: 'nope' } });
    expect(result.success).toBe(false);
  });
});

describe('AdditionalContextEntrySchema', () => {
  it('validates a git_status entry', () => {
    const result = AdditionalContextEntrySchema.safeParse({
      kind: 'git_status',
      scope: 'per-turn',
      data: { isRepo: true, branch: 'main', clean: true },
    });
    expect(result.success).toBe(true);
  });

  it('validates a queue_note entry', () => {
    const result = AdditionalContextEntrySchema.safeParse({
      kind: 'queue_note',
      scope: 'per-turn',
      data: { composedDuringPrevTurn: true },
    });
    expect(result.success).toBe(true);
  });

  it('validates a staged_context entry', () => {
    const result = AdditionalContextEntrySchema.safeParse({
      kind: 'staged_context',
      scope: 'per-turn',
      data: { text: 'Use the staging bucket, not prod.' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a staged_context with empty text', () => {
    // A staged note with nothing in it is a dropped message wearing a receipt —
    // the one outcome the whole feature exists to prevent. It must not parse.
    const result = AdditionalContextEntrySchema.safeParse({
      kind: 'staged_context',
      scope: 'per-turn',
      data: { text: '' },
    });
    expect(result.success).toBe(false);
  });

  it('validates a room_context entry', () => {
    const result = AdditionalContextEntrySchema.safeParse({
      kind: 'room_context',
      scope: 'per-turn',
      data: SAMPLE_ROOM_CONTEXT,
    });
    expect(result.success).toBe(true);
  });

  it('carries a thread turn channel tail through, and still parses without one', () => {
    // Additive and optional (DOR-1207): a turn built before this field existed
    // must keep parsing, and a turn that has one must not have it stripped —
    // Zod drops unknown keys silently, so an entry that parsed to a context with
    // no tail would render as a thread turn that can see nothing but its thread.
    const tailed = AdditionalContextEntrySchema.safeParse({
      kind: 'room_context',
      scope: 'per-turn',
      data: {
        ...SAMPLE_ROOM_CONTEXT,
        thread: { rootEntryId: 'e-1', rootExcerpt: 'the deploy is stuck', replyCount: 2 },
        channelTailOmitted: 3,
        channelTail: [
          {
            authorHandle: null,
            authorDisplayName: 'You',
            authorIsPerson: true,
            authorOrigin: 'local',
            kind: 'post',
            at: '2026-08-13T10:00:00.000Z',
            text: 'standup in five',
            mentionsMe: false,
            topicLabel: null,
            attachments: [],
          },
        ],
      },
    });
    expect(tailed.success).toBe(true);
    const carried =
      tailed.success && tailed.data.kind === 'room_context' ? tailed.data.data : undefined;
    expect(carried?.channelTail).toHaveLength(1);
    // The omitted count travels with it, or an agent is told five messages are
    // the whole channel when eight of them exist.
    expect(carried?.channelTailOmitted).toBe(3);

    const untailed = AdditionalContextEntrySchema.safeParse({
      kind: 'room_context',
      scope: 'per-turn',
      data: SAMPLE_ROOM_CONTEXT,
    });
    expect(untailed.success && untailed.data.kind === 'room_context').toBe(true);
    expect(
      untailed.success && untailed.data.kind === 'room_context'
        ? untailed.data.data.channelTail
        : 'parse failed'
    ).toBeUndefined();
  });

  it('rejects a room_context whose roster does not say person or machine', () => {
    // `isPerson` is the field the whole kind exists for. A roster missing it is
    // a roster an agent cannot act on, so it must not parse.
    const result = AdditionalContextEntrySchema.safeParse({
      kind: 'room_context',
      scope: 'per-turn',
      data: {
        ...SAMPLE_ROOM_CONTEXT,
        members: [{ handle: 'ana', displayName: 'Ana', isSelf: true }],
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown kind', () => {
    const result = AdditionalContextEntrySchema.safeParse({
      kind: 'bogus',
      scope: 'per-turn',
      data: {},
    });
    expect(result.success).toBe(false);
  });
});

describe('SendMessageRequestSchema context wiring (DOR migration)', () => {
  it('accepts { content, context: { uiState, queued: true } }', () => {
    const result = SendMessageRequestSchema.safeParse({
      content: 'hi',
      context: { uiState: SAMPLE_UI_STATE, queued: true },
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.context?.queued).toBe(true);
  });

  it('no longer carries a top-level uiState field (it lives in context)', () => {
    const result = SendMessageRequestSchema.parse({
      content: 'hi',
      uiState: SAMPLE_UI_STATE,
    });
    // The standalone `uiState` key is gone from the schema — Zod strips it.
    expect(result).not.toHaveProperty('uiState');
    expect(result.content).toBe('hi');
  });

  it('accepts a bare content message with no context', () => {
    const result = SendMessageRequestSchema.safeParse({ content: 'hi' });
    expect(result.success).toBe(true);
  });

  it('carries seedContext as its own top-level field, not inside context', () => {
    // Two different things: `context` is structured signals the server renders,
    // `seedContext` is prose a caller wrote for the model. Keeping them apart is
    // what lets the client bag keep its "never pre-formatted prose" rule.
    const result = SendMessageRequestSchema.safeParse({
      content: 'hi',
      seedContext: 'they came from the marketplace page',
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.seedContext).toBe('they came from the marketplace page');
  });

  it('refuses an empty seedContext', () => {
    // Not "inject nothing": the block would still render and still cost the
    // model attention, so a blank one is a caller bug worth naming.
    expect(SendMessageRequestSchema.safeParse({ content: 'hi', seedContext: '' }).success).toBe(
      false
    );
  });

  it('refuses a seedContext past the length bound', () => {
    // The person cannot see this text, so a runaway one is a cost nobody can
    // spot from the UI — the bound is the only thing that notices.
    const tooLong = 'x'.repeat(SEED_CONTEXT_MAX_LENGTH + 1);
    expect(
      SendMessageRequestSchema.safeParse({ content: 'hi', seedContext: tooLong }).success
    ).toBe(false);
    expect(
      SendMessageRequestSchema.safeParse({ content: 'hi', seedContext: tooLong.slice(1) }).success
    ).toBe(true);
  });
});
