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

  it('completeStep calls updateConfig with the step added', async () => {
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
      result.current.completeStep('discovery');
    });

    await waitFor(() => {
      expect(transport.updateConfig).toHaveBeenCalledWith({
        onboarding: { completedSteps: ['discovery'] },
      });
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

  it('skipStep calls updateConfig with the step added to skippedSteps', async () => {
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
      result.current.skipStep('discovery');
    });

    await waitFor(() => {
      expect(transport.updateConfig).toHaveBeenCalledWith({
        onboarding: { skippedSteps: ['discovery'] },
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
      });
      expect(result.current.shouldShowOnboarding).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Rapid-burst race condition tests
  // ---------------------------------------------------------------------------

  it('rapid completeStep calls send superset arrays (no race condition)', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConfig).mockResolvedValue({
      onboarding: { ...FRESH_ONBOARDING },
    } as never);
    // Resolve immediately — the cache won't refresh within a synchronous act() block,
    // so this simulates the race where all calls read stale cache state.
    vi.mocked(transport.updateConfig).mockResolvedValue(undefined as never);

    const { result } = renderHook(() => useOnboarding(), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.shouldShowOnboarding).toBe(true);
    });

    act(() => {
      result.current.completeStep('meet-dorkbot');
      result.current.completeStep('discovery');
    });

    await waitFor(() => {
      expect(transport.updateConfig).toHaveBeenCalledTimes(2);
    });

    expect(transport.updateConfig).toHaveBeenNthCalledWith(1, {
      onboarding: { completedSteps: ['meet-dorkbot'] },
    });
    expect(transport.updateConfig).toHaveBeenNthCalledWith(2, {
      onboarding: { completedSteps: expect.arrayContaining(['meet-dorkbot', 'discovery']) },
    });
  });

  it('duplicate completeStep calls are deduplicated', async () => {
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
      result.current.completeStep('discovery');
      result.current.completeStep('discovery');
      result.current.completeStep('discovery');
    });

    await waitFor(() => {
      expect(transport.updateConfig).toHaveBeenCalledTimes(1);
    });
  });

  it('rapid skipStep calls send superset arrays', async () => {
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
      result.current.skipStep('meet-dorkbot');
      result.current.skipStep('discovery');
    });

    await waitFor(() => {
      expect(transport.updateConfig).toHaveBeenCalledTimes(2);
    });

    expect(transport.updateConfig).toHaveBeenNthCalledWith(1, {
      onboarding: { skippedSteps: ['meet-dorkbot'] },
    });
    expect(transport.updateConfig).toHaveBeenNthCalledWith(2, {
      onboarding: { skippedSteps: expect.arrayContaining(['meet-dorkbot', 'discovery']) },
    });
  });
});
