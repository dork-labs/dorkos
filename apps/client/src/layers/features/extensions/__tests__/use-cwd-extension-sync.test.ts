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
    const onChanged = vi.fn();
    renderHook(() => useCwdExtensionSync(onChanged));

    expect(mockFetch).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('calls POST /api/extensions/cwd-changed when CWD changes', async () => {
    mockFetch.mockReturnValue(mockCwdResponse({ changed: false, added: [], removed: [] }));

    renderHook(() => useCwdExtensionSync(vi.fn()));

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

  it('does not remount or toast when extensions are unchanged', async () => {
    mockFetch.mockReturnValue(mockCwdResponse({ changed: false, added: [], removed: [] }));

    const onChanged = vi.fn();
    renderHook(() => useCwdExtensionSync(onChanged));

    act(() => {
      useAppStore.getState().setSelectedCwd('/project-a');
    });

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });

    expect(toast.info).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('remounts extensions and toasts success only after the remount resolves', async () => {
    mockFetch.mockReturnValue(mockCwdResponse({ changed: true, added: ['ext-new'], removed: [] }));

    // Deferred remount — the success toast must wait for it.
    let resolveRemount!: () => void;
    const onChanged = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRemount = resolve;
        })
    );
    renderHook(() => useCwdExtensionSync(onChanged));

    act(() => {
      useAppStore.getState().setSelectedCwd('/project-b');
    });

    await vi.waitFor(() => {
      expect(onChanged).toHaveBeenCalledTimes(1);
    });
    // Remount still pending — no toast yet.
    expect(toast.info).not.toHaveBeenCalled();

    resolveRemount();

    await vi.waitFor(() => {
      expect(toast.info).toHaveBeenCalledWith('Project extensions updated');
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('shows an error toast (not success) when the remount fails', async () => {
    mockFetch.mockReturnValue(mockCwdResponse({ changed: true, added: ['ext-new'], removed: [] }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const onChanged = vi.fn().mockRejectedValue(new Error('fetch boom'));
    renderHook(() => useCwdExtensionSync(onChanged));

    act(() => {
      useAppStore.getState().setSelectedCwd('/project-fail');
    });

    await vi.waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Couldn't load this project's extensions");
    });
    expect(toast.info).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      '[extensions] Failed to apply the new extension set:',
      expect.any(Error)
    );

    errorSpy.mockRestore();
  });

  it('never reloads the page when the extension set changes', async () => {
    mockFetch.mockReturnValue(
      mockCwdResponse({ changed: true, added: ['ext-new'], removed: ['ext-old'] })
    );

    // Spy on location.reload to prove it is never invoked.
    const reloadSpy = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, reload: reloadSpy },
      writable: true,
      configurable: true,
    });

    const onChanged = vi.fn();
    renderHook(() => useCwdExtensionSync(onChanged));

    act(() => {
      useAppStore.getState().setSelectedCwd('/project-c');
    });

    // Wait until the remount handler ran, then assert no reload ever happened.
    await vi.waitFor(() => {
      expect(onChanged).toHaveBeenCalledTimes(1);
    });
    expect(reloadSpy).not.toHaveBeenCalled();

    // Restore
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
  });

  it('does not call the server when CWD is set to the same value', async () => {
    mockFetch.mockReturnValue(mockCwdResponse({ changed: false, added: [], removed: [] }));

    // Pre-set CWD before mounting the hook
    useAppStore.setState({ selectedCwd: '/same/project' });

    const onChanged = vi.fn();
    renderHook(() => useCwdExtensionSync(onChanged));

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
    expect(onChanged).not.toHaveBeenCalled();
  });

  describe('desktop (Electron) origin resolution', () => {
    afterEach(() => {
      delete (window as { electronAPI?: unknown }).electronAPI;
    });

    it('resolves against the preload server port under Electron (DOR-243)', async () => {
      window.electronAPI = {
        getServerPort: vi.fn(() => 6242),
      } as unknown as Window['electronAPI'];

      mockFetch.mockReturnValue(mockCwdResponse({ changed: false, added: [], removed: [] }));

      renderHook(() => useCwdExtensionSync(vi.fn()));

      act(() => {
        useAppStore.getState().setSelectedCwd('/desktop/project');
      });

      await vi.waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith('http://localhost:6242/api/extensions/cwd-changed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cwd: '/desktop/project' }),
        });
      });
    });
  });

  it('handles fetch errors gracefully without crashing', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const onChanged = vi.fn();
    renderHook(() => useCwdExtensionSync(onChanged));

    act(() => {
      useAppStore.getState().setSelectedCwd('/error/project');
    });

    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalled();
    });

    expect(toast.info).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});
