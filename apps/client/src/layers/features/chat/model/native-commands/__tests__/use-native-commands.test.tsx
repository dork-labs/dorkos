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
      runtime: 'claude-code',
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

  it('renames the current session for "/rename Foo" and reports handled + ran', async () => {
    // Happy path: the title is forwarded to the existing rename transport.
    const { result } = setup('s1', '/repo');
    let outcome: ReturnType<typeof result.current.tryRun> = { handled: false };
    act(() => {
      outcome = result.current.tryRun('/rename Foo');
    });
    expect(outcome).toEqual({ handled: true, ran: true });
    await waitFor(() =>
      expect(transport.updateSession).toHaveBeenCalledWith('s1', { title: 'Foo' }, '/repo')
    );
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Renamed session to "Foo"'));
  });

  it('only shows the success toast after the rename succeeds, never on a failure', async () => {
    // Finding 2/7: the success toast moved into the mutation's onSuccess. A
    // rejected updateSession rolls the title back and surfaces an error toast —
    // it must NOT also flash a green "Renamed session" success.
    vi.mocked(transport.updateSession).mockRejectedValue(new Error('boom'));
    const { result } = setup('s1', '/repo');
    act(() => {
      result.current.tryRun('/rename Foo');
    });
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Failed to rename session'));
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('collapses internal whitespace/newlines in the title before renaming', async () => {
    // Finding 5: a Shift+Enter multi-line title must not render garbled in the
    // sidebar — runs of whitespace collapse to single spaces.
    const { result } = setup('s1', '/repo');
    act(() => {
      result.current.tryRun('/rename Line1\n\n  Line2   Line3');
    });
    await waitFor(() =>
      expect(transport.updateSession).toHaveBeenCalledWith(
        's1',
        { title: 'Line1 Line2 Line3' },
        '/repo'
      )
    );
  });

  it('treats "/rename" with no argument as handled-but-not-ran (usage hint, no rename)', () => {
    // No-arg is a no-op per ideation Decision 2 — never reaches the runtime, and
    // `ran: false` lets the send path keep the composer text so the user can fix it.
    const { result } = setup('s1', '/repo');
    let outcome: ReturnType<typeof result.current.tryRun> = { handled: false };
    act(() => {
      outcome = result.current.tryRun('/rename');
    });
    expect(outcome).toEqual({ handled: true, ran: false });
    expect(transport.updateSession).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('Usage: /rename'));
  });

  it('guards against renaming when there is no active session (handled, not ran)', () => {
    const { result } = setup(null, '/repo');
    let outcome: ReturnType<typeof result.current.tryRun> = { handled: false };
    act(() => {
      outcome = result.current.tryRun('/rename Foo');
    });
    expect(outcome).toEqual({ handled: true, ran: false });
    expect(transport.updateSession).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalled();
  });

  it('falls through (handled: false) for unregistered commands and plain text', () => {
    const { result } = setup('s1', '/repo');
    expect(result.current.tryRun('/unknown thing')).toEqual({ handled: false });
    expect(result.current.tryRun('hello world')).toEqual({ handled: false });
    expect(transport.updateSession).not.toHaveBeenCalled();
  });
});
