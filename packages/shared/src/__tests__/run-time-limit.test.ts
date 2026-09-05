import { describe, expect, it } from 'vitest';
import { runTimeLimitError } from '../run-time-limit.js';

/**
 * The sentence itself is the contract here, so both branches are asserted as
 * FULL literals rather than by shape or substring.
 *
 * The direct-dispatch path's own suite checks its run row with
 * `toContain('time limit')`, which a jargon rewrite walks straight through —
 * "TTL budget expired: 5m time limit" contains it and the server suite stays
 * green. This file is where that wording is actually pinned, for the path that
 * names a duration as well as the one that cannot (DOR-1786).
 */
describe('runTimeLimitError', () => {
  it('names the limit when the caller knows it — the direct-dispatch path', () => {
    expect(runTimeLimitError('5m')).toBe('Run stopped after passing its 5m time limit');
  });

  it('says the same thing without a number when the caller has none — the relay path', () => {
    expect(runTimeLimitError()).toBe('Run stopped after passing its time limit');
  });

  it('carries the duration through exactly as it was formatted', () => {
    // The formatter is the server's (`apps/server/src/lib/format-duration.ts`)
    // and its output travels verbatim: this must never re-format, abbreviate or
    // re-punctuate what a person set.
    expect(runTimeLimitError('1h 30m')).toBe('Run stopped after passing its 1h 30m time limit');
  });
});
