/**
 * The relay's "did this turn produce anything" predicate answers exactly what
 * the server's does (DOR-1774).
 *
 * There are two copies of that rule and there has to be: the canonical one is
 * `isContentEvent` in the claude-code empty-stream guard, and `@dorkos/relay`
 * sits below `apps/server` so it cannot import it. The relay needs the same
 * answer because it decides whether a turn earns a runtime binding — and a
 * binding written for a turn that only ERRORED is permanent, since an
 * agent-to-agent conversation is keyed by the agent id alone and
 * `persistSessionRuntime` is first-write-wins.
 *
 * `apps/server` is the one place that can see both, so the pin lives here. It
 * walks every member of `StreamEventTypeSchema` rather than a hand-listed set,
 * so a stream event type added to the product joins this test automatically and
 * a type classified in one copy but not the other reds it.
 *
 * Both sides are read from SOURCE (`vitest.config.ts` aliases `@dorkos/relay`),
 * which is the whole point: measured against a stale `dist/`, a divergence in
 * relay `src/` passes here.
 *
 * @module server/services/relay/__tests__/relay-content-event-parity
 */
import { describe, it, expect } from 'vitest';
import { isTurnContentEvent } from '@dorkos/relay';
import { StreamEventTypeSchema } from '@dorkos/shared/schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { isContentEvent } from '../../runtimes/claude-code/messaging/empty-stream-guard.js';

describe('the relay mirrors the server’s content-event rule', () => {
  it('agrees on every stream event type the product has', () => {
    // Says how much it scanned. A schema that resolved to an empty option list
    // would make the assertion below pass while checking nothing at all.
    expect(StreamEventTypeSchema.options.length).toBeGreaterThan(0);

    const disagreements = StreamEventTypeSchema.options.filter((type) => {
      const event = { type, data: {} } as StreamEvent;
      return isTurnContentEvent(event) !== isContentEvent(event);
    });

    expect(disagreements).toEqual([]);
  });

  it('agrees on both compact boundaries, which are decided by their trigger', () => {
    // The one member neither copy can answer from its type alone: a manual
    // boundary IS the product of a `/compact` turn, an auto one fired
    // incidentally and leaves the turn still owing an answer. Walking the type
    // list above cannot reach this, because it builds every event with `{}`.
    for (const trigger of ['manual', 'auto']) {
      const event = { type: 'compact_boundary', data: { trigger } } as unknown as StreamEvent;
      expect(isTurnContentEvent(event)).toBe(isContentEvent(event));
    }
  });

  it('counts the things a person can see, so the pin above is not vacuously true', () => {
    // Two predicates that both answered `false` for everything would satisfy
    // every assertion above. This is what makes the parity mean something.
    expect(isTurnContentEvent({ type: 'text_delta', data: { text: 'hi' } } as StreamEvent)).toBe(
      true
    );
    expect(isTurnContentEvent({ type: 'error', data: { message: 'no' } } as StreamEvent)).toBe(
      false
    );
    expect(isTurnContentEvent({ type: 'done', data: {} } as StreamEvent)).toBe(false);
  });
});
