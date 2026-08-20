// @vitest-environment jsdom
/**
 * `copyPath`'s two branches: silent on success (the menu closing is the
 * acknowledgement), one explicit toast on a clipboard write the browser
 * refuses. A hook-level test alongside `FileExplorer`'s own integration
 * coverage (`file-explorer-actions.test.tsx`) — this one pins the contract
 * at `useFileActions` itself, independent of the context-menu UI that reaches
 * it.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { FileEntry } from '@dorkos/shared/types';
import { TransportProvider } from '@/layers/shared/model';
import { useFileActions } from '../model/use-file-actions';

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: toastError, success: toastSuccess } }));

function wrapperFor() {
  const transport = createMockTransport();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return Wrapper;
}

function readme(): FileEntry {
  return {
    name: 'README.md',
    path: 'README.md',
    type: 'file',
    size: 1,
    mtime: 0,
    isSymlink: false,
  };
}

/** Stub `navigator.clipboard.writeText` to resolve or reject on demand. */
function stubClipboard(behavior: 'resolve' | 'reject') {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText:
        behavior === 'resolve'
          ? vi.fn().mockResolvedValue(undefined)
          : vi.fn().mockRejectedValue(new Error('denied')),
    },
  });
}

beforeEach(() => {
  toastError.mockClear();
  toastSuccess.mockClear();
});

describe('useFileActions — copyPath', () => {
  it('copies the relative path and says nothing when it works', async () => {
    stubClipboard('resolve');
    const { result } = renderHook(() => useFileActions('/repo'), { wrapper: wrapperFor() });

    await act(async () => {
      await result.current.copyPath(readme(), 'relative');
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('README.md');
    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('fires the explicit failure toast when the clipboard write is refused', async () => {
    stubClipboard('reject');
    const { result } = renderHook(() => useFileActions('/repo'), { wrapper: wrapperFor() });

    await act(async () => {
      await result.current.copyPath(readme(), 'relative');
    });

    expect(toastError).toHaveBeenCalledWith("Couldn't copy to the clipboard");
  });
});
