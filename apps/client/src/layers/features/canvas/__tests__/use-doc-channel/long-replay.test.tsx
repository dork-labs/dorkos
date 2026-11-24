// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import type { CanvasChannelReplayResponse } from '@dorkos/shared/canvas-channel-schemas';
import { ownDocChannelConnection } from '@/layers/shared/lib/transport/doc-channel-ownership';
import { useDocChannel } from '../../model/use-doc-channel';
import {
  birth,
  deferred,
  frame,
  id,
  publish,
  publishDocChannelNotification,
  replay,
  serverReplay,
  wrapper,
} from './fixtures';

describe('useDocChannel catching up a long replay', () => {
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
