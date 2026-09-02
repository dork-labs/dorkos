/**
 * The one case the two dispatch paths' compaction tests cannot reach: a
 * boundary the SDK sent with no `compact_metadata` at all. The schema lets that
 * validate as `{}` (DOR-108), so `trigger` is simply absent — and the guard has
 * to decide what an unlabelled boundary means. It fails closed: without the
 * label there is no evidence the compaction was what the person asked for, and
 * a turn that produced nothing else is still reported as silent.
 *
 * Manual vs auto is pinned end-to-end instead, through the real mapper on both
 * paths — `claude-code-runtime.test.ts` and `sessions/__tests__/persistent-dispatch.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { BLOCKING_INTERACTION_EVENT_TYPES } from '@dorkos/shared/session-stream';
import { isContentEvent, isInteractiveEvent } from '../empty-stream-guard.js';

describe('isContentEvent', () => {
  it('does not accept a compaction boundary that carries no metadata', () => {
    expect(isContentEvent({ type: 'compact_boundary', data: {} })).toBe(false);
  });

  // DOR-1664: a tool result whose only block is an image maps to NO
  // `tool_result` event — there is no text to put in one — so a turn whose
  // whole product was a picture reached this guard with nothing else to show
  // for itself. Counting the picture is what stops the guard putting "the
  // agent did not respond" underneath the image it just drew.
  it('accepts a picture the turn produced', () => {
    expect(
      isContentEvent({
        type: 'image_attachment',
        data: { attachmentId: 'a', url: '/api/x.png', mediaType: 'image/png', size: 10 },
      })
    ).toBe(true);
  });
});

describe('isInteractiveEvent', () => {
  // DOR-1240: this guard used to keep its own two-member literal
  // (`approval_required`, `question_prompt`) instead of deriving from the
  // canonical `BLOCKING_INTERACTION_EVENT_TYPES` — silently missing
  // `elicitation_prompt`, which `interactive-handlers.ts` pushes onto
  // `session.eventQueue` exactly like the other two. Pinning every member of
  // the shared list here means a THIRD hand-kept copy can never reappear
  // without this test going red first.
  it.each(BLOCKING_INTERACTION_EVENT_TYPES)(
    'accepts every blocking-interaction type: %s',
    (type) => {
      expect(isInteractiveEvent({ type, data: {} } as never)).toBe(true);
    }
  );

  it('rejects a plain content event', () => {
    expect(isInteractiveEvent({ type: 'text_delta', data: {} } as never)).toBe(false);
  });
});
