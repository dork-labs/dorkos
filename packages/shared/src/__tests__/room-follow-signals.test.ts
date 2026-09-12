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

  it('refuses a frame carrying both a view and a follow claim', () => {
    expect(
      RoomSignalEventSchema.safeParse({
        ...base,
        view: { documentId: '01JZDOC' },
        follows: '01JZKAI',
      }).success
    ).toBe(false);
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
