import type { CanvasChannelNotification } from '@dorkos/shared/canvas-channel-schemas';

export const DOC_EVENT = {
  type: 'canvas_event',
  scope: 'session:canonical',
  documentId: 'doc-1',
  docSeq: 900,
  event: {
    id: '00000000-0000-4000-8000-000000000001',
    type: 'app.updated',
    payload: { label: 'ready' },
    direction: 'downstream',
    receivedAt: '2026-10-01T00:00:00.000Z',
  },
} satisfies CanvasChannelNotification;
export const DOC_SNAPSHOT = {
  type: 'canvas_channel_snapshot',
  scope: DOC_EVENT.scope,
  documentId: DOC_EVENT.documentId,
  snapshot: {
    state: {},
    stateRev: 0,
    highWatermark: 900,
    retentionFloor: 1,
    receiptRetentionFloor: 1,
    resetRequired: false,
    health: { status: 'ready', reasons: [] },
    receipts: [],
  },
} satisfies CanvasChannelNotification;
