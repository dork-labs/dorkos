// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type {
  CanvasChannelEventReceipt,
  CanvasChannelFrame,
  CanvasChannelReplayResponse,
  PageEvent,
} from '@dorkos/shared/canvas-channel-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { publishDocChannelNotification } from '@/layers/shared/lib/transport';
import { useDocChannel } from '../model/use-doc-channel';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function receipt(seq: number): CanvasChannelEventReceipt {
  return { receipt: { id: id(seq), status: 'recorded', docSeq: seq }, deliveries: [] };
}
function frame(seq: number, documentId = 'doc-1'): CanvasChannelFrame {
  return {
    type: 'canvas_event',
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
function replay(patch: Partial<CanvasChannelReplayResponse> = {}): CanvasChannelReplayResponse {
  return {
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
function snapshot(response: CanvasChannelReplayResponse, documentId = 'doc-1') {
  const { events: _events, ...value } = response;
  return {
    type: 'canvas_channel_snapshot' as const,
    scope: 'session:new-canonical',
    documentId,
    snapshot: value,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function wrapper(transport: Transport) {
  return ({ children }: { children: ReactNode }) => (
    <TransportProvider transport={transport}>{children}</TransportProvider>
  );
}
async function publish(value: unknown) {
  await act(async () => {
    expect(publishDocChannelNotification(value)).toBe(true);
  });
}

describe('useDocChannel on the existing scope stream', () => {
  it('attaches a disabled port during loading and enables only server-approved routing', async () => {
    const transport = createMockTransport();
    const initial = deferred<CanvasChannelReplayResponse>();
    vi.mocked(transport.getCanvasChannel).mockReturnValue(initial.promise);
    const { result, unmount } = renderHook(() => useDocChannel('doc-1'), {
      wrapper: wrapper(transport),
    });
    try {
      expect(result.current.channel).toMatchObject({
        documentId: 'doc-1',
        enabled: false,
        approvedEventTypes: [],
        destinationLabel: 'Actions unavailable',
      });
      expect(result.current.channel.submit).toEqual(expect.any(Function));
      expect(transport.getCanvasChannel).toHaveBeenCalledWith('doc-1', { since: 0, limit: 200 });
      await act(async () => initial.resolve(replay({ routing: undefined })));
      expect(result.current.channel.enabled).toBe(false);
      await publish(snapshot(replay()));
      expect(result.current.channel).toMatchObject({
        documentId: 'doc-1',
        enabled: true,
        approvedEventTypes: ['app.updated'],
        destinationLabel: 'DorkBot',
      });
      await publish(
        snapshot(
          replay({
            routing: {
              enabled: false,
              approvedEventTypes: [],
              destinationLabel: 'Approval needed',
            },
          })
        )
      );
      expect(result.current.channel.enabled).toBe(false);
      expect(transport.subscribeSession).not.toHaveBeenCalled();
      expect(transport.subscribeRoom).not.toHaveBeenCalled();
    } finally {
      unmount();
    }
  });

  it('keeps physical identity through state/receipt changes and sends the exact frozen envelope', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getCanvasChannel).mockResolvedValue(replay());
    const { result, unmount } = renderHook(() => useDocChannel('doc-1'), {
      wrapper: wrapper(transport),
    });
    try {
      await waitFor(() => expect(result.current.channel.enabled).toBe(true));
      const event: PageEvent = {
        v: 1,
        id: id(1),
        type: 'app.updated',
        payload: { text: 'draft' },
        coalesceKey: 'field',
        ts: '2026-10-01T00:00:00.000Z',
      };
      await result.current.channel.submit(event);
      expect(transport.ingestCanvasEvent).toHaveBeenCalledWith('doc-1', event);
      expect(vi.mocked(transport.ingestCanvasEvent).mock.calls[0]![1]).toBe(event);
      await result.current.channel.inspect(event.id);
      expect(transport.getCanvasEventReceipt).toHaveBeenCalledWith('doc-1', event.id);
      await publish(
        snapshot(replay({ state: { text: 'saved' }, stateRev: 1, receipts: [receipt(1)] }))
      );
      expect(result.current.channel.documentId).toBe('doc-1');
      expect(result.current.channel.snapshot).toMatchObject({
        state: { text: 'saved' },
        stateRev: 1,
        receipts: [receipt(1)],
      });
      const updated = {
        ...receipt(1),
        deliveries: [
          {
            eventId: id(1),
            routeId: 'route-1',
            batchId: 'batch-1',
            status: 'handled' as const,
            turnId: 'turn-1',
            reason: null,
            updatedAt: '2026-10-01T00:00:01.000Z',
            ackOutcome: 'handled' as const,
          },
        ],
      };
      await publish(snapshot(replay({ stateRev: 1, receipts: [updated] })));
      expect(result.current.channel.snapshot?.receipts).toEqual([updated]);
      expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
    } finally {
      unmount();
    }
  });

  it('filters physical documents across canonical aliases and deduplicates docSeq independently of transcripts', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getCanvasChannel).mockResolvedValue(replay({ highWatermark: 899 }));
    const { result, unmount } = renderHook(() => useDocChannel('doc-1'), {
      wrapper: wrapper(transport),
    });
    try {
      await waitFor(() => expect(result.current.channel.enabled).toBe(true));
      await publish(frame(900, 'other-doc'));
      await publish({ ...frame(900), scope: 'session:canonical-after-rekey' });
      await publish({ ...frame(900), scope: 'session:original-alias' });
      expect(result.current.events.map((value) => value.docSeq)).toEqual([900]);
      expect(result.current.channel.documentId).toBe('doc-1');
      expect(transport.getCanvasChannel).toHaveBeenCalledTimes(1);
    } finally {
      unmount();
    }
  });

  it('recovers a sequence gap once with bounded HTTP replay before applying the live frame', async () => {
    const transport = createMockTransport();
    const repair = deferred<CanvasChannelReplayResponse>();
    vi.mocked(transport.getCanvasChannel)
      .mockResolvedValueOnce(replay({ highWatermark: 1 }))
      .mockReturnValueOnce(repair.promise);
    const { result, unmount } = renderHook(() => useDocChannel('doc-1'), {
      wrapper: wrapper(transport),
    });
    try {
      await waitFor(() => expect(result.current.channel.enabled).toBe(true));
      await publish(frame(3));
      await publish(frame(3));
      expect(transport.getCanvasChannel).toHaveBeenCalledTimes(2);
      expect(transport.getCanvasChannel).toHaveBeenLastCalledWith('doc-1', {
        since: 1,
        limit: 200,
      });
      await act(async () => repair.resolve(replay({ events: [frame(2)], highWatermark: 2 })));
      expect(result.current.events.map((value) => value.docSeq)).toEqual([2, 3]);
    } finally {
      unmount();
    }
  });

  it('does not lose a gap frame arriving during the initial request', async () => {
    const transport = createMockTransport();
    const initial = deferred<CanvasChannelReplayResponse>();
    vi.mocked(transport.getCanvasChannel)
      .mockReturnValueOnce(initial.promise)
      .mockResolvedValueOnce(replay({ events: [frame(2)], highWatermark: 2 }));
    const { result, unmount } = renderHook(() => useDocChannel('doc-1'), {
      wrapper: wrapper(transport),
    });
    try {
      await publish(frame(3));
      expect(transport.getCanvasChannel).toHaveBeenCalledTimes(1);
      await act(async () => initial.resolve(replay({ events: [frame(1)], highWatermark: 1 })));
      await waitFor(() =>
        expect(result.current.events.map((value) => value.docSeq)).toEqual([1, 2, 3])
      );
      expect(transport.getCanvasChannel).toHaveBeenCalledTimes(2);
    } finally {
      unmount();
    }
  });

  it('does not replace live routing approval with a stale initial fetch at the same watermark', async () => {
    const transport = createMockTransport();
    const initial = deferred<CanvasChannelReplayResponse>();
    vi.mocked(transport.getCanvasChannel).mockReturnValue(initial.promise);
    const { result, unmount } = renderHook(() => useDocChannel('doc-1'), {
      wrapper: wrapper(transport),
    });
    try {
      await publish(snapshot(replay()));
      expect(result.current.channel.enabled).toBe(true);
      await act(async () =>
        initial.resolve(
          replay({
            routing: {
              enabled: false,
              approvedEventTypes: [],
              destinationLabel: 'Approval needed',
            },
          })
        )
      );
      expect(result.current.channel).toMatchObject({
        enabled: true,
        approvedEventTypes: ['app.updated'],
        destinationLabel: 'DorkBot',
      });
    } finally {
      unmount();
    }
  });

  it('cannot re-enable a live revoked route with a stale approved fetch', async () => {
    const transport = createMockTransport();
    const initial = deferred<CanvasChannelReplayResponse>();
    vi.mocked(transport.getCanvasChannel).mockReturnValue(initial.promise);
    const { result, unmount } = renderHook(() => useDocChannel('doc-1'), {
      wrapper: wrapper(transport),
    });
    try {
      await publish(
        snapshot(
          replay({
            routing: {
              enabled: false,
              approvedEventTypes: [],
              destinationLabel: 'Approval needed',
            },
          })
        )
      );
      await act(async () => initial.resolve(replay()));
      expect(result.current.channel).toMatchObject({
        enabled: false,
        approvedEventTypes: [],
        destinationLabel: 'Approval needed',
      });
    } finally {
      unmount();
    }
  });

  it('applies receipt and payload floors on a reset without fabricating missing events', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getCanvasChannel).mockResolvedValue(
      replay({ events: [frame(1), frame(2)], highWatermark: 2, receipts: [receipt(1), receipt(2)] })
    );
    const { result, unmount } = renderHook(() => useDocChannel('doc-1'), {
      wrapper: wrapper(transport),
    });
    try {
      await waitFor(() => expect(result.current.events).toHaveLength(2));
      await publish(
        snapshot(
          replay({
            state: { current: true },
            stateRev: 1,
            highWatermark: 2,
            retentionFloor: 2,
            receiptRetentionFloor: 2,
            resetRequired: true,
            receipts: [receipt(2)],
          })
        )
      );
      expect(result.current.events.map((value) => value.docSeq)).toEqual([2]);
      expect(result.current.channel.snapshot).toMatchObject({
        resetRequired: true,
        retentionFloor: 2,
        receiptRetentionFloor: 2,
        receipts: [receipt(2)],
        state: { current: true },
      });
    } finally {
      unmount();
    }
  });

  it('keeps a disabled channel attached after initial unavailability and preserves lookup refusal', async () => {
    const transport = createMockTransport();
    const failure = new Error('Document unavailable');
    vi.mocked(transport.getCanvasChannel).mockRejectedValue(failure);
    vi.mocked(transport.getCanvasEventReceipt).mockRejectedValue(failure);
    const { result, unmount } = renderHook(() => useDocChannel('doc-1'), {
      wrapper: wrapper(transport),
    });
    try {
      await act(async () => {});
      expect(result.current.channel).toMatchObject({ documentId: 'doc-1', enabled: false });
      await expect(result.current.channel.inspect(id(1))).rejects.toBe(failure);
      expect(result.current.channel.submit).toEqual(expect.any(Function));
      expect(result.current.channel.enabled).toBe(false);
    } finally {
      unmount();
    }
  });

  it('stops replay after ten pages and disables actions instead of polling forever', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getCanvasChannel).mockImplementation(async (_document, query) => {
      const since = query?.since ?? 0;
      return replay({
        events: Array.from({ length: 200 }, (_, index) => frame(since + index + 1)),
        highWatermark: 10000,
      });
    });
    const { result, unmount } = renderHook(() => useDocChannel('doc-1'), {
      wrapper: wrapper(transport),
    });
    try {
      await waitFor(() => expect(transport.getCanvasChannel).toHaveBeenCalledTimes(10));
      await act(async () => {});
      expect(result.current.channel.enabled).toBe(false);
      expect(result.current.events).toHaveLength(200);
      expect(
        vi.mocked(transport.getCanvasChannel).mock.calls.every(([, query]) => query?.limit === 200)
      ).toBe(true);
    } finally {
      unmount();
    }
  });

  it('switches physical documents without applying late fetches or retaining the old subscription', async () => {
    const transport = createMockTransport();
    const old = deferred<CanvasChannelReplayResponse>();
    vi.mocked(transport.getCanvasChannel)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(replay({ state: { name: 'new' } }));
    const { result, rerender, unmount } = renderHook(
      ({ documentId }) => useDocChannel(documentId),
      { initialProps: { documentId: 'doc-1' }, wrapper: wrapper(transport) }
    );
    try {
      rerender({ documentId: 'doc-2' });
      await waitFor(() => expect(result.current.channel.enabled).toBe(true));
      await act(async () => old.resolve(replay({ state: { name: 'old' }, highWatermark: 100 })));
      await publish(frame(100, 'doc-1'));
      expect(result.current.channel.documentId).toBe('doc-2');
      expect(result.current.channel.snapshot?.state).toEqual({ name: 'new' });
      expect(result.current.events).toEqual([]);
      expect(transport.getCanvasChannel).toHaveBeenCalledTimes(2);
      unmount();
      await publish(frame(10, 'doc-2'));
      expect(transport.getCanvasChannel).toHaveBeenCalledTimes(2);
    } finally {
      unmount();
    }
  });
});
