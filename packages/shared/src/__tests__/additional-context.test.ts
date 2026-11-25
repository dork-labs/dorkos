import { describe, it, expect } from 'vitest';
import {
  CONTEXT_TAG,
  ClientContextSchema,
  AdditionalContextEntrySchema,
  stripTagBlocks,
  stripInjectedTagBlocks,
} from '../additional-context.js';
import { SendMessageRequestSchema, SEED_CONTEXT_MAX_LENGTH } from '../schemas.js';

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
  triggerEntryId: 'entry-trigger',
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

describe('ClientContextSchema', () => {
  it('rejects a malformed uiState shape', () => {
    const result = ClientContextSchema.safeParse({ uiState: { canvas: 'nope' } });
    expect(result.success).toBe(false);
  });
});

describe('AdditionalContextEntrySchema', () => {
  it('validates an approval_verdict entry, with and without a refusal reason', () => {
    const granted = AdditionalContextEntrySchema.safeParse({
      kind: 'approval_verdict',
      scope: 'per-turn',
      data: {
        approvalId: '01KXQ3P7ADJY9DSXMZW1XGWCV4',
        capabilityTitle: 'Unregister an agent',
        outcome: 'granted',
        endedAt: '2026-09-09T12:34:56.000Z',
      },
    });
    expect(granted.success).toBe(true);

    const denied = AdditionalContextEntrySchema.safeParse({
      kind: 'approval_verdict',
      scope: 'per-turn',
      data: {
        approvalId: '01KXQ3P7ADJY9DSXMZW1XGWCV4',
        capabilityTitle: 'Unregister an agent',
        outcome: 'denied',
        endedAt: '2026-09-09T12:34:56.000Z',
        denyReason: 'that agent is still running the nightly job',
      },
    });
    expect(denied.success).toBe(true);
  });

  it('rejects an approval_verdict whose outcome is not one of the three endings', () => {
    // `consumed` is the one `settle` fires that is NOT delivered: the ordinary
    // grant flow settles twice for one subject, so honoring it would tell an
    // agent about a decision it had already been told about.
    const result = AdditionalContextEntrySchema.safeParse({
      kind: 'approval_verdict',
      scope: 'per-turn',
      data: {
        approvalId: '01KXQ3P7ADJY9DSXMZW1XGWCV4',
        capabilityTitle: 'Unregister an agent',
        outcome: 'consumed',
        endedAt: '2026-09-09T12:34:56.000Z',
      },
    });
    expect(result.success).toBe(false);
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
            id: 'e-2',
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
});

describe('SendMessageRequestSchema context wiring (DOR migration)', () => {
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

describe('stripTagBlocks — the linear replacement for the lazy tag-strip regex', () => {
  // These strips run on message content a caller supplied, so the old
  // `<tag>[\s\S]*?</tag>` form was quadratic on repeated unclosed opens
  // (CodeQL js/polynomial-redos). The rewrite must be behaviour-identical, so
  // every case below is checked against the regex it replaced.
  const legacy = (text: string, tag: string): string =>
    text.replace(new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, 'g'), '');

  it.each([
    ['no tags at all', 'plain text'],
    ['one closed block', 'a<A>inner</A>b'],
    ['two closed blocks', '<A>one</A>middle<A>two</A>tail'],
    ['an unclosed open', '<A>never closed'],
    ['a closed block then an unclosed open', '<A>a</A>b<A>c'],
    ['nested-looking opens', '<A><A>x</A>'],
    ['a truly nested pair', '<A><A>x</A></A>'],
    ['a close with no open', '</A>orphan'],
    ['a close before its open', '</A>x<A>y'],
    ['empty block', '<A></A>'],
    ['a wall of unclosed opens', '<A>'.repeat(50)],
    ['a wall of opens with one close at the end', `${'<A>'.repeat(50)}x</A>`],
  ])('matches the regex it replaced: %s', (_label, input) => {
    expect(stripTagBlocks(input, 'A')).toBe(legacy(input, 'A'));
  });

  it('strips a wall of unclosed opens in linear time', () => {
    // 60k unclosed opens is ~1 MB — what the old lazy regex needed ~1e10
    // character steps for, and what a single POST body can carry.
    const hostile = '<system-reminder>'.repeat(60_000);
    const started = performance.now();
    const result = stripTagBlocks(hostile, 'system-reminder');
    const elapsed = performance.now() - started;
    expect(result).toBe(hostile);
    expect(elapsed).toBeLessThan(100);
  });
});

describe('stripInjectedTagBlocks', () => {
  it('leaves an unclosed open in place, exactly as the regex form did', () => {
    expect(stripInjectedTagBlocks('<system-reminder>hello')).toBe('<system-reminder>hello');
  });

  it('strips every context tag the map defines, so a new kind needs no edit here', () => {
    for (const tag of Object.values(CONTEXT_TAG)) {
      expect(stripInjectedTagBlocks(`<${tag}>x</${tag}>body`)).toBe('body');
    }
  });
});
