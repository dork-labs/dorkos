// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useDocPresence } from '../model/use-doc-presence';
const viewer = '00000000-0000-4000-8000-000000000001';
const replacement = '00000000-0000-4000-8000-000000000002';
const result = (viewerId = viewer, views = 1) => ({
  viewerId,
  views,
  heartbeatMs: 30000 as const,
  ttlMs: 75000 as const,
});

describe('one original document host mount', () => {
  it('starts one native mount under real StrictMode effect replay and retains a pending original response', async () => {
    let finish!: (value: ReturnType<typeof result>) => void;
    const held = new Promise<ReturnType<typeof result>>((resolve) => {
      finish = resolve;
    });
    const call = vi
      .fn()
      .mockImplementation((_id, request) =>
        request.action === 'mount' ? held : Promise.resolve(result(viewer, 0))
      );
    const transport = createMockTransport({ updateCanvasDocPresence: call });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </StrictMode>
    );
    const mounted = renderHook(() => useDocPresence('doc'), { wrapper });
    try {
      await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
      const original = call.mock.calls[0][1];
      expect(original).toMatchObject({ action: 'mount', mountId: expect.any(String) });
      expect(Object.isFrozen(original)).toBe(true);
      expect(mounted.result.current.views).toBeUndefined();
      await act(async () => {
        finish(result());
        await held;
      });
      await waitFor(() => expect(mounted.result.current.views).toBe(1));
      expect(call).toHaveBeenCalledTimes(1);
      mounted.unmount();
      await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
      expect(call.mock.calls[1]).toEqual(['doc', { action: 'unmount', viewerId: viewer }]);
    } finally {
      finish(result());
      mounted.unmount();
      await act(async () => {
        await held;
      });
    }
  });
  it('starts no native presence operation for a setup retired before its initial work begins', async () => {
    const call = vi.fn().mockResolvedValue(result());
    const transport = createMockTransport({ updateCanvasDocPresence: call });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TransportProvider transport={transport}>{children}</TransportProvider>
    );
    const mounted = renderHook(() => useDocPresence('doc'), { wrapper });
    mounted.unmount();
    await act(async () => {});
    expect(call).not.toHaveBeenCalled();
  });

  it('owns the late mount response and unmounts it after retirement without publishing a fabricated count', async () => {
    let finish!: (value: ReturnType<typeof result>) => void;
    const held = new Promise<ReturnType<typeof result>>((resolve) => {
      finish = resolve;
    });
    const transport = createMockTransport({
      updateCanvasDocPresence: vi
        .fn()
        .mockImplementation((_id, request) =>
          request.action === 'mount' ? held : Promise.resolve(result(viewer, 0))
        ),
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TransportProvider transport={transport}>{children}</TransportProvider>
    );
    const mounted = renderHook(() => useDocPresence('doc'), { wrapper });
    expect(mounted.result.current.views).toBeUndefined();
    await waitFor(() => expect(transport.updateCanvasDocPresence).toHaveBeenCalledTimes(1));
    mounted.unmount();
    await act(async () => {
      finish(result());
      await held;
    });
    await waitFor(() =>
      expect(transport.updateCanvasDocPresence).toHaveBeenCalledWith('doc', {
        action: 'unmount',
        viewerId: viewer,
      })
    );
    expect(transport.updateCanvasDocPresence).toHaveBeenCalledTimes(2);
  });
  it('uses the exact30second heartbeat, never remounts on unknown transport failure, and remounts only after actual404', async () => {
    vi.useFakeTimers();
    const call = vi
      .fn()
      .mockResolvedValueOnce(result())
      .mockRejectedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error('original viewer absent'), { status: 404 }))
      .mockResolvedValueOnce(result(replacement))
      .mockResolvedValue(result(replacement, 0));
    const transport = createMockTransport({ updateCanvasDocPresence: call });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TransportProvider transport={transport}>{children}</TransportProvider>
    );
    const mounted = renderHook(() => useDocPresence('doc'), { wrapper });
    try {
      await act(async () => {});
      expect(mounted.result.current.views).toBe(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(29999);
      });
      expect(call).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(call.mock.calls[1]).toEqual(['doc', { action: 'heartbeat', viewerId: viewer }]);
      expect(mounted.result.current.views).toBeUndefined();
      expect(call).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30000);
      });
      expect(call.mock.calls[2]).toEqual(['doc', { action: 'heartbeat', viewerId: viewer }]);
      expect(call.mock.calls[3]).toEqual(call.mock.calls[0]);
      expect(call.mock.calls[0][1]).toMatchObject({ action: 'mount', mountId: expect.any(String) });
      mounted.unmount();
      await act(async () => {});
      expect(call.mock.calls[4]).toEqual(['doc', { action: 'unmount', viewerId: replacement }]);
    } finally {
      mounted.unmount();
      vi.useRealTimers();
    }
  });
  it('retries an unknown initial response with the same frozen logical mount before owning its issued viewer', async () => {
    vi.useFakeTimers();
    const call = vi
      .fn()
      .mockRejectedValueOnce(undefined)
      .mockResolvedValueOnce(result())
      .mockResolvedValue(result(viewer, 0));
    const transport = createMockTransport({ updateCanvasDocPresence: call });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TransportProvider transport={transport}>{children}</TransportProvider>
    );
    const mounted = renderHook(() => useDocPresence('doc'), { wrapper });
    try {
      await act(async () => {});
      expect(mounted.result.current.views).toBeUndefined();
      const first = call.mock.calls[0][1];
      expect(first).toMatchObject({ action: 'mount', mountId: expect.any(String) });
      expect(Object.isFrozen(first)).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(call.mock.calls[1][1]).toBe(first);
      expect(mounted.result.current.views).toBe(1);
      mounted.unmount();
      await act(async () => {});
      expect(call.mock.calls[2]).toEqual(['doc', { action: 'unmount', viewerId: viewer }]);
    } finally {
      mounted.unmount();
      vi.useRealTimers();
    }
  });
});
