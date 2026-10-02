/** Channel notifications cannot enter transcript sequence or room entry cursor space. */
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { SessionEventSchema, SessionWireEventSchema } from '../session-stream.js';
import { RoomEventSchema } from '../room-schemas.js';
const notification = {
  type: 'canvas_event',
  scope: 'session:idle',
  documentId: 'document',
  docSeq: 9,
  event: {
    id: randomUUID(),
    type: 'state.changed',
    payload: { stateRev: 2 },
    direction: 'system',
    receivedAt: '2026-10-01T12:00:00.000Z',
  },
};
it('accepts document notifications without creating a durable session event sequence', () => {
  expect(SessionWireEventSchema.parse(notification)).toEqual(notification);
  expect(SessionEventSchema.safeParse(notification).success).toBe(false);
  expect(SessionWireEventSchema.safeParse({ ...notification, seq: 12 }).success).toBe(false);
});
it('accepts room notifications without a room entry cursor or private identities', () => {
  expect(RoomEventSchema.parse({ ...notification, scope: 'room:one' })).toEqual({
    ...notification,
    scope: 'room:one',
  });
  expect(RoomEventSchema.safeParse({ ...notification, seq: 12 }).success).toBe(false);
  expect(RoomEventSchema.safeParse({ ...notification, viewerId: 'private' }).success).toBe(false);
});

it('carries current channel state without a scope cursor or editable content', () => {
  const snapshot = {
    type: 'canvas_channel_snapshot',
    scope: 'session:one',
    documentId: 'doc',
    snapshot: {
      state: { answer: true },
      stateRev: 2,
      highWatermark: 4,
      retentionFloor: 1,
      receiptRetentionFloor: 1,
      resetRequired: false,
      health: { status: 'ready', reasons: [] },
      receipts: [],
    },
  };
  expect(SessionWireEventSchema.safeParse(snapshot).success).toBe(true);
  expect(RoomEventSchema.safeParse(snapshot).success).toBe(true);
  expect(SessionWireEventSchema.safeParse({ ...snapshot, seq: 10 }).success).toBe(false);
  expect(RoomEventSchema.safeParse({ ...snapshot, entrySeq: 10 }).success).toBe(false);
});
