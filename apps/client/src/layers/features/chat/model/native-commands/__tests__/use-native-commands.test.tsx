/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { useNativeCommands } from '../use-native-commands';

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (message: string) => toastSuccess(message),
    error: (message: string) => toastError(message),
  },
}));

describe('useNativeCommands', () => {
  let transport: ReturnType<typeof createMockTransport>;

  beforeEach(() => {
    vi.clearAllMocks();
    transport = createMockTransport();
    vi.mocked(transport.updateSession).mockResolvedValue({
      id: 's1',
      title: 'Foo',
      createdAt: '',
      updatedAt: '',
      permissionMode: 'default',
    });
  });

  function setup(sessionId: string | null = 's1', cwd: string | null = '/repo') {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
    return renderHook(() => useNativeCommands(cwd, sessionId), { wrapper });
  }

  it('renames the current session for "/rename Foo" and reports it handled', async () => {
    // Happy path: the title is forwarded to the existing rename transport.
    const { result } = setup('s1', '/repo');
    let handled = false;
    act(() => {
      handled = result.current.tryRun('/rename Foo');
    });
    expect(handled).toBe(true);
    await waitFor(() =>
      expect(transport.updateSession).toHaveBeenCalledWith('s1', { title: 'Foo' }, '/repo')
    );
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('treats "/rename" with no argument as handled but shows a usage hint (no rename)', () => {
    // No-arg is a no-op per ideation Decision 2 — never reaches the runtime.
    const { result } = setup('s1', '/repo');
    let handled = false;
    act(() => {
      handled = result.current.tryRun('/rename');
    });
    expect(handled).toBe(true);
    expect(transport.updateSession).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('Usage: /rename'));
  });

  it('guards against renaming when there is no active session', () => {
    const { result } = setup(null, '/repo');
    let handled = false;
    act(() => {
      handled = result.current.tryRun('/rename Foo');
    });
    expect(handled).toBe(true);
    expect(transport.updateSession).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalled();
  });

  it('falls through (returns false) for unregistered commands and plain text', () => {
    const { result } = setup('s1', '/repo');
    expect(result.current.tryRun('/unknown thing')).toBe(false);
    expect(result.current.tryRun('hello world')).toBe(false);
    expect(transport.updateSession).not.toHaveBeenCalled();
  });
});
