/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// Mock sonner toast
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

import { toast } from 'sonner';
import { useAppStore } from '@/layers/shared/model';
import { useCwdExtensionSync } from '../model/use-cwd-extension-sync';

// Mock fetch globally
const mockFetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = mockFetch;

  // Reset CWD in the store to a known baseline
  useAppStore.setState({ selectedCwd: null });
});

afterEach(() => {
  // Ensure all hooks are unmounted before the next test
  cleanup();
});

/** Helper to build a mock fetch response. */
function mockCwdResponse(body: { changed: boolean; added: string[]; removed: string[] }) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(body),
  });
}

describe('useCwdExtensionSync', () => {
  it('does not call the server on initial mount', () => {
    renderHook(() => useCwdExtensionSync());

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('calls POST /api/extensions/cwd-changed when CWD changes', async () => {
    mockFetch.mockReturnValue(mockCwdResponse({ changed: false, added: [], removed: [] }));

    renderHook(() => useCwdExtensionSync());

    // Simulate a CWD change via the store
    act(() => {
      useAppStore.getState().setSelectedCwd('/new/project');
    });

    // Let the async fetch resolve
    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/extensions/cwd-changed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: '/new/project' }),
      });
    });
  });

  it('does not show toast when extensions are unchanged', async () => {
    mockFetch.mockReturnValue(mockCwdResponse({ changed: false, added: [], removed: [] }));

    renderHook(() => useCwdExtensionSync());

    act(() => {
      useAppStore.getState().setSelectedCwd('/project-a');
    });

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });

    expect(toast.info).not.toHaveBeenCalled();
  });

  it('shows toast when extensions changed', async () => {
    mockFetch.mockReturnValue(mockCwdResponse({ changed: true, added: ['ext-new'], removed: [] }));

    renderHook(() => useCwdExtensionSync());

    act(() => {
      useAppStore.getState().setSelectedCwd('/project-b');
    });

    await vi.waitFor(() => {
      expect(toast.info).toHaveBeenCalledWith('Project extensions changed. Reloading...', {
        duration: 1500,
      });
    });
  });

  it('schedules page reload 1.5s after showing toast', async () => {
    vi.useFakeTimers();

    mockFetch.mockReturnValue(
      mockCwdResponse({ changed: true, added: ['ext-new'], removed: ['ext-old'] })
    );

    // Mock location.reload
    const reloadSpy = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, reload: reloadSpy },
      writable: true,
      configurable: true,
    });

    renderHook(() => useCwdExtensionSync());

    act(() => {
      useAppStore.getState().setSelectedCwd('/project-c');
    });

    // Let the fetch promise resolve
    await vi.advanceTimersByTimeAsync(50);

    // Toast should be shown
    expect(toast.info).toHaveBeenCalledTimes(1);

    // Reload should not have been called yet
    expect(reloadSpy).not.toHaveBeenCalled();

    // Advance past the 1.5s reload delay
    await vi.advanceTimersByTimeAsync(1500);

    expect(reloadSpy).toHaveBeenCalledTimes(1);

    // Restore
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
    vi.useRealTimers();
  });

  it('does not call the server when CWD is set to the same value', async () => {
    mockFetch.mockReturnValue(mockCwdResponse({ changed: false, added: [], removed: [] }));

    // Pre-set CWD before mounting the hook
    useAppStore.setState({ selectedCwd: '/same/project' });

    renderHook(() => useCwdExtensionSync());

    // Clear any mocks that may have fired during mount
    mockFetch.mockClear();

    // "Change" to the same value — should be a no-op since selectedCwd selector returns same value
    act(() => {
      // Direct setState to avoid triggering recentCwds change
      useAppStore.setState({ selectedCwd: '/same/project' });
    });

    // Give time for any async operations
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('handles fetch errors gracefully without crashing', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderHook(() => useCwdExtensionSync());

    act(() => {
      useAppStore.getState().setSelectedCwd('/error/project');
    });

    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalled();
    });

    expect(toast.info).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});
