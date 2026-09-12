import { describe, it, expect } from 'vitest';
import { RoomEventSchema, RoomSignalEventSchema } from '../room-schemas.js';
import { SignalTypeSchema } from '../relay-envelope-schemas.js';

/** Everything a signal frame needs before a payload is added to it. */
const base = {
  type: 'signal' as const,
  signal: 'presence' as const,
  authorId: '01JZANA',
  at: '2026-09-12T10:00:00.000Z',
};

describe('SignalTypeSchema', () => {
  it('still holds exactly the relay’s six names', () => {
    // Follow mode reuses `presence` rather than minting a name, because
    // `specs/rooms/02-specification.md:229` forbids one. The easy mistake is to
    // add `follow` here, so the member list is asserted rather than described.
    expect(SignalTypeSchema.options).toEqual([
      'typing',
      'presence',
      'read_receipt',
      'delivery_receipt',
      'progress',
      'backpressure',
    ]);
  });
});

describe('RoomSignalEventSchema follow payloads', () => {
  it('parses a presence frame carrying a follow position', () => {
    const parsed = RoomSignalEventSchema.parse({
      ...base,
      view: { documentId: '01JZDOC', url: 'http://localhost:5173/', scrollY: 240 },
    });
    expect(parsed.view).toEqual({
      documentId: '01JZDOC',
      url: 'http://localhost:5173/',
      scrollY: 240,
    });
  });

  it('parses a presence frame opening and closing a follow claim', () => {
    expect(RoomSignalEventSchema.parse({ ...base, follows: '01JZKAI' }).follows).toBe('01JZKAI');
    expect(RoomSignalEventSchema.parse({ ...base, follows: null }).follows).toBeNull();
  });

  it('refuses a frame carrying both a view and an agent’s work state', () => {
    const result = RoomSignalEventSchema.safeParse({
      ...base,
      view: { documentId: '01JZDOC' },
      state: 'working',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('one payload');
  });

  it('refuses every pair of payloads, and not only the ones follow mode added', () => {
    // Four payloads ride this one verb: an agent's work claim, a follow
    // position, a follow claim, and which canvas tab somebody is on. The rule
    // is ONE per frame, so the test is every pair rather than the two that
    // were on hand when it was written.
    const payloads = {
      state: 'working',
      view: { documentId: '01JZDOC' },
      follows: '01JZKAI',
      documentId: '01JZDOC',
    } as const;
    const names = Object.keys(payloads) as Array<keyof typeof payloads>;
    for (const a of names) {
      for (const b of names) {
        if (a >= b) continue;
        const result = RoomSignalEventSchema.safeParse({
          ...base,
          [a]: payloads[a],
          [b]: payloads[b],
        });
        expect(result.success, `${a} + ${b} must be refused`).toBe(false);
      }
    }
    // …and all four at once, which is the case a pairwise loop alone could miss
    // if the rule were written as a chain of two-way checks.
    expect(RoomSignalEventSchema.safeParse({ ...base, ...payloads }).success).toBe(false);
  });

  it('accepts each payload on its own', () => {
    expect(RoomSignalEventSchema.safeParse({ ...base, documentId: '01JZDOC' }).success).toBe(true);
    expect(
      RoomSignalEventSchema.safeParse({ ...base, view: { documentId: '01JZDOC' } }).success
    ).toBe(true);
    expect(RoomSignalEventSchema.safeParse({ ...base, follows: '01JZKAI' }).success).toBe(true);
    // A `presence` frame with nothing on it at all is the "looked away" half of
    // the tab-presence statement, and stays legal.
    expect(RoomSignalEventSchema.safeParse(base).success).toBe(true);
  });

  it('refuses a view on any signal that is not presence', () => {
    for (const signal of ['typing', 'progress', 'read_receipt'] as const) {
      const result = RoomSignalEventSchema.safeParse({
        ...base,
        signal,
        view: { documentId: '01JZDOC' },
      });
      expect(result.success, `\`view\` must not ride a ${signal} signal`).toBe(false);
    }
  });

  it('refuses a follow claim on any signal that is not presence', () => {
    expect(
      RoomSignalEventSchema.safeParse({ ...base, signal: 'progress', follows: '01JZKAI' }).success
    ).toBe(false);
  });

  it('still parses every frame the room already published', () => {
    expect(
      RoomSignalEventSchema.safeParse({
        ...base,
        signal: 'progress',
        state: 'working',
        entryId: '01JZENTRY',
        since: base.at,
      }).success
    ).toBe(true);
    expect(RoomSignalEventSchema.safeParse({ ...base, signal: 'typing' }).success).toBe(true);
  });

  it('reaches the room stream union with its payloads intact', () => {
    const parsed = RoomEventSchema.parse({ ...base, view: { documentId: '01JZDOC' } });
    expect(parsed.type).toBe('signal');
    expect(parsed.type === 'signal' && parsed.view?.documentId).toBe('01JZDOC');
    expect(RoomEventSchema.safeParse({ ...base, signal: 'typing', follows: 'x' }).success).toBe(
      false
    );
  });
});
