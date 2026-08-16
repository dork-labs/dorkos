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
import { isContentEvent } from '../empty-stream-guard.js';

describe('isContentEvent', () => {
  it('does not accept a compaction boundary that carries no metadata', () => {
    expect(isContentEvent({ type: 'compact_boundary', data: {} })).toBe(false);
  });
});
