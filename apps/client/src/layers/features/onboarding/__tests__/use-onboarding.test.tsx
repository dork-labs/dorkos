/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';

import { useOnboarding } from '../model/use-onboarding';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createWrapper(transport = createMockTransport()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  };
}

/** A fresh onboarding block (nothing done yet). */
const FRESH_ONBOARDING = {
  completedSteps: [],
  skippedSteps: [],
  startedAt: null,
  dismissedAt: null,
  completedAt: null,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useOnboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shouldShowOnboarding returns true for a fresh install (no completedAt, not dismissed)', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConfig).mockResolvedValue({
      onboarding: { ...FRESH_ONBOARDING },
    } as never);

    const { result } = renderHook(() => useOnboarding(), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.shouldShowOnboarding).toBe(true);
      expect(result.current.shouldShowGettingStarted).toBe(false);
    });
  });

  it('a config read that FAILED is not a fresh install', async () => {
    // The wizard's inputs all fall back to "nothing done yet" when there is no
    // config, and a failed read has no config — so a settled install whose
    // server was down came back reading brand new, and the overlay's latch made
    // that permanent for the session (DOR-1475). The honest answer to "should
    // the first-run flow show" while the server is unreachable is no: we have
    // not been told, and being told is what a fresh install looks like.
    const transport = createMockTransport();
    vi.mocked(transport.getConfig).mockRejectedValue(new Error('Failed to fetch'));

    const { result } = renderHook(() => useOnboarding(), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.shouldShowOnboarding).toBe(false);
    expect(result.current.shouldShowGettingStarted).toBe(false);
  });

  it('completedAt is authoritative: a finished install never re-shows the flow, even with skipped steps', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConfig).mockResolvedValue({
      onboarding: {
        completedSteps: ['meet-dorkbot'],
        skippedSteps: ['discovery'],
        startedAt: '2026-07-20T00:00:00.000Z',
        dismissedAt: null,
        completedAt: '2026-07-21T00:00:00.000Z',
      },
    } as never);

    const { result } = renderHook(() => useOnboarding(), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.isOnboardingComplete).toBe(true);
      expect(result.current.shouldShowOnboarding).toBe(false);
      // The getting-started helper takes over once the flow is finished.
      expect(result.current.shouldShowGettingStarted).toBe(true);
    });
  });

  it('normalizes an absent completedAt to null (upgrade window) — not read as complete', async () => {
    const transport = createMockTransport();
    // A pre-completedAt config block: the field is simply missing.
    vi.mocked(transport.getConfig).mockResolvedValue({
      onboarding: {
        completedSteps: ['meet-dorkbot', 'discovery'],
        skippedSteps: [],
        startedAt: '2026-07-20T00:00:00.000Z',
        dismissedAt: null,
      },
    } as never);

    const { result } = renderHook(() => useOnboarding(), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.state.completedAt).toBeNull();
      expect(result.current.isOnboardingComplete).toBe(false);
      expect(result.current.shouldShowOnboarding).toBe(true);
    });
  });

  it('shouldShowOnboarding returns false when dismissed', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConfig).mockResolvedValue({
      onboarding: {
        ...FRESH_ONBOARDING,
        dismissedAt: '2026-01-01T00:00:00.000Z',
      },
    } as never);

    const { result } = renderHook(() => useOnboarding(), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.shouldShowOnboarding).toBe(false);
      expect(result.current.shouldShowGettingStarted).toBe(false);
      expect(result.current.isOnboardingDismissed).toBe(true);
    });
  });

  it('completeOnboarding persists completedAt (the authoritative finish signal)', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConfig).mockResolvedValue({
      onboarding: { ...FRESH_ONBOARDING },
    } as never);
    vi.mocked(transport.updateConfig).mockResolvedValue(undefined as never);

    const { result } = renderHook(() => useOnboarding(), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.shouldShowOnboarding).toBe(true);
    });

    act(() => {
      result.current.completeOnboarding();
    });

    await waitFor(() => {
      expect(transport.updateConfig).toHaveBeenCalledWith({
        onboarding: { completedAt: expect.any(String) },
      });
    });
  });

  it('dismiss calls updateConfig with only dismissedAt (partial patch)', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConfig).mockResolvedValue({
      onboarding: { ...FRESH_ONBOARDING },
    } as never);
    vi.mocked(transport.updateConfig).mockResolvedValue(undefined as never);

    const { result } = renderHook(() => useOnboarding(), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.shouldShowOnboarding).toBe(true);
    });

    await act(async () => {
      await result.current.dismiss();
    });

    expect(transport.updateConfig).toHaveBeenCalledWith({
      onboarding: { dismissedAt: expect.any(String) },
    });
  });

  it('startOnboarding sends only startedAt as partial patch', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConfig).mockResolvedValue({
      onboarding: { ...FRESH_ONBOARDING },
    } as never);
    vi.mocked(transport.updateConfig).mockResolvedValue(undefined as never);

    const { result } = renderHook(() => useOnboarding(), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.shouldShowOnboarding).toBe(true);
    });

    act(() => {
      result.current.startOnboarding();
    });

    await waitFor(() => {
      expect(transport.updateConfig).toHaveBeenCalledWith({
        onboarding: { startedAt: expect.any(String) },
      });
    });
  });

  it('defaults state when config has no onboarding key', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConfig).mockResolvedValue({} as never);

    const { result } = renderHook(() => useOnboarding(), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.state).toEqual({
        completedSteps: [],
        skippedSteps: [],
        startedAt: null,
        dismissedAt: null,
        completedAt: null,
        runtimeDefaultSetAt: null,
        firstRunPath: null,
        welcomeEntryId: null,
        priorRuntime: null,
      });
      expect(result.current.shouldShowOnboarding).toBe(true);
    });
  });
});
