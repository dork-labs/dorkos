// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode, SetStateAction } from 'react';
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
import { ownDocChannelConnection } from '@/layers/shared/lib/transport/doc-channel-ownership';
let testOwner: Transport;
const birth = {
  v: 1 as const,
  documentId: 'doc-1',
  physicalOpenedAt: '2026-10-01T00:00:00.000Z',
  channelCreatedAt: '2026-10-01T00:00:00.000Z',
  generation: 'a'.repeat(64),
};
function publishDocChannelNotification(value: unknown, owner: Transport = testOwner) {
  return ownDocChannelConnection(owner, new AbortController().signal).publish(value);
}
import { useDocChannel } from '../model/use-doc-channel';
import { createDocChannelRecovery } from '../model/doc-channel-recovery';
import { emptyDocChannelView, type DocChannelView } from '../model/doc-channel-view';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function receipt(seq: number): CanvasChannelEventReceipt {
  return { receipt: { id: id(seq), status: 'recorded', docSeq: seq }, deliveries: [] };
}
function frame(seq: number, documentId = 'doc-1'): CanvasChannelFrame {
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
function replay(patch: Partial<CanvasChannelReplayResponse> = {}): CanvasChannelReplayResponse {
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
  testOwner = transport;
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
      await result.current.channel.submit(event, new AbortController().signal);
      expect(transport.ingestCanvasEvent).toHaveBeenCalledWith(
        'doc-1',
        event,
        { expectedGeneration: birth.generation },
        expect.any(AbortSignal)
      );
      expect(vi.mocked(transport.ingestCanvasEvent).mock.calls[0]![1]).toStrictEqual(event);
      await result.current.channel.inspect(event.id, new AbortController().signal);
      expect(transport.getCanvasEventReceipt).toHaveBeenCalledWith(
        'doc-1',
        event.id,
        { expectedGeneration: birth.generation },
        expect.any(AbortSignal)
      );
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

  it('revalidates a canonical rekey while filtering physical documents and deduplicating docSeq independently of transcripts', async () => {
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
      expect(transport.getCanvasChannel).toHaveBeenCalledTimes(2);
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

  it.each([200, 201])(
    'heals %i live gap frames during a held replay even after payload eviction',
    async (count) => {
      const transport = createMockTransport();
      const initial = deferred<CanvasChannelReplayResponse>();
      const target = count + 2;
      vi.mocked(transport.getCanvasChannel)
        .mockReturnValueOnce(initial.promise)
        .mockImplementation(async (_document, query) => {
          const since = query?.since ?? 0;
          return replay({
            events: Array.from({ length: Math.min(200, target - since) }, (_, i) =>
              frame(since + i + 1)
            ),
            highWatermark: target,
          });
        });
      const { result, unmount } = renderHook(() => useDocChannel('doc-1'), {
        wrapper: wrapper(transport),
      });
      try {
        await act(async () => {
          for (let seq = 3; seq <= target; seq++)
            expect(publishDocChannelNotification(frame(seq))).toBe(true);
        });
        expect(transport.getCanvasChannel).toHaveBeenCalledTimes(1);
        await act(async () => initial.resolve(replay({ events: [frame(1)], highWatermark: 1 })));
        await waitFor(() => expect(result.current.events.at(-1)?.docSeq).toBe(target));
        expect(result.current.channel.enabled).toBe(true);
        expect(result.current.events.map((event) => event.docSeq)).toEqual(
          Array.from({ length: 200 }, (_, i) => target - 199 + i)
        );
        expect(vi.mocked(transport.getCanvasChannel).mock.calls.map(([, query]) => query)).toEqual(
          [0, 1, 201].map((since) => ({ since, limit: 200 }))
        );
      } finally {
        unmount();
      }
    }
  );

  it('preserves a newer overflow while the follow-up replay has its own frozen target', async () => {
    const transport = createMockTransport();
    const initial = deferred<CanvasChannelReplayResponse>();
    const followUp = deferred<CanvasChannelReplayResponse>();
    vi.mocked(transport.getCanvasChannel)
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(followUp.promise)
      .mockImplementation(async (_document, query) => {
        const since = query?.since ?? 0;
        return replay({
          events: Array.from({ length: Math.min(200, 405 - since) }, (_, i) =>
            frame(since + i + 1)
          ),
          highWatermark: 405,
        });
      });
    const { result, unmount } = renderHook(() => useDocChannel('doc-1'), {
      wrapper: wrapper(transport),
    });
    try {
      await act(async () => {
        for (let seq = 3; seq <= 203; seq++)
          expect(publishDocChannelNotification(frame(seq))).toBe(true);
      });
      await act(async () => initial.resolve(replay({ events: [frame(1)], highWatermark: 1 })));
      expect(transport.getCanvasChannel).toHaveBeenCalledTimes(2);
      await act(async () => {
        for (let seq = 204; seq <= 405; seq++)
          expect(publishDocChannelNotification(frame(seq))).toBe(true);
      });
      expect(transport.getCanvasChannel).toHaveBeenCalledTimes(2);
      await act(async () =>
        followUp.resolve(
          replay({
            events: Array.from({ length: 200 }, (_, i) => frame(i + 2)),
            highWatermark: 203,
          })
        )
      );
      await waitFor(() => expect(result.current.events.at(-1)?.docSeq).toBe(405));
      expect(result.current.channel.enabled).toBe(true);
      expect(result.current.events.map((event) => event.docSeq)).toEqual(
        Array.from({ length: 200 }, (_, i) => 206 + i)
      );
      expect(vi.mocked(transport.getCanvasChannel).mock.calls.map(([, query]) => query)).toEqual(
        [0, 1, 201, 203, 403].map((since) => ({ since, limit: 200 }))
      );
    } finally {
      unmount();
    }
  });

  it.each(['nonprogress', 'rejected'] as const)(
    'stops overflow catch-up safely on a %s follow-up without spinning',
    async (failure) => {
      const transport = createMockTransport();
      const initial = deferred<CanvasChannelReplayResponse>();
      vi.mocked(transport.getCanvasChannel).mockReturnValueOnce(initial.promise);
      if (failure === 'nonprogress')
        vi.mocked(transport.getCanvasChannel).mockResolvedValue(replay({ highWatermark: 1 }));
      else vi.mocked(transport.getCanvasChannel).mockRejectedValue(new Error('Unavailable'));
      const { result, unmount } = renderHook(() => useDocChannel('doc-1'), {
        wrapper: wrapper(transport),
      });
      try {
        await act(async () => {
          for (let seq = 3; seq <= 203; seq++)
            expect(publishDocChannelNotification(frame(seq))).toBe(true);
        });
        await act(async () => initial.resolve(replay({ events: [frame(1)], highWatermark: 1 })));
        expect(result.current.channel.enabled).toBe(false);
        expect(result.current.events).toEqual([frame(1)]);
        expect(vi.mocked(transport.getCanvasChannel).mock.calls.map(([, query]) => query)).toEqual(
          [0, 1].map((since) => ({ since, limit: 200 }))
        );
        await act(async () => {});
        expect(transport.getCanvasChannel).toHaveBeenCalledTimes(2);
      } finally {
        unmount();
      }
    }
  );

  it.each(['unmount', 'document', 'transport'] as const)(
    'retires an overflow marker on %s before the held replay completes',
    async (replacement) => {
      const transport = createMockTransport();
      const nextTransport = createMockTransport();
      const initial = deferred<CanvasChannelReplayResponse>();
      vi.mocked(transport.getCanvasChannel).mockImplementation(async (document) => {
        if (document === 'doc-1') return initial.promise;
        return replay({
          incarnation: { ...birth, documentId: document },
          state: { name: 'new document' },
        });
      });
      vi.mocked(nextTransport.getCanvasChannel).mockResolvedValue(
        replay({ state: { name: 'new transport' } })
      );
      let currentTransport = transport;
      const { result, rerender, unmount } = renderHook(
        ({ documentId }) => useDocChannel(documentId),
        {
          initialProps: { documentId: 'doc-1' },
          wrapper: ({ children }: { children: ReactNode }) => {
            testOwner = currentTransport;
            return <TransportProvider transport={currentTransport}>{children}</TransportProvider>;
          },
        }
      );
      try {
        await act(async () => {
          for (let seq = 3; seq <= 203; seq++)
            expect(publishDocChannelNotification(frame(seq), currentTransport)).toBe(true);
        });
        if (replacement === 'unmount') unmount();
        else {
          currentTransport = replacement === 'transport' ? nextTransport : transport;
          rerender({ documentId: replacement === 'document' ? 'doc-2' : 'doc-1' });
          await waitFor(() => expect(result.current.channel.enabled).toBe(true));
        }
        await act(async () => initial.resolve(replay({ events: [frame(1)], highWatermark: 1 })));
        expect(transport.getCanvasChannel).toHaveBeenCalledTimes(
          replacement === 'document' ? 2 : 1
        );
        expect(nextTransport.getCanvasChannel).toHaveBeenCalledTimes(
          replacement === 'transport' ? 1 : 0
        );
        if (replacement !== 'unmount') {
          expect(result.current.channel.snapshot?.state).toEqual({
            name: replacement === 'document' ? 'new document' : 'new transport',
          });
          expect(result.current.events).toEqual([]);
        }
      } finally {
        unmount();
      }
    }
  );

  it('does not replace live routing approval with a stale repair fetch at the same watermark', async () => {
    const transport = createMockTransport();
    const initial = deferred<CanvasChannelReplayResponse>();
    vi.mocked(transport.getCanvasChannel)
      .mockResolvedValueOnce(replay())
      .mockReturnValueOnce(initial.promise);
    const { result, unmount } = renderHook(() => useDocChannel('doc-1'), {
      wrapper: wrapper(transport),
    });
    try {
      await waitFor(() => expect(result.current.channel.enabled).toBe(true));
      expect(result.current.channel.submissionOwner).toBeDefined();
      await act(async () =>
        ownDocChannelConnection(transport, new AbortController().signal).retire()
      );
      expect(transport.getCanvasChannel).toHaveBeenCalledTimes(2);
      await publish(snapshot(replay()));
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
    vi.mocked(transport.getCanvasChannel)
      .mockResolvedValueOnce(replay())
      .mockReturnValueOnce(initial.promise);
    const { result, unmount } = renderHook(() => useDocChannel('doc-1'), {
      wrapper: wrapper(transport),
    });
    try {
      await waitFor(() => expect(result.current.channel.enabled).toBe(true));
      expect(result.current.channel.submissionOwner).toBeDefined();
      await act(async () =>
        ownDocChannelConnection(transport, new AbortController().signal).retire()
      );
      expect(transport.getCanvasChannel).toHaveBeenCalledTimes(2);
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

  it('keeps an unissued disabled channel attached after initial unavailability and refuses lookup without disclosing receipts', async () => {
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
      await expect(
        result.current.channel.inspect(id(1), new AbortController().signal)
      ).rejects.toMatchObject({ status: 409 });
      expect(transport.getCanvasEventReceipt).not.toHaveBeenCalled();
      expect(result.current.channel.submit).toEqual(expect.any(Function));
      expect(result.current.channel.enabled).toBe(false);
    } finally {
      unmount();
    }
  });

  it('consumes all 2,205 retained events in bounded pages and retains only the latest 200', async () => {
    const transport = createMockTransport();
    const consumed: number[] = [];
    vi.mocked(transport.getCanvasChannel).mockImplementation(async (_document, query) => {
      const since = query?.since ?? 0;
      const events = Array.from({ length: Math.min(200, 2205 - since) }, (_, i) =>
        frame(since + i + 1)
      );
      consumed.push(...events.map((event) => event.docSeq));
      return replay({ events, highWatermark: 2205 });
    });
    const { result, unmount } = renderHook(() => useDocChannel('doc-1'), {
      wrapper: wrapper(transport),
    });
    try {
      await waitFor(() => expect(result.current.events.at(-1)?.docSeq).toBe(2205));
      expect(result.current.channel.enabled).toBe(true);
      expect(result.current.events.map((event) => event.docSeq)).toEqual(
        Array.from({ length: 200 }, (_, i) => 2006 + i)
      );
      expect(consumed).toEqual(Array.from({ length: 2205 }, (_, i) => i + 1));
      expect(vi.mocked(transport.getCanvasChannel).mock.calls.map(([, query]) => query)).toEqual(
        Array.from({ length: 12 }, (_, i) => ({ since: i * 200, limit: 200 }))
      );
    } finally {
      unmount();
    }
  });

  it('freezes the initial replay watermark while preserving a live gap during long catch-up', async () => {
    const transport = createMockTransport();
    const lastPage = deferred<CanvasChannelReplayResponse>();
    vi.mocked(transport.getCanvasChannel).mockImplementation(async (_document, query) => {
      const since = query?.since ?? 0;
      if (since === 2200) return lastPage.promise;
      // New history keeps arriving, but it must not extend this recovery indefinitely.
      return replay({
        events: Array.from({ length: 200 }, (_, i) => frame(since + i + 1)),
        highWatermark: since === 0 ? 2205 : 10000 + since,
      });
    });
    const { result, unmount } = renderHook(() => useDocChannel('doc-1'), {
      wrapper: wrapper(transport),
    });
    try {
      await waitFor(() => expect(transport.getCanvasChannel).toHaveBeenCalledTimes(12));
      await publish(frame(2206));
      await publish(frame(2206));
      await act(async () =>
        lastPage.resolve(
          replay({
            events: Array.from({ length: 200 }, (_, i) => frame(2201 + i)),
            highWatermark: 20000,
          })
        )
      );
      await waitFor(() => expect(result.current.events.at(-1)?.docSeq).toBe(2206));
      expect(result.current.channel.enabled).toBe(true);
      expect(result.current.events.map((event) => event.docSeq)).toEqual(
        Array.from({ length: 200 }, (_, i) => 2007 + i)
      );
      expect(transport.getCanvasChannel).toHaveBeenCalledTimes(12);
      expect(
        vi.mocked(transport.getCanvasChannel).mock.calls.map(([, query]) => query?.since)
      ).toEqual(Array.from({ length: 12 }, (_, i) => i * 200));
    } finally {
      unmount();
    }
  });

  it('continues from live progress made while an older replay page is in flight', async () => {
    const transport = createMockTransport();
    const initial = deferred<CanvasChannelReplayResponse>();
    vi.mocked(transport.getCanvasChannel).mockImplementation(async (_document, query) => {
      const since = query?.since ?? 0;
      const call = vi.mocked(transport.getCanvasChannel).mock.calls.length;
      if (call === 1) return replay();
      if (call === 2) return initial.promise;
      return replay({
        events: Array.from({ length: Math.min(200, 2205 - since) }, (_, i) => frame(since + i + 1)),
        highWatermark: 2205,
      });
    });
    const { result, unmount } = renderHook(() => useDocChannel('doc-1'), {
      wrapper: wrapper(transport),
    });
    try {
      await waitFor(() => expect(result.current.channel.enabled).toBe(true));
      await publish(frame(2));
      expect(transport.getCanvasChannel).toHaveBeenCalledTimes(2);
      await act(async () => {
        for (let seq = 1; seq <= 900; seq++)
          expect(publishDocChannelNotification(frame(seq))).toBe(true);
      });
      expect(result.current.events.at(-1)?.docSeq).toBe(900);
      await act(async () =>
        initial.resolve(
          replay({
            events: Array.from({ length: 200 }, (_, i) => frame(i + 1)),
            highWatermark: 2205,
          })
        )
      );
      await waitFor(() => expect(result.current.events.at(-1)?.docSeq).toBe(2205));
      expect(result.current.channel.enabled).toBe(true);
      expect(result.current.events.map((event) => event.docSeq)).toEqual(
        Array.from({ length: 200 }, (_, i) => 2006 + i)
      );
      expect(
        vi.mocked(transport.getCanvasChannel).mock.calls.map(([, query]) => query?.since)
      ).toEqual([0, 0, 900, 1100, 1300, 1500, 1700, 1900, 2100]);
    } finally {
      unmount();
    }
  });

  it('starts one follow-up recovery for a live gap after an empty initial watermark', async () => {
    const transport = createMockTransport();
    const initial = deferred<CanvasChannelReplayResponse>();
    vi.mocked(transport.getCanvasChannel).mockImplementation(async (_document, query) => {
      if (vi.mocked(transport.getCanvasChannel).mock.calls.length === 1) return initial.promise;
      const since = query?.since ?? 0;
      return replay({
        events: Array.from({ length: Math.min(200, 900 - since) }, (_, i) => frame(since + i + 1)),
        highWatermark: 900,
      });
    });
    const { result, unmount } = renderHook(() => useDocChannel('doc-1'), {
      wrapper: wrapper(transport),
    });
    try {
      await publish(frame(900));
      await act(async () => initial.resolve(replay()));
      await waitFor(() => expect(result.current.events.at(-1)?.docSeq).toBe(900));
      expect(result.current.events).toHaveLength(200);
      expect(result.current.channel.enabled).toBe(true);
      expect(
        vi.mocked(transport.getCanvasChannel).mock.calls.map(([, query]) => query?.since)
      ).toEqual([0, 0, 200, 400, 600, 800]);
    } finally {
      unmount();
    }
  });

  it.each(['nonprogress', 'invalid'] as const)(
    'disables safely on a %s replay response',
    async (failure) => {
      const transport = createMockTransport();
      const first = replay({
        events: Array.from({ length: 200 }, (_, i) => frame(i + 1)),
        highWatermark: 2205,
      });
      vi.mocked(transport.getCanvasChannel)
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(failure === 'nonprogress' ? first : replay({ highWatermark: -1 }));
      const { result, unmount } = renderHook(() => useDocChannel('doc-1'), {
        wrapper: wrapper(transport),
      });
      try {
        await waitFor(() => expect(transport.getCanvasChannel).toHaveBeenCalledTimes(2));
        await act(async () => {});
        expect(result.current.channel).toMatchObject({ documentId: 'doc-1', enabled: false });
        expect(result.current.channel.inspect).toEqual(expect.any(Function));
        expect(result.current.events.map((event) => event.docSeq)).toEqual(
          Array.from({ length: 200 }, (_, i) => i + 1)
        );
        expect(transport.getCanvasChannel).toHaveBeenCalledTimes(2);
      } finally {
        unmount();
      }
    }
  );

  it('abandons an old document midway through large replay without requesting more old pages', async () => {
    const transport = createMockTransport();
    const oldPage = deferred<CanvasChannelReplayResponse>();
    vi.mocked(transport.getCanvasChannel).mockImplementation(async (document, query) => {
      if (document === 'doc-2')
        return replay({
          incarnation: { ...birth, documentId: 'doc-2' },
          state: { name: 'new' },
          events: [frame(1, 'doc-2')],
          highWatermark: 1,
        });
      if (query?.since === 200) return oldPage.promise;
      return replay({
        events: Array.from({ length: 200 }, (_, i) => frame(i + 1)),
        highWatermark: 2205,
      });
    });
    const { result, rerender, unmount } = renderHook(
      ({ documentId }) => useDocChannel(documentId),
      {
        initialProps: { documentId: 'doc-1' },
        wrapper: wrapper(transport),
      }
    );
    try {
      await waitFor(() => expect(transport.getCanvasChannel).toHaveBeenCalledTimes(2));
      rerender({ documentId: 'doc-2' });
      await waitFor(() => expect(result.current.channel.snapshot?.state).toEqual({ name: 'new' }));
      await act(async () =>
        oldPage.resolve(
          replay({
            events: Array.from({ length: 200 }, (_, i) => frame(201 + i)),
            highWatermark: 2205,
          })
        )
      );
      await publish(frame(401, 'doc-1'));
      expect(result.current.channel).toMatchObject({ documentId: 'doc-2', enabled: true });
      expect(result.current.events).toEqual([frame(1, 'doc-2')]);
      expect(
        vi
          .mocked(transport.getCanvasChannel)
          .mock.calls.map(([document, query]) => [document, query?.since])
      ).toEqual([
        ['doc-1', 0],
        ['doc-1', 200],
        ['doc-2', 0],
      ]);
    } finally {
      unmount();
    }
  });

  it('switches physical documents without applying late fetches or retaining the old subscription', async () => {
    const transport = createMockTransport();
    const old = deferred<CanvasChannelReplayResponse>();
    vi.mocked(transport.getCanvasChannel)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(
        replay({ incarnation: { ...birth, documentId: 'doc-2' }, state: { name: 'new' } })
      );
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

describe('native issued birth lifetime', () => {
  it('keeps a genuinely absent legacy birth attached and disabled without legacy actions', async () => {
    const transport = createMockTransport();
    const legacy = replay();
    delete legacy.incarnation;
    vi.mocked(transport.getCanvasChannel).mockResolvedValue(legacy);
    const { result, unmount } = renderHook(() => useDocChannel('doc-1'), {
      wrapper: wrapper(transport),
    });
    try {
      await waitFor(() => expect(result.current.channel.snapshot).toBeDefined());
      expect(result.current.channel.enabled).toBe(false);
      await expect(
        result.current.channel.submit(
          { v: 1, id: id(1), type: 'app.updated', payload: {} },
          new AbortController().signal
        )
      ).rejects.toMatchObject({ status: 409 });
      expect(transport.ingestCanvasEvent).not.toHaveBeenCalled();
      expect(transport.sendUiAction).not.toHaveBeenCalled();
    } finally {
      unmount();
    }
  });
  it('forwards the original generation and signal on both methods, then refuses a retained port after replacement', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getCanvasChannel).mockResolvedValue(replay());
    vi.mocked(transport.ingestCanvasEvent).mockResolvedValue(receipt(1));
    vi.mocked(transport.getCanvasEventReceipt).mockResolvedValue(receipt(1));
    const { result, unmount } = renderHook(() => useDocChannel('doc-1'), {
      wrapper: wrapper(transport),
    });
    try {
      await waitFor(() => expect(result.current.channel.enabled).toBe(true));
      const original = result.current.channel;
      const controller = new AbortController();
      const event: PageEvent = { v: 1, id: id(1), type: 'app.updated', payload: {} };
      await original.submit(event, controller.signal);
      await original.inspect(event.id, controller.signal);
      expect(transport.ingestCanvasEvent).toHaveBeenCalledWith(
        'doc-1',
        event,
        { expectedGeneration: birth.generation },
        controller.signal
      );
      expect(transport.getCanvasEventReceipt).toHaveBeenCalledWith(
        'doc-1',
        event.id,
        { expectedGeneration: birth.generation },
        controller.signal
      );
      const nextBirth = {
        ...birth,
        generation: 'b'.repeat(64),
        physicalOpenedAt: '2026-10-02T00:00:00.000Z',
      };
      vi.mocked(transport.getCanvasChannel).mockResolvedValue(replay({ incarnation: nextBirth }));
      await publish(snapshot(replay({ incarnation: nextBirth })));
      await waitFor(() =>
        expect(result.current.channel.submissionOwner).not.toBe(original.submissionOwner)
      );
      await expect(original.inspect(event.id, new AbortController().signal)).rejects.toMatchObject({
        status: 409,
      });
      expect(transport.getCanvasEventReceipt).toHaveBeenCalledTimes(1);
    } finally {
      unmount();
    }
  });
  it('preserves the original stable owner across a canonical rekey after a fresh owned replay', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getCanvasChannel).mockResolvedValue(replay());
    const { result, unmount } = renderHook(() => useDocChannel('doc-1'), {
      wrapper: wrapper(transport),
    });
    try {
      await waitFor(() => expect(result.current.channel.enabled).toBe(true));
      const owner = result.current.channel.submissionOwner;
      await publish({ ...snapshot(replay()), scope: 'session:first' });
      const held = deferred<CanvasChannelReplayResponse>();
      vi.mocked(transport.getCanvasChannel).mockReturnValueOnce(held.promise);
      await publish({ ...snapshot(replay()), scope: 'session:second' });
      expect(result.current.channel.submissionOwner).toBe(owner);
      expect(result.current.channel.enabled).toBe(false);
      await act(async () => held.resolve(replay()));
      await waitFor(() => expect(result.current.channel.enabled).toBe(true));
      expect(result.current.channel.submissionOwner).toBe(owner);
    } finally {
      unmount();
    }
  });
});

/** Match production replay's strict >since filter and floor-only reset rule. */
function serverReplay(
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

it('refetches replacement B from zero after A300/page200, then catches up B300 before enabling', async () => {
  const transport = createMockTransport();
  const nextBirth = {
    ...birth,
    generation: 'b'.repeat(64),
    physicalOpenedAt: '2026-10-02T00:00:00.000Z',
  };
  const changed = deferred<CanvasChannelReplayResponse>();
  const last = deferred<CanvasChannelReplayResponse>();
  vi.mocked(transport.getCanvasChannel).mockImplementation(async (_document, query) => {
    const call = vi.mocked(transport.getCanvasChannel).mock.calls.length;
    const since = query?.since ?? 0;
    if (call === 1) return { ...serverReplay(birth, 300, since), receipts: [receipt(100)] };
    if (call === 2) return changed.promise;
    if (call === 4) return last.promise;
    return serverReplay(nextBirth, 300, since);
  });
  const view = renderHook(() => useDocChannel('doc-1'), { wrapper: wrapper(transport) });
  try {
    await waitFor(() => expect(transport.getCanvasChannel).toHaveBeenCalledTimes(2));
    const old = view.result.current.channel;
    const oldCursorPage = serverReplay(nextBirth, 300, 200);
    expect(oldCursorPage.events.map((event) => event.docSeq)).toEqual(
      Array.from({ length: 100 }, (_, i) => 201 + i)
    );
    expect(oldCursorPage.resetRequired).toBe(false);
    await act(async () => changed.resolve(oldCursorPage));
    await waitFor(() => expect(transport.getCanvasChannel).toHaveBeenCalledTimes(4));
    expect(view.result.current.events.map((event) => event.docSeq)).toEqual(
      Array.from({ length: 200 }, (_, i) => i + 1)
    );
    expect(view.result.current.channel.enabled).toBe(false);
    expect(view.result.current.channel.current?.('read')).toBe(false);
    expect(
      view.result.current.channel.snapshot?.receipts
        .map((row) => row.receipt.docSeq)
        .sort((a, b) => a - b)
    ).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    expect(
      view.result.current.channel.snapshot?.receipts.some((row) => row.receipt.id === id(100))
    ).toBe(false);
    await publish(frame(999));
    expect(view.result.current.events.map((event) => event.docSeq)).toEqual(
      Array.from({ length: 200 }, (_, i) => i + 1)
    );
    expect(transport.getCanvasChannel).toHaveBeenCalledTimes(4);
    await expect(
      old.submit(
        { v: 1, id: id(300), type: 'app.updated', payload: {} },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ status: 409 });
    await expect(old.inspect(id(100), new AbortController().signal)).rejects.toMatchObject({
      status: 409,
    });
    await act(async () => last.resolve(serverReplay(nextBirth, 300, 200)));
    await waitFor(() => expect(view.result.current.channel.enabled).toBe(true));
    expect(view.result.current.events.map((event) => event.docSeq)).toEqual(
      Array.from({ length: 200 }, (_, i) => 101 + i)
    );
    expect(
      view.result.current.channel.snapshot?.receipts
        .map((row) => row.receipt.docSeq)
        .sort((a, b) => a - b)
    ).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
    await publish({ ...frame(301), incarnation: nextBirth });
    expect(view.result.current.events.at(-1)?.docSeq).toBe(301);
    expect(view.result.current.events).toHaveLength(200);
    expect(transport.ingestCanvasEvent).not.toHaveBeenCalled();
    expect(transport.getCanvasEventReceipt).not.toHaveBeenCalled();
    expect(vi.mocked(transport.getCanvasChannel).mock.calls.map(([, query]) => query)).toEqual(
      [0, 200, 0, 200].map((since) => ({ since, limit: 200 }))
    );
  } finally {
    view.unmount();
  }
});

it('refetches B1 from zero after retired A100 yields an empty old-cursor page', async () => {
  const transport = createMockTransport();
  const nextBirth = { ...birth, generation: 'c'.repeat(64) };
  const fresh = deferred<CanvasChannelReplayResponse>();
  vi.mocked(transport.getCanvasChannel).mockImplementation(async (_document, query) => {
    const call = vi.mocked(transport.getCanvasChannel).mock.calls.length;
    if (call === 1) return serverReplay(birth, 100, query?.since ?? 0);
    if (call === 3) return fresh.promise;
    return serverReplay(nextBirth, 1, query?.since ?? 0);
  });
  const view = renderHook(() => useDocChannel('doc-1'), { wrapper: wrapper(transport) });
  try {
    await waitFor(() => expect(view.result.current.channel.enabled).toBe(true));
    const old = view.result.current.channel;
    expect(serverReplay(nextBirth, 1, 100)).toMatchObject({ events: [], resetRequired: false });
    await act(async () =>
      ownDocChannelConnection(transport, new AbortController().signal).retire()
    );
    await waitFor(() => expect(transport.getCanvasChannel).toHaveBeenCalledTimes(3));
    expect(view.result.current.events).toEqual([]);
    expect(view.result.current.channel.enabled).toBe(false);
    await expect(old.inspect(id(1), new AbortController().signal)).rejects.toMatchObject({
      status: 409,
    });
    await act(async () => fresh.resolve(serverReplay(nextBirth, 1, 0)));
    await waitFor(() => expect(view.result.current.channel.enabled).toBe(true));
    expect(view.result.current.channel.snapshot).toMatchObject({ incarnation: nextBirth });
    await publish({ ...frame(2), incarnation: nextBirth });
    expect(view.result.current.events.map((event) => event.docSeq)).toEqual([1, 2]);
    expect(vi.mocked(transport.getCanvasChannel).mock.calls.map(([, query]) => query)).toEqual(
      [0, 100, 0].map((since) => ({ since, limit: 200 }))
    );
    expect(transport.getCanvasEventReceipt).not.toHaveBeenCalled();
  } finally {
    view.unmount();
  }
});

it('keeps legacy100 disabled and refetches first qualified B1 rather than inheriting its cursor or receipts', async () => {
  const transport = createMockTransport();
  const fresh = deferred<CanvasChannelReplayResponse>();
  vi.mocked(transport.getCanvasChannel).mockImplementation(async (_document, query) => {
    const call = vi.mocked(transport.getCanvasChannel).mock.calls.length;
    if (call === 1)
      return { ...serverReplay(birth, 100, query?.since ?? 0, 1, true), receipts: [receipt(100)] };
    if (call === 3) return fresh.promise;
    return serverReplay(birth, 1, query?.since ?? 0);
  });
  const view = renderHook(() => useDocChannel('doc-1'), { wrapper: wrapper(transport) });
  try {
    await waitFor(() =>
      expect(view.result.current.channel.snapshot).toMatchObject({ highWatermark: 100 })
    );
    expect(view.result.current.channel.enabled).toBe(false);
    expect(view.result.current.channel.submissionOwner).toBeUndefined();
    const legacy = view.result.current.channel;
    await act(async () =>
      ownDocChannelConnection(transport, new AbortController().signal).retire()
    );
    await waitFor(() => expect(transport.getCanvasChannel).toHaveBeenCalledTimes(3));
    expect(view.result.current.channel.snapshot).toBeUndefined();
    expect(view.result.current.channel.enabled).toBe(false);
    await act(async () => fresh.resolve(serverReplay(birth, 1, 0)));
    await waitFor(() => expect(view.result.current.channel.enabled).toBe(true));
    await publish(frame(2));
    expect(view.result.current.events.map((event) => event.docSeq)).toEqual([1, 2]);
    expect(view.result.current.channel.snapshot?.receipts.map((row) => row.receipt.docSeq)).toEqual(
      [1]
    );
    expect(
      view.result.current.channel.snapshot?.receipts.some((row) => row.receipt.id === id(100))
    ).toBe(false);
    await expect(
      legacy.submit(
        { v: 1, id: id(1), type: 'app.updated', payload: {} },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(vi.mocked(transport.getCanvasChannel).mock.calls.map(([, query]) => query)).toEqual(
      [0, 100, 0].map((since) => ({ since, limit: 200 }))
    );
    expect(transport.ingestCanvasEvent).not.toHaveBeenCalled();
  } finally {
    view.unmount();
  }
});

it('measures progress within B on a full retained reset page after an A400 cursor', async () => {
  const transport = createMockTransport();
  const nextBirth = { ...birth, generation: 'd'.repeat(64) };
  const changed = deferred<CanvasChannelReplayResponse>();
  const last = deferred<CanvasChannelReplayResponse>();
  vi.mocked(transport.getCanvasChannel).mockImplementation(async (_document, query) => {
    const call = vi.mocked(transport.getCanvasChannel).mock.calls.length;
    const since = query?.since ?? 0;
    if (call <= 2) return serverReplay(birth, 500, since);
    if (call === 3) return changed.promise;
    if (call === 5) return last.promise;
    return serverReplay(nextBirth, 300, since, 2);
  });
  const view = renderHook(() => useDocChannel('doc-1'), { wrapper: wrapper(transport) });
  try {
    await waitFor(() => expect(transport.getCanvasChannel).toHaveBeenCalledTimes(3));
    const old = view.result.current.channel;
    await act(async () => changed.resolve(serverReplay(nextBirth, 300, 400, 2)));
    await waitFor(() => expect(transport.getCanvasChannel).toHaveBeenCalledTimes(5));
    const reset = serverReplay(nextBirth, 300, 0, 2);
    expect(reset.resetRequired).toBe(true);
    expect(reset.events).toHaveLength(200);
    expect(view.result.current.events.map((event) => event.docSeq)).toEqual(
      Array.from({ length: 200 }, (_, i) => i + 2)
    );
    expect(view.result.current.channel.enabled).toBe(false);
    await expect(old.inspect(id(100), new AbortController().signal)).rejects.toMatchObject({
      status: 409,
    });
    await act(async () => last.resolve(serverReplay(nextBirth, 300, 201, 2)));
    await waitFor(() => expect(view.result.current.channel.enabled).toBe(true));
    expect(view.result.current.events.map((event) => event.docSeq)).toEqual(
      Array.from({ length: 200 }, (_, i) => 101 + i)
    );
    expect(vi.mocked(transport.getCanvasChannel).mock.calls.map(([, query]) => query)).toEqual(
      [0, 200, 400, 0, 201].map((since) => ({ since, limit: 200 }))
    );
    expect(transport.getCanvasEventReceipt).not.toHaveBeenCalled();
  } finally {
    view.unmount();
  }
});

it.each(['frame', 'snapshot'] as const)(
  'quarantines initial %s B until a fresh owned B baseline replaces delayed A',
  async (kind) => {
    const transport = createMockTransport();
    const nextBirth = {
      ...birth,
      generation: 'e'.repeat(64),
      physicalOpenedAt: '2026-10-02T00:00:00.000Z',
    };
    const initial = deferred<CanvasChannelReplayResponse>();
    const fresh = deferred<CanvasChannelReplayResponse>();
    vi.mocked(transport.getCanvasChannel).mockImplementation(async (_document, query) => {
      const call = vi.mocked(transport.getCanvasChannel).mock.calls.length;
      if (call === 1) return initial.promise;
      if (call === 2) return fresh.promise;
      return serverReplay(nextBirth, 2, query?.since ?? 0);
    });
    const view = renderHook(() => useDocChannel('doc-1'), { wrapper: wrapper(transport) });
    try {
      const loading = view.result.current.channel;
      const b = serverReplay(nextBirth, 2, 0);
      await publish(
        kind === 'frame'
          ? b.events[0]
          : snapshot({ ...b, state: { name: 'stream B' }, stateRev: 100 })
      );
      expect(view.result.current.events).toEqual([]);
      expect(view.result.current.channel.snapshot).toBeUndefined();
      expect(view.result.current.channel.enabled).toBe(false);
      await act(async () =>
        initial.resolve({
          ...serverReplay(birth, 2, 0),
          state: { name: 'late A' },
          receipts: [receipt(1)],
        })
      );
      await waitFor(() => expect(transport.getCanvasChannel).toHaveBeenCalledTimes(2));
      expect(view.result.current.events).toEqual([]);
      expect(view.result.current.channel.snapshot).toBeUndefined();
      expect(view.result.current.channel.current?.('read')).toBe(false);
      await expect(
        loading.submit(
          { v: 1, id: id(8), type: 'app.updated', payload: {} },
          new AbortController().signal
        )
      ).rejects.toMatchObject({ status: 409 });
      await act(async () => fresh.resolve({ ...b, state: { name: 'owned B' }, stateRev: 1 }));
      await waitFor(() => expect(view.result.current.channel.enabled).toBe(true));
      expect(view.result.current.events).toEqual(b.events);
      expect(view.result.current.channel.snapshot).toMatchObject({ incarnation: nextBirth });
      expect(view.result.current.channel.snapshot?.state).toEqual({ name: 'owned B' });
      expect(
        view.result.current.channel.snapshot?.receipts.some((row) => row.receipt.id === id(1))
      ).toBe(false);
      const signal = new AbortController().signal;
      const event: PageEvent = { v: 1, id: id(9), type: 'app.updated', payload: {} };
      vi.mocked(transport.ingestCanvasEvent).mockResolvedValue(receipt(9));
      vi.mocked(transport.getCanvasEventReceipt).mockResolvedValue(receipt(9));
      await view.result.current.channel.submit(event, signal);
      await view.result.current.channel.inspect(event.id, signal);
      expect(transport.ingestCanvasEvent).toHaveBeenCalledExactlyOnceWith(
        'doc-1',
        event,
        { expectedGeneration: nextBirth.generation },
        signal
      );
      expect(transport.getCanvasEventReceipt).toHaveBeenCalledExactlyOnceWith(
        'doc-1',
        event.id,
        { expectedGeneration: nextBirth.generation },
        signal
      );
      expect(vi.mocked(transport.getCanvasChannel).mock.calls.map(([, query]) => query)).toEqual(
        [0, 0].map((since) => ({ since, limit: 200 }))
      );
    } finally {
      view.unmount();
    }
  }
);

it('quarantines same-birth initial frame1 without advancing the HTTP cursor or duplicating its replay', async () => {
  const transport = createMockTransport();
  const initial = deferred<CanvasChannelReplayResponse>();
  vi.mocked(transport.getCanvasChannel).mockReturnValue(initial.promise);
  const view = renderHook(() => useDocChannel('doc-1'), { wrapper: wrapper(transport) });
  try {
    await publish(frame(1));
    expect(view.result.current.events).toEqual([]);
    expect(view.result.current.channel.enabled).toBe(false);
    await act(async () => initial.resolve(serverReplay(birth, 2, 0)));
    await waitFor(() => expect(view.result.current.channel.enabled).toBe(true));
    expect(view.result.current.events.map((event) => event.docSeq)).toEqual([1, 2]);
    expect(transport.getCanvasChannel).toHaveBeenCalledExactlyOnceWith('doc-1', {
      since: 0,
      limit: 200,
    });
    expect(transport.ingestCanvasEvent).not.toHaveBeenCalled();
    expect(transport.getCanvasEventReceipt).not.toHaveBeenCalled();
  } finally {
    view.unmount();
  }
});

it('retires StrictMode initial replay before a fresh controller can own the visible birth', async () => {
  const transport = createMockTransport();
  const stale = deferred<CanvasChannelReplayResponse>();
  const fresh = deferred<CanvasChannelReplayResponse>();
  const nextBirth = { ...birth, generation: 'f'.repeat(64) };
  vi.mocked(transport.getCanvasChannel)
    .mockReturnValueOnce(stale.promise)
    .mockReturnValueOnce(fresh.promise);
  const Base = wrapper(transport);
  const view = renderHook(() => useDocChannel('doc-1'), {
    wrapper: Base,
    reactStrictMode: true,
  });
  try {
    await waitFor(() => expect(transport.getCanvasChannel).toHaveBeenCalledTimes(2));
    const loading = view.result.current.channel;
    await act(async () => stale.resolve(serverReplay(birth, 100, 0)));
    expect(view.result.current.events).toEqual([]);
    expect(view.result.current.channel.snapshot).toBeUndefined();
    expect(view.result.current.channel.enabled).toBe(false);
    await act(async () => fresh.resolve(serverReplay(nextBirth, 2, 0)));
    await waitFor(() => expect(view.result.current.channel.enabled).toBe(true));
    expect(view.result.current.channel.snapshot).toMatchObject({ incarnation: nextBirth });
    expect(view.result.current.events).toEqual(serverReplay(nextBirth, 2, 0).events);
    await expect(loading.inspect(id(1), new AbortController().signal)).rejects.toMatchObject({
      status: 409,
    });
    const old = view.result.current.channel;
    view.unmount();
    await expect(
      old.submit(
        { v: 1, id: id(2), type: 'app.updated', payload: {} },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(transport.ingestCanvasEvent).not.toHaveBeenCalled();
    expect(transport.getCanvasEventReceipt).not.toHaveBeenCalled();
  } finally {
    view.unmount();
  }
});

it('guards deferred old-controller projection after a real Transport replacement', async () => {
  const first = createMockTransport();
  const second = createMockTransport();
  const nextBirth = { ...birth, generation: '9'.repeat(64) };
  vi.mocked(first.getCanvasChannel).mockResolvedValue(serverReplay(birth, 2, 0));
  vi.mocked(second.getCanvasChannel).mockResolvedValue(serverReplay(nextBirth, 1, 0));
  const queued: SetStateAction<DocChannelView>[] = [];
  let projected = emptyDocChannelView('doc-1', first);
  const old = createDocChannelRecovery('doc-1', first, (update) => queued.push(update));
  await waitFor(() => expect(queued.length).toBeGreaterThan(1));
  const oldCount = queued.length;
  old.dispose();
  const fresh = createDocChannelRecovery('doc-1', second, (update) => queued.push(update));
  try {
    await waitFor(() => expect(queued.length).toBeGreaterThan(oldCount + 1));
    for (const update of queued.slice(0, oldCount))
      projected = typeof update === 'function' ? update(projected) : update;
    expect(projected).toMatchObject({ available: false, events: [] });
    expect(projected.snapshot).toBeUndefined();
    for (const update of queued.slice(oldCount))
      projected = typeof update === 'function' ? update(projected) : update;
    expect(projected.transport).toBe(second);
    expect(projected.snapshot).toMatchObject({ incarnation: nextBirth });
    expect(projected.events).toEqual(serverReplay(nextBirth, 1, 0).events);
    const action = projected.binding!;
    expect(action.current('read')).toBe(true);
    fresh.dispose();
    expect(action.current('read')).toBe(false);
    await expect(action.inspect(id(10001), new AbortController().signal)).rejects.toMatchObject({
      status: 409,
    });
    expect(first.ingestCanvasEvent).not.toHaveBeenCalled();
    expect(second.getCanvasEventReceipt).not.toHaveBeenCalled();
  } finally {
    fresh.dispose();
  }
});

it('does not treat startup or a partial owned replay as the initial HTTP disposition', async () => {
  const transport = createMockTransport();
  const initial = deferred<CanvasChannelReplayResponse>();
  const tail = deferred<CanvasChannelReplayResponse>();
  vi.mocked(transport.getCanvasChannel)
    .mockReturnValueOnce(initial.promise)
    .mockReturnValueOnce(tail.promise);
  const view = renderHook(() => useDocChannel('doc-1'), { wrapper: wrapper(transport) });
  try {
    expect(view.result.current.replayObserved).toBe(false);
    expect(view.result.current.channel.current?.('submit')).toBe(false);
    await act(async () => initial.resolve(serverReplay(birth, 201, 0)));
    await waitFor(() => expect(transport.getCanvasChannel).toHaveBeenCalledTimes(2));
    expect(view.result.current.events).toHaveLength(200);
    expect(view.result.current.replayObserved).toBe(false);
    expect(view.result.current.channel.current?.('submit')).toBe(false);
    await act(async () => tail.resolve(serverReplay(birth, 201, 200)));
    await waitFor(() => expect(view.result.current.replayObserved).toBe(true));
    expect(view.result.current.channel.current?.('submit')).toBe(true);
    expect(view.result.current.events.at(-1)?.docSeq).toBe(201);
  } finally {
    view.unmount();
  }
});

it.each(['legacy', 'failure'] as const)(
  'allows terminal %s replay display without manufacturing a current Doc port',
  async (kind) => {
    const transport = createMockTransport();
    const initial = deferred<CanvasChannelReplayResponse>();
    vi.mocked(transport.getCanvasChannel).mockReturnValue(initial.promise);
    const view = renderHook(() => useDocChannel('doc-1'), { wrapper: wrapper(transport) });
    try {
      expect(view.result.current.replayObserved).toBe(false);
      await act(async () => {
        if (kind === 'legacy') initial.resolve(serverReplay(birth, 0, 0, 1, true));
        else initial.reject(new Error('Original HTTP replay refused'));
      });
      await waitFor(() => expect(view.result.current.replayObserved).toBe(true));
      expect(view.result.current.channel.current?.('read')).toBe(false);
      expect(view.result.current.channel.current?.('submit')).toBe(false);
      expect(transport.ingestCanvasEvent).not.toHaveBeenCalled();
      expect(transport.getCanvasEventReceipt).not.toHaveBeenCalled();
    } finally {
      view.unmount();
    }
  }
);

it.each(['snapshot', 'event'] as const)(
  'retries owned HTTP after a failed disconnect recovery and a same-birth %s',
  async (kind) => {
    const transport = createMockTransport();
    const refused = deferred<CanvasChannelReplayResponse>();
    const renewed = deferred<CanvasChannelReplayResponse>();
    vi.mocked(transport.getCanvasChannel)
      .mockResolvedValueOnce(replay())
      .mockReturnValueOnce(refused.promise)
      .mockReturnValue(renewed.promise);
    const view = renderHook(() => useDocChannel('doc-1'), { wrapper: wrapper(transport) });
    try {
      await waitFor(() => expect(view.result.current.channel.current?.('submit')).toBe(true));
      await act(async () =>
        ownDocChannelConnection(transport, new AbortController().signal).retire()
      );
      expect(transport.getCanvasChannel).toHaveBeenCalledTimes(2);
      expect(view.result.current.channel.current?.('submit')).toBe(false);
      await act(async () => refused.reject(new Error('Original HTTP replay refused')));
      const notification =
        kind === 'snapshot'
          ? { ...snapshot(replay()), scope: 'session:server-canonical' }
          : frame(1);
      await publish(notification);
      await waitFor(() => expect(transport.getCanvasChannel).toHaveBeenCalledTimes(3));
      // Stream DATA remains insufficient even when it projects the current birth.
      expect(view.result.current.channel.current?.('read')).toBe(false);
      expect(view.result.current.channel.current?.('submit')).toBe(false);
      await publish(notification);
      expect(transport.getCanvasChannel).toHaveBeenCalledTimes(3);
      expect(transport.ingestCanvasEvent).not.toHaveBeenCalled();
      expect(transport.getCanvasEventReceipt).not.toHaveBeenCalled();
      await act(async () =>
        renewed.resolve(
          kind === 'event' ? replay({ events: [frame(1)], highWatermark: 1 }) : replay()
        )
      );
      await waitFor(() => expect(view.result.current.channel.current?.('submit')).toBe(true));
      expect(view.result.current.channel.current?.('read')).toBe(true);
      expect(transport.getCanvasChannel).toHaveBeenCalledTimes(3);
      if (kind === 'event')
        expect(view.result.current.events.map((row) => row.docSeq)).toEqual([1]);
    } finally {
      view.unmount();
    }
  }
);
