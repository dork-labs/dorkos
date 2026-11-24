// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import type { SetStateAction } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import type { CanvasChannelReplayResponse, PageEvent } from '@dorkos/shared/canvas-channel-schemas';
import { ownDocChannelConnection } from '@/layers/shared/lib/transport/doc-channel-ownership';
import { useDocChannel } from '../../model/use-doc-channel';
import { createDocChannelRecovery } from '../../model/doc-channel-recovery';
import { emptyDocChannelView, type DocChannelView } from '../../model/doc-channel-view';
import {
  birth,
  deferred,
  frame,
  id,
  publish,
  receipt,
  replay,
  serverReplay,
  snapshot,
  wrapper,
} from './fixtures';

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
