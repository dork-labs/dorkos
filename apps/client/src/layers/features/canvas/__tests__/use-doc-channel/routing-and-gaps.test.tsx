// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import type { CanvasChannelReplayResponse, PageEvent } from '@dorkos/shared/canvas-channel-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { ownDocChannelConnection } from '@/layers/shared/lib/transport/doc-channel-ownership';
import type { ReactNode } from 'react';
import { useDocChannel } from '../../model/use-doc-channel';
import {
  birth,
  deferred,
  frame,
  id,
  publish,
  publishDocChannelNotification,
  receipt,
  replay,
  snapshot,
  wrapper,
  setTestOwner,
} from './fixtures';

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
            setTestOwner(currentTransport);
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
});
