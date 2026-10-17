/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { AuthClientProvider } from '../model/auth-client-context';
import { PUBLIC_COMPUTER_IDLE_MS, usePublicComputerIdleSignOut } from '../model/use-auth-session';
import { createFakeAuthClient } from './fake-auth-client';

const reload = vi.fn();

function wrapperFor(publicComputer: boolean, signOut: ReturnType<typeof vi.fn>) {
  const client = createFakeAuthClient({
    getSession: vi.fn().mockResolvedValue({
      data: {
        user: { id: 'u1', email: 'o@example.invalid', name: 'O' },
        session: { id: 's1', expiresAt: '2099-01-01T00:00:00Z', userId: 'u1', publicComputer },
      },
      error: null,
    }),
    signOut: signOut as never,
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <AuthClientProvider client={client}>{children}</AuthClientProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  reload.mockReset();
  vi.stubGlobal('location', { ...window.location, reload });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  cleanup();
});

describe('signing out a public computer left idle', () => {
  it('signs out after the idle time with nobody using the page', async () => {
    const signOut = vi.fn().mockResolvedValue({ data: { success: true }, error: null });
    renderHook(() => usePublicComputerIdleSignOut(), { wrapper: wrapperFor(true, signOut) });
    await act(async () => vi.advanceTimersByTimeAsync(10));
    await act(async () => vi.advanceTimersByTimeAsync(PUBLIC_COMPUTER_IDLE_MS - 1_000));
    expect(signOut).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalled();
  });

  it('starts the wait again whenever someone uses the page', async () => {
    const signOut = vi.fn().mockResolvedValue({ data: { success: true }, error: null });
    renderHook(() => usePublicComputerIdleSignOut(), { wrapper: wrapperFor(true, signOut) });
    await act(async () => vi.advanceTimersByTimeAsync(10));
    await act(async () => vi.advanceTimersByTimeAsync(PUBLIC_COMPUTER_IDLE_MS - 1_000));
    window.dispatchEvent(new Event('keydown'));
    await act(async () => vi.advanceTimersByTimeAsync(PUBLIC_COMPUTER_IDLE_MS - 1_000));
    expect(signOut).not.toHaveBeenCalled();
  });

  it('never signs out an ordinary session', async () => {
    const signOut = vi.fn().mockResolvedValue({ data: { success: true }, error: null });
    renderHook(() => usePublicComputerIdleSignOut(), { wrapper: wrapperFor(false, signOut) });
    await act(async () => vi.advanceTimersByTimeAsync(PUBLIC_COMPUTER_IDLE_MS * 2));
    expect(signOut).not.toHaveBeenCalled();
  });
});
