/** Shared fixtures for the useDocChannel tests: frames, replay pages and the transport wrapper. */
import { act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect } from 'vitest';
import type { Transport } from '@dorkos/shared/transport';
import type {
  CanvasChannelEventReceipt,
  CanvasChannelFrame,
  CanvasChannelReplayResponse,
} from '@dorkos/shared/canvas-channel-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { ownDocChannelConnection } from '@/layers/shared/lib/transport/doc-channel-ownership';
export let testOwner: Transport;
/** Point the doc-channel publisher at another transport, as a test's own wrapper does. */
export function setTestOwner(owner: Transport) {
  testOwner = owner;
}

export const birth = {
  v: 1 as const,
  documentId: 'doc-1',
  physicalOpenedAt: '2026-10-01T00:00:00.000Z',
  channelCreatedAt: '2026-10-01T00:00:00.000Z',
  generation: 'a'.repeat(64),
};
export function publishDocChannelNotification(value: unknown, owner: Transport = testOwner) {
  return ownDocChannelConnection(owner, new AbortController().signal).publish(value);
}

export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export function receipt(seq: number): CanvasChannelEventReceipt {
  return { receipt: { id: id(seq), status: 'recorded', docSeq: seq }, deliveries: [] };
}
export function frame(seq: number, documentId = 'doc-1'): CanvasChannelFrame {
  return {
    type: 'canvas_event',
    incarnation: { ...birth, documentId },
    scope: 'session:server-canonical',
    documentId,
    docSeq: seq,
    event: {
      id: id(seq),
      type: 'app.updated',
      payload: { count: seq },
      direction: 'downstream',
      receivedAt: '2026-10-01T00:00:00.000Z',
    },
  };
}
export function replay(
  patch: Partial<CanvasChannelReplayResponse> = {}
): CanvasChannelReplayResponse {
  return {
    incarnation: birth,
    routing: { enabled: true, approvedEventTypes: ['app.updated'], destinationLabel: 'DorkBot' },
    events: [],
    state: {},
    stateRev: 0,
    highWatermark: 0,
    retentionFloor: 1,
    receiptRetentionFloor: 1,
    resetRequired: false,
    health: { status: 'ready', reasons: [] },
    receipts: [],
    ...patch,
  };
}
export function snapshot(response: CanvasChannelReplayResponse, documentId = 'doc-1') {
  const { events: _events, ...value } = response;
  return {
    type: 'canvas_channel_snapshot' as const,
    scope: 'session:new-canonical',
    documentId,
    snapshot: value,
  };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export function wrapper(transport: Transport) {
  testOwner = transport;
  return ({ children }: { children: ReactNode }) => (
    <TransportProvider transport={transport}>{children}</TransportProvider>
  );
}
export async function publish(value: unknown) {
  await act(async () => {
    expect(publishDocChannelNotification(value)).toBe(true);
  });
}

/** Match production replay's strict >since filter and floor-only reset rule. */
export function serverReplay(
  incarnation: typeof birth,
  highWatermark: number,
  since: number,
  retentionFloor = 1,
  legacy = false
): CanvasChannelReplayResponse {
  const resetRequired = since < retentionFloor - 1;
  const cursor = resetRequired ? retentionFloor - 1 : since;
  const events = Array.from(
    { length: Math.min(200, Math.max(0, highWatermark - cursor)) },
    (_, index) => {
      const seq = cursor + index + 1;
      const event: CanvasChannelFrame = { ...frame(seq), incarnation };
      event.event = {
        ...event.event,
        id: id(seq + (incarnation.generation === birth.generation ? 0 : 10000)),
      };
      if (legacy) delete event.incarnation;
      return event;
    }
  );
  // All fixture rows are completed: reset receipts use production's descending sequence order.
  const receiptSeqs = resetRequired
    ? Array.from({ length: Math.min(200, highWatermark) }, (_, index) => highWatermark - index)
    : events.map((event) => event.docSeq);
  const receipts = receiptSeqs.map((seq): CanvasChannelEventReceipt => ({
    receipt: {
      id: id(seq + (incarnation.generation === birth.generation ? 0 : 10000)),
      status: 'recorded',
      docSeq: seq,
    },
    deliveries: [],
  }));
  const response = replay({
    incarnation,
    events,
    receipts,
    highWatermark,
    retentionFloor,
    resetRequired,
  });
  if (legacy) delete response.incarnation;
  return response;
}
