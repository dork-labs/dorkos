/**
 * The relay's "did this turn produce anything" predicate answers exactly what
 * the server's does (DOR-1774). `@dorkos/relay` cannot import the canonical
 * `isContentEvent`, and a binding written for a turn that only errored is
 * permanent, so the pin lives here, over every `StreamEventTypeSchema` member.
 */
import { describe, it, expect } from 'vitest';
import { isTurnContentEvent } from '@dorkos/relay';
import { StreamEventTypeSchema } from '@dorkos/shared/schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { isContentEvent } from '../../runtimes/shared/empty-stream-guard.js';

describe('the relay mirrors the server’s content-event rule', () => {
  it('agrees on every stream event type, and counts what a person can see', () => {
    const events = [
      ...StreamEventTypeSchema.options.map((type) => ({ type, data: {} })),
      // Compact boundaries are decided by their trigger, not their type.
      { type: 'compact_boundary', data: { trigger: 'manual' } },
      { type: 'compact_boundary', data: { trigger: 'auto' } },
    ] as unknown as StreamEvent[];
    expect(events.length).toBeGreaterThan(2);
    expect(events.filter((e) => isTurnContentEvent(e) !== isContentEvent(e))).toEqual([]);
    // Two predicates false for everything would agree too.
    expect(isTurnContentEvent({ type: 'text_delta', data: { text: 'hi' } } as StreamEvent)).toBe(
      true
    );
    expect(isTurnContentEvent({ type: 'error', data: { message: 'no' } } as StreamEvent)).toBe(
      false
    );
  });
});
