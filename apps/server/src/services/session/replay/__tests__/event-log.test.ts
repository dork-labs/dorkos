import { describe, it, expect } from 'vitest';
import { EventLog, EVENT_LOG_MAX_EVENTS } from '../event-log.js';
import type { SessionEvent } from '@dorkos/shared/session-stream';

/** Build a minimal text_delta event with the given seq for log tests. */
function textEvent(seq: number): SessionEvent {
  return { seq, type: 'text_delta', text: `t${seq}` } as SessionEvent;
}

describe('EventLog', () => {
  // Failure mode: gap replay over the ring's eviction horizon falls back to the
  // log; replayFrom must remain strictly exclusive there too.
  it('replayFrom returns only events with seq strictly greater than the cursor', () => {
    const log = new EventLog();
    [1, 2, 3].forEach((s) => log.append(textEvent(s)));
    expect(log.replayFrom(1).map((e) => e.seq)).toEqual([2, 3]);
    expect(log.replayFrom(3)).toEqual([]);
  });

  // Failure mode: an unbounded log grows without limit on a long-lived session;
  // appends past the cap trim the oldest entries while preserving order.
  it('trims the oldest events past the cap, preserving order', () => {
    const log = new EventLog();
    for (let i = 1; i <= EVENT_LOG_MAX_EVENTS + 3; i++) {
      log.append(textEvent(i));
    }
    const all = log.replayFrom(0);
    expect(all).toHaveLength(EVENT_LOG_MAX_EVENTS);
    expect(all[0]?.seq).toBe(4);
    expect(all.at(-1)?.seq).toBe(EVENT_LOG_MAX_EVENTS + 3);
  });
});
