import { describe, it, expect, vi } from 'vitest';
import {
  CanvasDocIncarnationSchema,
  CanvasDocHandshakeSchema,
  CanvasDocCommandSchema,
  CanvasDocResultSchema,
  parseCanvasDocWire,
  sameCanvasDocIncarnation,
} from '../canvas-doc-frame-wire.js';
const birth = {
  v: 1 as const,
  documentId: 'doc',
  physicalOpenedAt: '2026-10-02T00:00:00Z',
  channelCreatedAt: '2026-10-02T00:00:01Z',
  generation: 'a'.repeat(64),
};
const correlation = {
  protocol: 'dorkos-doc',
  v: 1,
  nonce: 'nonce',
  requestToken: 'request',
  loadToken: 1,
  generation: birth.generation,
};
describe('strict Doc wire', () => {
  it('requires all server birth fields and rejects legacy/authority additions', () => {
    expect(CanvasDocIncarnationSchema.safeParse(birth).success).toBe(true);
    for (const field of Object.keys(birth)) {
      const copy = { ...birth };
      delete copy[field as keyof typeof copy];
      expect(CanvasDocIncarnationSchema.safeParse(copy).success).toBe(false);
    }
    expect(CanvasDocIncarnationSchema.safeParse({ ...birth, scope: 'room' }).success).toBe(false);
    expect(
      CanvasDocIncarnationSchema.safeParse({ ...birth, generation: 'A'.repeat(64) }).success
    ).toBe(false);
  });
  it('compares timestamps as well as generation without minting authority', () => {
    expect(sameCanvasDocIncarnation(birth, { ...birth })).toBe(true);
    expect(
      sameCanvasDocIncarnation(birth, { ...birth, channelCreatedAt: '2026-10-02T00:00:02Z' })
    ).toBe(false);
  });
  it.each(['challenge', 'ack', 'connect'])('admits only correlated %s', (kind) => {
    expect(parseCanvasDocWire(CanvasDocHandshakeSchema, { ...correlation, kind })).not.toBeNull();
    for (const addition of [
      { scope: 'room' },
      { protocol: 'devtools' },
      { loadToken: -1 },
      { nonce: '' },
      { generation: 'bad' },
    ])
      expect(
        parseCanvasDocWire(CanvasDocHandshakeSchema, { ...correlation, kind, ...addition })
      ).toBeNull();
  });
  it('does not execute hostile accessors and bounds raw metadata', () => {
    let reads = 0;
    const value = { ...correlation, kind: 'ack' };
    Object.defineProperty(value, 'nonce', {
      enumerable: true,
      get() {
        reads++;
        return 'nonce';
      },
    });
    expect(parseCanvasDocWire(CanvasDocHandshakeSchema, value)).toBeNull();
    expect(reads).toBe(0);
    expect(
      parseCanvasDocWire(CanvasDocHandshakeSchema, {
        ...correlation,
        kind: 'ack',
        unknown: 'x'.repeat(1_048_577),
      })
    ).toBeNull();
  });
  it('rejects public authority fields and separates durable receipt from status', () => {
    const event = {
      v: 1,
      id: '00000000-0000-4000-8000-000000000001',
      type: 'save',
      payload: { x: 1 },
    };
    expect(
      parseCanvasDocWire(CanvasDocCommandSchema, {
        ...correlation,
        kind: 'emit',
        requestId: event.id,
        event,
      })
    ).not.toBeNull();
    expect(
      parseCanvasDocWire(CanvasDocCommandSchema, {
        ...correlation,
        kind: 'emit',
        requestId: event.id,
        event: { ...event, expectedGeneration: birth.generation },
      })
    ).toBeNull();
    expect(
      parseCanvasDocWire(CanvasDocResultSchema, {
        ...correlation,
        kind: 'status',
        status: 'ready',
        unconfirmed: false,
      })
    ).not.toBeNull();
    expect(
      parseCanvasDocWire(CanvasDocResultSchema, {
        ...correlation,
        kind: 'status',
        status: 'saved',
        unconfirmed: false,
      })
    ).toBeNull();
  });
  it('compares every original birth field without reducing identity to document ID or hash', () => {
    for (const change of [
      { documentId: 'replacement' },
      { physicalOpenedAt: '2026-10-02T00:00:02Z' },
      { channelCreatedAt: '2026-10-02T00:00:03Z' },
      { generation: 'b'.repeat(64) },
    ])
      expect(sameCanvasDocIncarnation(birth, { ...birth, ...change })).toBe(false);
  });
  it.each(['wire-first', 'channel-first'] as const)(
    'initializes cold %s imports through the same neutral schema',
    async (order) => {
      vi.resetModules();
      if (order === 'wire-first') await import('../canvas-doc-frame-wire.js');
      else await import('../canvas-channel-schemas.js');
      const wire = await import('../canvas-doc-frame-wire.js');
      const channel = await import('../canvas-channel-schemas.js');
      const neutral = await import('../canvas-doc-incarnation.js');
      expect(wire.CanvasDocIncarnationSchema).toBe(neutral.CanvasDocIncarnationSchema);
      expect(channel.CanvasDocIncarnationSchema).toBe(neutral.CanvasDocIncarnationSchema);
      expect(wire.sameCanvasDocIncarnation).toBe(channel.sameCanvasDocIncarnation);
      expect(channel.CanvasDocIncarnationSchema.parse(birth)).toEqual(birth);
      const snapshotFrame = {
        type: 'canvas_channel_snapshot',
        scope: 'session',
        documentId: birth.documentId,
        snapshot: {
          incarnation: birth,
          routing: { enabled: false, approvedEventTypes: [], destinationLabel: 'Document' },
          state: {},
          stateRev: 0,
          highWatermark: 0,
          retentionFloor: 0,
          receiptRetentionFloor: 0,
          resetRequired: false,
          health: { status: 'ready', reasons: [] },
          receipts: [],
        },
      };
      expect(channel.CanvasChannelSnapshotFrameSchema.parse(snapshotFrame)).toEqual(snapshotFrame);
      expect(channel.CanvasChannelNotificationSchema.parse(snapshotFrame)).toEqual(snapshotFrame);
      expect(
        channel.CanvasChannelNotificationSchema.safeParse({
          ...snapshotFrame,
          snapshot: { ...snapshotFrame.snapshot, incarnation: undefined },
        }).success
      ).toBe(false);
      expect(wire.CanvasDocHandshakeSchema.safeParse({ ...correlation, kind: 'ack' }).success).toBe(
        true
      );
    }
  );
});
