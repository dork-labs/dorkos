import { describe, it, expect } from 'vitest';
import { newDispatchId, isDispatchId, DISPATCH_ID_PREFIX } from '../dispatch-id.js';

describe('dispatch id', () => {
  it('mints a prefixed 26-character ULID', () => {
    const id = newDispatchId();
    expect(id.startsWith(DISPATCH_ID_PREFIX)).toBe(true);
    expect(id).toHaveLength(DISPATCH_ID_PREFIX.length + 26);
    expect(isDispatchId(id)).toBe(true);
  });

  it('never repeats', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newDispatchId()));
    expect(ids.size).toBe(1000);
  });

  it('sorts lexicographically into mint order, even within one millisecond', () => {
    // The reason for ULID over UUID: `sort` over a column of these recovers
    // dispatch order. A non-monotonic factory ties inside a millisecond, and a
    // thousand ids are minted far faster than the clock advances — so a tie
    // would show up here as an out-of-order pair.
    const minted = Array.from({ length: 1000 }, () => newDispatchId());
    const sorted = [...minted].sort();
    expect(sorted).toEqual(minted);
  });

  it('rejects anything that is not a well-formed dispatch id', () => {
    // The relay validates an envelope field that arrived from another process;
    // adopting a malformed value would make it a traceId grouping unrelated
    // spans. Each case below is a shape a hostile or buggy producer can send.
    const ulid = newDispatchId().slice(DISPATCH_ID_PREFIX.length);
    expect(isDispatchId('')).toBe(false);
    expect(isDispatchId(ulid)).toBe(false); // no prefix
    expect(isDispatchId(`dsp-${ulid}`)).toBe(false); // wrong separator
    expect(isDispatchId(`dsp_${ulid}extra`)).toBe(false); // too long
    expect(isDispatchId(`dsp_${ulid.slice(1)}`)).toBe(false); // too short
    expect(isDispatchId(`dsp_${'I'.repeat(26)}`)).toBe(false); // I/L/O/U are not in Crockford base32
    expect(isDispatchId(`dsp_${'a'.repeat(26)}`)).toBe(false); // lowercase body
    expect(isDispatchId(`prefix dsp_${ulid}`)).toBe(false); // not anchored at the start
    expect(isDispatchId(`dsp_${ulid}\n`)).toBe(false); // a trailing newline is not a valid id
  });
});
