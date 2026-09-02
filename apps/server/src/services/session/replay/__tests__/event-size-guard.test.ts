/**
 * @vitest-environment node
 *
 * The byte budget the session stream never had. Two halves: one event may not
 * be arbitrarily large, and the replay buffers are bounded in bytes as well as
 * in entries.
 */
import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import {
  MAX_EVENT_STRING_BYTES,
  RING_BUFFER_MAX_BYTES,
  eventByteSize,
  guardEventSize,
} from '../event-size-guard.js';
import { RingBuffer } from '../ring-buffer.js';
import { EventLog } from '../event-log.js';

/** A `text_delta` of a given size, the cheapest way to make a large event. */
function textEvent(seq: number, length: number): SessionEvent {
  return { seq, type: 'text_delta', text: 'x'.repeat(length) };
}

describe('guardEventSize', () => {
  it('returns a within-budget event by reference — the hot path allocates nothing', () => {
    const event = textEvent(1, 10);
    expect(guardEventSize(event)).toBe(event);
  });

  it('replaces an oversized string with a stated omission, not a silent truncation', () => {
    const guarded = guardEventSize(textEvent(1, MAX_EVENT_STRING_BYTES + 1));

    expect(guarded.type).toBe('text_delta');
    const text = (guarded as Extract<SessionEvent, { type: 'text_delta' }>).text;
    expect(text).toMatch(/bytes omitted/);
    // The reader is told, in the stream, exactly how much went missing.
    expect(text).toContain((MAX_EVENT_STRING_BYTES + 1).toLocaleString('en-US'));
  });

  it('keeps the type, the seq and every id intact, so nothing downstream is stranded', () => {
    const event: SessionEvent = {
      seq: 7,
      type: 'tool_result',
      toolCallId: 'call_1',
      toolName: 'bash',
      result: 'y'.repeat(MAX_EVENT_STRING_BYTES + 1),
      status: 'complete',
    };

    const guarded = guardEventSize(event) as Extract<SessionEvent, { type: 'tool_result' }>;

    expect(guarded.type).toBe('tool_result');
    expect(guarded.seq).toBe(7);
    expect(guarded.toolCallId).toBe('call_1');
    expect(guarded.toolName).toBe('bash');
    expect(guarded.result).toMatch(/bytes omitted/);
  });

  it('leaves an image_attachment alone — it is a reference, which is the point', () => {
    const event: SessionEvent = {
      seq: 3,
      type: 'image_attachment',
      attachmentId: 'abc',
      url: '/api/sessions/s/attachments/abc.png',
      mediaType: 'image/png',
      size: 2_000_000,
    };
    expect(guardEventSize(event)).toBe(event);
    expect(eventByteSize(event)).toBeLessThan(500);
  });
});

describe('RingBuffer byte cap', () => {
  it('evicts by BYTES as well as by count', () => {
    const ring = new RingBuffer();
    ring.markTurnStarted();
    // Each event is ~1 MiB, so nine of them pass the 8 MiB budget long before
    // the 200-event count cap could bite.
    for (let seq = 1; seq <= 9; seq++) ring.append(textEvent(seq, 1024 * 1024));

    const retained = ring.replayFrom(0);
    expect(retained.length).toBeLessThan(9);
    const bytes = retained.reduce((total, event) => total + eventByteSize(event), 0);
    expect(bytes).toBeLessThanOrEqual(RING_BUFFER_MAX_BYTES);
    // The newest survives — a client falling behind loses the OLDEST, which is
    // the outcome the replay contract already defines.
    expect(retained.at(-1)?.seq).toBe(9);
  });

  it('never evicts the event just appended, however large it is', () => {
    const ring = new RingBuffer();
    ring.markTurnStarted();
    ring.append(textEvent(1, RING_BUFFER_MAX_BYTES + 1024));

    expect(ring.replayFrom(0)).toHaveLength(1);
  });

  it('resets its byte total when a new turn starts', () => {
    const ring = new RingBuffer();
    ring.markTurnStarted();
    for (let seq = 1; seq <= 6; seq++) ring.append(textEvent(seq, 1024 * 1024));
    ring.markTurnStarted();
    ring.append(textEvent(7, 1024 * 1024));

    // With a stale byte total the fresh turn's single event would be evicted
    // immediately by a budget it never spent.
    expect(ring.replayFrom(0)).toHaveLength(1);
  });
});

describe('EventLog byte cap', () => {
  it('trims by BYTES as well as by count, keeping the newest', () => {
    const log = new EventLog();
    for (let seq = 1; seq <= 40; seq++) log.append(textEvent(seq, 1024 * 1024));

    const retained = log.replayFrom(0);
    expect(retained.length).toBeLessThan(40);
    expect(retained.at(-1)?.seq).toBe(40);
  });
});
