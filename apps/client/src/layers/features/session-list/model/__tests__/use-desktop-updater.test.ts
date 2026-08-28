// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDesktopUpdater } from '../use-desktop-updater';

afterEach(() => {
  vi.restoreAllMocks();
  delete window.electronAPI;
});

describe('useDesktopUpdater', () => {
  /** Build a desktop `electronAPI` stub, capturing the status callback so tests can drive events. */
  function stubDesktop(getUpdateStatus = vi.fn().mockResolvedValue(null)) {
    const emitRef: { current?: (status: DesktopUpdateStatus) => void } = {};
    const unsubscribe = vi.fn();
    const restartToUpdate = vi.fn();
    window.electronAPI = {
      onUpdateStatus: (cb: (status: DesktopUpdateStatus) => void) => {
        emitRef.current = cb;
        return unsubscribe;
      },
      restartToUpdate,
      getUpdateStatus,
    } as unknown as ElectronAPI;
    return { emitRef, unsubscribe, restartToUpdate, getUpdateStatus };
  }

  it('reports isDesktop false and never subscribes in the browser', () => {
    const { result } = renderHook(() => useDesktopUpdater());

    expect(result.current.isDesktop).toBe(false);
    expect(result.current.status).toBeNull();
    // restart is a safe no-op when the bridge is absent.
    expect(() => result.current.restart()).not.toThrow();
  });

  it('subscribes to onUpdateStatus and exposes the latest status on desktop', () => {
    const { emitRef, unsubscribe, restartToUpdate } = stubDesktop();

    const { result, unmount } = renderHook(() => useDesktopUpdater());

    expect(result.current.isDesktop).toBe(true);
    expect(result.current.status).toBeNull();

    act(() => emitRef.current?.({ state: 'downloaded', version: '2.0.0' }));
    expect(result.current.status).toEqual({ state: 'downloaded', version: '2.0.0' });

    result.current.restart();
    expect(restartToUpdate).toHaveBeenCalledTimes(1);

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('replays a downloaded update on mount via getUpdateStatus (macOS close→reopen)', async () => {
    stubDesktop(vi.fn().mockResolvedValue({ state: 'downloaded', version: '2.0.0' }));

    const { result } = renderHook(() => useDesktopUpdater());

    // No live event fired — status is recovered purely from the replay.
    await vi.waitFor(() =>
      expect(result.current.status).toEqual({ state: 'downloaded', version: '2.0.0' })
    );
  });

  it('does not let a transient status clear an already-showing downloaded card', () => {
    const { emitRef } = stubDesktop();

    const { result } = renderHook(() => useDesktopUpdater());

    act(() => emitRef.current?.({ state: 'downloaded', version: '2.0.0' }));
    expect(result.current.status).toEqual({ state: 'downloaded', version: '2.0.0' });

    // A background re-check emits checking → available; neither is actionable
    // and must not blink the card out.
    act(() => emitRef.current?.({ state: 'checking' }));
    act(() => emitRef.current?.({ state: 'available', version: '3.0.0' }));
    expect(result.current.status).toEqual({ state: 'downloaded', version: '2.0.0' });

    // A genuinely newer download progressing may replace it.
    act(() => emitRef.current?.({ state: 'downloading', percent: 10 }));
    expect(result.current.status).toEqual({ state: 'downloading', percent: 10 });
  });
});

/**
 * The card stopped lying (spec `desktop-updater-overhaul` D3).
 *
 * `foldStatus` used to keep "Restart to install" showing over every later
 * `error`, which is how a machine that had not installed anything in ten days
 * still offered a restart. These are the two states that now get through, and
 * the one rule that keeps a recorded failure from being papered over.
 */
describe('useDesktopUpdater — statuses that must not be swallowed', () => {
  /** Build a desktop `electronAPI` stub, capturing the status callback so tests can drive events. */
  function stubDesktop(getUpdateStatus = vi.fn().mockResolvedValue(null)) {
    const emitRef: { current?: (status: DesktopUpdateStatus) => void } = {};
    window.electronAPI = {
      onUpdateStatus: (cb: (status: DesktopUpdateStatus) => void) => {
        emitRef.current = cb;
        return vi.fn();
      },
      restartToUpdate: vi.fn(),
      getUpdateStatus,
    } as unknown as ElectronAPI;
    return emitRef;
  }

  /** A failure showing on the card: the app came back up as the old version. */
  const FAILED: DesktopUpdateStatus = { state: 'install-failed', version: '0.63.0', attempts: 2 };

  it('lets an error replace a downloaded update, instead of hiding it', () => {
    const emitRef = stubDesktop();
    const { result } = renderHook(() => useDesktopUpdater());

    act(() => emitRef.current?.({ state: 'downloaded', version: '2.0.0' }));
    act(() => emitRef.current?.({ state: 'error', message: 'signature check failed' }));

    expect(result.current.status).toEqual({ state: 'error', message: 'signature check failed' });
  });

  it('lets a failed install replace whatever the card was showing', () => {
    const emitRef = stubDesktop();
    const { result } = renderHook(() => useDesktopUpdater());

    act(() => emitRef.current?.({ state: 'downloaded', version: '0.63.0' }));
    act(() => emitRef.current?.(FAILED));

    expect(result.current.status).toEqual(FAILED);
  });

  it.each<[string, DesktopUpdateStatus]>([
    ['a background re-check', { state: 'checking' }],
    ['a newer version being announced', { state: 'available', version: '0.64.0' }],
    ['nothing new', { state: 'not-available' }],
    ['an unrelated network error', { state: 'error', message: 'offline' }],
    ['a download in progress', { state: 'downloading', percent: 50 }],
    ['the SAME version downloading again', { state: 'downloaded', version: '0.63.0' }],
    ['an OLDER version downloading', { state: 'downloaded', version: '0.62.0' }],
  ])('keeps the failure showing through %s', (_name, next) => {
    const emitRef = stubDesktop();
    const { result } = renderHook(() => useDesktopUpdater());

    act(() => emitRef.current?.(FAILED));
    act(() => emitRef.current?.(next));

    // The updater re-downloads and re-stages the version that just failed, and
    // a `downloading` carries no version at all — neither is the failure ending.
    expect(result.current.status).toEqual(FAILED);
  });

  it('lets a genuinely newer version, once downloaded, clear the failure', () => {
    const emitRef = stubDesktop();
    const { result } = renderHook(() => useDesktopUpdater());

    act(() => emitRef.current?.(FAILED));
    act(() => emitRef.current?.({ state: 'downloaded', version: '0.64.0' }));

    expect(result.current.status).toEqual({ state: 'downloaded', version: '0.64.0' });
  });

  it('recovers a failed install on a renderer that mounts later', async () => {
    // macOS close→reopen: the verdict was pushed at launch, long before this
    // React tree existed.
    stubDesktop(vi.fn().mockResolvedValue(FAILED));

    const { result } = renderHook(() => useDesktopUpdater());

    await vi.waitFor(() => expect(result.current.status).toEqual(FAILED));
  });
});
