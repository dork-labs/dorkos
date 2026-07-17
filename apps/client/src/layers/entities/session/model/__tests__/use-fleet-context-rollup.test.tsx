/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport, createMockSession } from '@dorkos/test-utils';
import type { Session, ModelOption } from '@dorkos/shared/types';
import type { SessionContextUsage } from '@dorkos/shared/session-stream';
import { useSessionListStore } from '../session-list-store';
import { useFleetContextRollup } from '../use-fleet-context-rollup';

const MODEL = 'claude-opus-4-6';
// claude-code has a real window; codex catalog is empty so its rows can't resolve.
const CATALOG: Record<string, ModelOption[]> = {
  'claude-code': [{ value: MODEL, displayName: 'Opus', description: '', contextWindow: 200_000 }],
  codex: [],
};

function usage(totalTokens: number): SessionContextUsage {
  return {
    totalTokens,
    maxTokens: 200_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

function seed(sessions: Session[], contextReadings: Record<string, SessionContextUsage> = {}) {
  useSessionListStore.setState({
    sessions: Object.fromEntries(sessions.map((s) => [s.id, s])),
    contextReadings: Object.fromEntries(
      Object.entries(contextReadings).map(([id, u]) => [
        id,
        { contextUsage: u, receivedAt: '2026-07-17T09:00:00.000Z' },
      ])
    ),
  });
}

function makeWrapper() {
  const getModels = vi.fn((opts?: { runtime?: string }) =>
    Promise.resolve(CATALOG[opts?.runtime ?? 'claude-code'] ?? [])
  );
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

describe('useFleetContextRollup', () => {
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

  it('folds a mixed fleet into the right counts', async () => {
    // Purpose: known/warning/critical/unknown/auto-compacted must each be
    // counted from the shared §6 resolution across a representative fleet.
    seed(
      [
        createMockSession({ id: 'crit', model: MODEL, contextTokens: 190_000 }), // 95% critical
        createMockSession({ id: 'warn', model: MODEL, contextTokens: 170_000 }), // 85% warning
        createMockSession({ id: 'ok', model: MODEL, contextTokens: 20_000 }), // 10% ok
        createMockSession({ id: 'live', model: MODEL, contextTokens: 5_000 }), // list 2.5%…
        createMockSession({
          id: 'codex',
          runtime: 'codex',
          model: 'gpt-5',
          contextTokens: 100_000,
        }), // no window
        createMockSession({
          id: 'compact',
          model: MODEL,
          contextTokens: undefined, // unknown percent…
          lastAutoCompactAt: '2026-07-17T08:00:00.000Z', // …but auto-compacted
        }),
      ],
      { live: usage(100_000) } // …live wins ⇒ 50% ok
    );

    const { result } = renderHook(() => useFleetContextRollup(), { wrapper: makeWrapper() });

    // Wait for the catalogs to load so the list-derived rows resolve.
    await waitFor(() => expect(result.current.known).toBe(4));
    expect(result.current.total).toBe(6);
    expect(result.current.unknown).toBe(2); // codex (no window) + compact (no tokens)
    expect(result.current.warning).toBe(1);
    expect(result.current.critical).toBe(1);
    expect(result.current.autoCompacted).toBe(1);
  });

  it('reports "near full" as warning + critical', async () => {
    // Purpose: the summary copy's "near full" total is exactly warning+critical.
    seed([
      createMockSession({ id: 'w1', model: MODEL, contextTokens: 165_000 }), // warning
      createMockSession({ id: 'w2', model: MODEL, contextTokens: 175_000 }), // warning
      createMockSession({ id: 'c1', model: MODEL, contextTokens: 199_000 }), // critical
    ]);

    const { result } = renderHook(() => useFleetContextRollup(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.known).toBe(3));
    expect(result.current.warning + result.current.critical).toBe(3);
  });

  it('counts an unknown row in unknown and never as a reading', async () => {
    // Purpose: a row with no reading must not leak into warning/critical/known.
    seed([
      createMockSession({ id: 'u1', runtime: 'codex', model: 'gpt-5', contextTokens: 100_000 }),
    ]);

    const { result } = renderHook(() => useFleetContextRollup(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.total).toBe(1));
    expect(result.current.unknown).toBe(1);
    expect(result.current.known).toBe(0);
    expect(result.current.warning).toBe(0);
    expect(result.current.critical).toBe(0);
  });

  it('counts auto-compacted regardless of percent state', async () => {
    // Purpose: an unknown-percent row that carries lastAutoCompactAt still
    // increments autoCompacted (the marker rides an unknown row).
    seed([
      createMockSession({
        id: 'ac',
        runtime: 'codex',
        model: 'gpt-5',
        contextTokens: undefined,
        lastAutoCompactAt: '2026-07-17T08:00:00.000Z',
      }),
    ]);

    const { result } = renderHook(() => useFleetContextRollup(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.total).toBe(1));
    expect(result.current.autoCompacted).toBe(1);
    expect(result.current.unknown).toBe(1);
  });
});
