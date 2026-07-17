/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport, createMockSession } from '@dorkos/test-utils';
import type { ModelOption } from '@dorkos/shared/types';
import type { SessionContextUsage } from '@dorkos/shared/session-stream';
import { useSessionListStore } from '../session-list-store';
import { useSessionContextHealth } from '../use-session-context-health';

const MODEL = 'claude-opus-4-6';
const CATALOG: ModelOption[] = [
  { value: MODEL, displayName: 'Opus', description: 'Capable', contextWindow: 200_000 },
];

function liveUsage(totalTokens: number, maxTokens = 200_000): SessionContextUsage {
  return { totalTokens, maxTokens, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

function seedReading(sessionId: string, usage: SessionContextUsage, receivedAt: string) {
  useSessionListStore.setState({
    contextReadings: { [sessionId]: { contextUsage: usage, receivedAt } },
  });
}

function makeWrapper(getModels = vi.fn().mockResolvedValue(CATALOG)) {
  const transport = createMockTransport({ getModels });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }
  return Wrapper;
}

describe('useSessionContextHealth (list-vs-live merge, live wins)', () => {
  beforeEach(() => {
    useSessionListStore.setState({
      sessions: {},
      statuses: {},
      statusCwds: {},
      contextReadings: {},
      unseen: {},
      rekeys: {},
    });
  });

  it('prefers the live reading over the list reading (live wins)', async () => {
    // Purpose: an open session's retained session_status reading (85%) must
    // override its coarser list reading (10%), and mark the result fresh.
    const session = createMockSession({
      id: 'live-1',
      model: MODEL,
      contextTokens: 20_000, // list ⇒ 10% of 200k
      updatedAt: '2026-07-17T00:00:00.000Z',
    });
    seedReading('live-1', liveUsage(170_000), '2026-07-17T09:00:00.000Z'); // live ⇒ 85%

    const { result } = renderHook(() => useSessionContextHealth(session), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.status).toBe('known'));
    expect(result.current.percent).toBe(85);
    expect(result.current.severity).toBe('warning');
    expect(result.current.fresh).toBe(true);
    expect(result.current.asOf).toBe('2026-07-17T09:00:00.000Z');
  });

  it('resolves a list-only reading via the model catalog window, marked not-fresh', async () => {
    // Purpose: with no live reading, the list contextTokens ÷ catalog window
    // resolves the percent; the result is stale ("as of updatedAt"), not fresh.
    const session = createMockSession({
      id: 'list-1',
      model: MODEL,
      contextTokens: 190_000, // ⇒ 95% of 200k
      updatedAt: '2026-07-17T02:00:00.000Z',
    });

    const { result } = renderHook(() => useSessionContextHealth(session), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.status).toBe('known'));
    expect(result.current.percent).toBe(95);
    expect(result.current.severity).toBe('critical');
    expect(result.current.fresh).toBe(false);
    expect(result.current.asOf).toBe('2026-07-17T02:00:00.000Z');
  });

  it('is unknown with neither a live reading nor list contextTokens', async () => {
    // Purpose: a codex/opencode-style closed row (no reading, no tokens) reads
    // honestly as unknown — never a fabricated 0%.
    const session = createMockSession({ id: 'unk-1', model: MODEL, contextTokens: undefined });

    const { result } = renderHook(() => useSessionContextHealth(session), {
      wrapper: makeWrapper(),
    });

    // Wait for the models query to settle so unknown is a settled verdict.
    await waitFor(() => expect(result.current).toBeDefined());
    expect(result.current.status).toBe('unknown');
    expect(result.current.percent).toBeUndefined();
    expect(result.current.severity).toBeUndefined();
  });

  it('is unknown (not 0%) when the model is absent from the catalog', async () => {
    // Purpose: list tokens are present but the model has no catalog window, so
    // no percent can be derived — the honest verdict is unknown, not 0%.
    const session = createMockSession({
      id: 'nocat-1',
      model: 'model-not-in-catalog',
      contextTokens: 150_000,
    });

    const { result } = renderHook(() => useSessionContextHealth(session), {
      wrapper: makeWrapper(),
    });

    // Let the catalog load; the model still won't match, so it stays unknown.
    await waitFor(() => expect(result.current).toBeDefined());
    expect(result.current.status).toBe('unknown');
    expect(result.current.percent).toBeUndefined();
  });

  it('passes lastAutoCompactAt through on every branch', async () => {
    // Purpose: the auto-compacted marker rides even an unknown-percent row, so
    // autoCompactedAt must survive resolution regardless of status.
    const session = createMockSession({
      id: 'compact-1',
      model: MODEL,
      contextTokens: undefined, // unknown percent
      lastAutoCompactAt: '2026-07-17T08:30:00.000Z',
    });

    const { result } = renderHook(() => useSessionContextHealth(session), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current).toBeDefined());
    expect(result.current.status).toBe('unknown');
    expect(result.current.autoCompactedAt).toBe('2026-07-17T08:30:00.000Z');
  });
});
