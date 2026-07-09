/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
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
    window.electronAPI = { onNavigate } as unknown as Window['electronAPI'];

    renderHook(() => useElectronNavigate());

    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith({ href: '/agents' });
  });

  it('unsubscribes on unmount', () => {
    const unsubscribe = vi.fn();
    const onNavigate = vi.fn(() => unsubscribe);
    window.electronAPI = { onNavigate } as unknown as Window['electronAPI'];

    const { unmount } = renderHook(() => useElectronNavigate());
    expect(unsubscribe).not.toHaveBeenCalled();

    unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
