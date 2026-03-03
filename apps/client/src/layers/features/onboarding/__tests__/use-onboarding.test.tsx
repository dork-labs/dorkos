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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useOnboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shouldShowOnboarding returns true when no completedSteps and not dismissed', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConfig).mockResolvedValue({
      onboarding: {
        completedSteps: [],
        skippedSteps: [],
        startedAt: null,
        dismissedAt: null,
      },
    } as never);

    const { result } = renderHook(() => useOnboarding(), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.shouldShowOnboarding).toBe(true);
    });
  });

  it('shouldShowOnboarding returns false when all steps completed', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConfig).mockResolvedValue({
      onboarding: {
        completedSteps: ['discovery', 'pulse', 'adapters'],
        skippedSteps: [],
        startedAt: null,
        dismissedAt: null,
      },
    } as never);

    const { result } = renderHook(() => useOnboarding(), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.shouldShowOnboarding).toBe(false);
      expect(result.current.isOnboardingComplete).toBe(true);
    });
  });

  it('shouldShowOnboarding returns false when dismissed', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConfig).mockResolvedValue({
      onboarding: {
        completedSteps: [],
        skippedSteps: [],
        startedAt: null,
        dismissedAt: '2026-01-01T00:00:00.000Z',
      },
    } as never);

    const { result } = renderHook(() => useOnboarding(), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.shouldShowOnboarding).toBe(false);
      expect(result.current.isOnboardingDismissed).toBe(true);
    });
  });

  it('completeStep calls updateConfig with the step added', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConfig).mockResolvedValue({
      onboarding: {
        completedSteps: [],
        skippedSteps: [],
        startedAt: null,
        dismissedAt: null,
      },
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

  it('skipStep calls updateConfig with the step added to skippedSteps', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConfig).mockResolvedValue({
      onboarding: {
        completedSteps: [],
        skippedSteps: [],
        startedAt: null,
        dismissedAt: null,
      },
    } as never);
    vi.mocked(transport.updateConfig).mockResolvedValue(undefined as never);

    const { result } = renderHook(() => useOnboarding(), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.shouldShowOnboarding).toBe(true);
    });

    act(() => {
      result.current.skipStep('pulse');
    });

    await waitFor(() => {
      expect(transport.updateConfig).toHaveBeenCalledWith({
        onboarding: { skippedSteps: ['pulse'] },
      });
    });
  });

  it('dismiss calls updateConfig with only dismissedAt (partial patch)', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConfig).mockResolvedValue({
      onboarding: {
        completedSteps: [],
        skippedSteps: [],
        startedAt: null,
        dismissedAt: null,
      },
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
      onboarding: {
        completedSteps: [],
        skippedSteps: [],
        startedAt: null,
        dismissedAt: null,
      },
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
      onboarding: {
        completedSteps: [],
        skippedSteps: [],
        startedAt: null,
        dismissedAt: null,
      },
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
      result.current.completeStep('discovery');
      result.current.completeStep('pulse');
      result.current.completeStep('adapters');
    });

    await waitFor(() => {
      expect(transport.updateConfig).toHaveBeenCalledTimes(3);
    });

    expect(transport.updateConfig).toHaveBeenNthCalledWith(1, {
      onboarding: { completedSteps: ['discovery'] },
    });
    expect(transport.updateConfig).toHaveBeenNthCalledWith(2, {
      onboarding: { completedSteps: expect.arrayContaining(['discovery', 'pulse']) },
    });
    expect(transport.updateConfig).toHaveBeenNthCalledWith(3, {
      onboarding: {
        completedSteps: expect.arrayContaining(['discovery', 'pulse', 'adapters']),
      },
    });
  });

  it('duplicate completeStep calls are deduplicated', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConfig).mockResolvedValue({
      onboarding: {
        completedSteps: [],
        skippedSteps: [],
        startedAt: null,
        dismissedAt: null,
      },
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
      onboarding: {
        completedSteps: [],
        skippedSteps: [],
        startedAt: null,
        dismissedAt: null,
      },
    } as never);
    vi.mocked(transport.updateConfig).mockResolvedValue(undefined as never);

    const { result } = renderHook(() => useOnboarding(), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.shouldShowOnboarding).toBe(true);
    });

    act(() => {
      result.current.skipStep('pulse');
      result.current.skipStep('adapters');
    });

    await waitFor(() => {
      expect(transport.updateConfig).toHaveBeenCalledTimes(2);
    });

    expect(transport.updateConfig).toHaveBeenNthCalledWith(1, {
      onboarding: { skippedSteps: ['pulse'] },
    });
    expect(transport.updateConfig).toHaveBeenNthCalledWith(2, {
      onboarding: { skippedSteps: expect.arrayContaining(['pulse', 'adapters']) },
    });
  });
});
