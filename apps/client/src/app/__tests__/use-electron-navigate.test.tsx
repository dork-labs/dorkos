/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup, waitFor } from '@testing-library/react';
import { useElectronNavigate } from '../use-electron-navigate';

const mockNavigate = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

afterEach(() => {
  cleanup();
  delete (window as { electronAPI?: unknown }).electronAPI;
});

describe('useElectronNavigate', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
  });

  it('does nothing when window.electronAPI is absent (browser/Obsidian)', () => {
    renderHook(() => useElectronNavigate());
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('subscribes to onNavigate on mount and forwards the path to the router', () => {
    const unsubscribe = vi.fn();
    const onNavigate = vi.fn((cb: (path: string) => void) => {
      cb('/agents');
      return unsubscribe;
    });
    window.electronAPI = {
      onNavigate,
      getPendingNavigate: vi.fn(() => Promise.resolve(null)),
    } as unknown as Window['electronAPI'];

    renderHook(() => useElectronNavigate());

    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith({ href: '/agents' });
  });

  it('unsubscribes on unmount', () => {
    const unsubscribe = vi.fn();
    const onNavigate = vi.fn(() => unsubscribe);
    window.electronAPI = {
      onNavigate,
      getPendingNavigate: vi.fn(() => Promise.resolve(null)),
    } as unknown as Window['electronAPI'];

    const { unmount } = renderHook(() => useElectronNavigate());
    expect(unsubscribe).not.toHaveBeenCalled();

    unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('pulls a pending path on mount (right after subscribing) and navigates to it', async () => {
    const onNavigate = vi.fn(() => vi.fn());
    const getPendingNavigate = vi.fn(() => Promise.resolve('/session?id=42'));
    window.electronAPI = { onNavigate, getPendingNavigate } as unknown as Window['electronAPI'];

    renderHook(() => useElectronNavigate());

    expect(getPendingNavigate).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith({ href: '/session?id=42' });
    });
  });

  it('does not navigate when there is no pending path', async () => {
    const onNavigate = vi.fn(() => vi.fn());
    const getPendingNavigate = vi.fn(() => Promise.resolve(null));
    window.electronAPI = { onNavigate, getPendingNavigate } as unknown as Window['electronAPI'];

    renderHook(() => useElectronNavigate());

    await waitFor(() => expect(getPendingNavigate).toHaveBeenCalledTimes(1));
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
