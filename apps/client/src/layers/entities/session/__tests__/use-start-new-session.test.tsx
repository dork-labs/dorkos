// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { renderHook, act } from '@testing-library/react';

// The active agent comes from the REAL app store's `selectedCwd`, so a hook
// that read the wrong field, or the store losing it, turns the fallback red.
vi.mock('@/layers/entities/session/model/navigation/use-session-search', () => ({
  useSessionSearch: () => ({}),
}));

const mockNavigate = vi.fn((_opts: { to: string; search: Record<string, unknown> }) => {});
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => mockNavigate,
}));

import { useStartNewSession } from '../model/navigation/use-session-id';

const transport = createMockTransport();
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <TransportProvider transport={transport}>{children}</TransportProvider>
);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('useStartNewSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({ selectedCwd: null });
  });

  it('opens a brand-new conversation on the named agent, over the active one', async () => {
    useAppStore.setState({ selectedCwd: '/projects/current' });
    const { result } = renderHook(() => useStartNewSession(), { wrapper });
    await act(async () => {
      await result.current('/projects/beta');
    });

    expect(transport.createSessionLocation).toHaveBeenCalledWith('/projects/beta');
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: expect.objectContaining({
        launchRef: 'test-location',
        draft: '1',
        session: expect.stringMatching(UUID),
      }),
    });
  });

  it('mints a different id every time — otherwise it is not new', async () => {
    const { result } = renderHook(() => useStartNewSession(), { wrapper });
    await act(async () => {
      await result.current('/projects/beta');
    });
    await act(async () => {
      await result.current('/projects/beta');
    });

    const ids = mockNavigate.mock.calls.map((c) => c[0].search.session);
    expect(new Set(ids).size).toBe(2);
  });

  it('falls back to the active agent when none is named', async () => {
    useAppStore.setState({ selectedCwd: '/projects/current' });
    const { result } = renderHook(() => useStartNewSession(), { wrapper });
    await act(async () => {
      await result.current();
    });

    expect(transport.createSessionLocation).toHaveBeenCalledWith('/projects/current');
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: expect.objectContaining({
        launchRef: 'test-location',
        draft: '1',
        session: expect.stringMatching(UUID),
      }),
    });
  });
});
