// @vitest-environment jsdom
/**
 * The contract the sidebar's own memo rests on: an activity event must not
 * change this list's identity (spec §H, Risk R1).
 *
 * `useSidebarState`'s suite stubs this hook, because mounting it needs a
 * transport that suite does not stand up — so the half of §H that belongs to
 * attention is asserted here, against the same hundred injected events, with
 * the real session stores underneath.
 *
 * @module entities/attention/__tests__/use-attention-signals
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { createMockTransport } from '@dorkos/test-utils';
import type { SessionStatus } from '@dorkos/shared/session-stream';

const NOW = new Date('2026-08-09T09:15:00.000Z').getTime();
const ALPHA = '/projects/alpha';

/**
 * Two sessions: one touched a moment ago, one quiet for forty-five minutes.
 *
 * The stale one is what makes the dismissal case real — it is the only thing
 * here that can produce a dismissible nudge — and every other case parks it in
 * `streaming` so it stays silent.
 */
const SESSIONS = [
  {
    id: 'ses-1',
    title: 'Ship the parser',
    cwd: ALPHA,
    createdAt: new Date(NOW - 3_600_000).toISOString(),
    updatedAt: new Date(NOW - 120_000).toISOString(),
    permissionMode: 'default',
    runtime: 'claude-code',
  },
  {
    id: 'ses-2',
    title: 'Rewrite the docs',
    cwd: ALPHA,
    createdAt: new Date(NOW - 7_200_000).toISOString(),
    updatedAt: new Date(NOW - 45 * 60_000).toISOString(),
    permissionMode: 'default',
    runtime: 'claude-code',
  },
];
const RECENT = { sessions: SESSIONS, agentActivity: {}, warnings: [] };
// Hoisted whole, not just its `agents` array: a mock answering with a fresh
// wrapper object per call would move the roster's identity by itself, and every
// identity assertion here would fail for a reason that is not the hook's. A
// real `useQuery` hands back the same `data` until it refetches.
const MESH = { agents: [{ id: 'm1', name: 'alpha', projectPath: ALPHA }] };
const MESH_RESULT = { data: MESH };
const MANIFESTS_RESULT = { data: { [ALPHA]: null } };

vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useNow: () => NOW,
  useEventSubscription: () => {},
}));

vi.mock('@/layers/entities/mesh', () => ({
  useMeshAgentPaths: () => MESH_RESULT,
}));

vi.mock('@/layers/entities/agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/agent')>()),
  useResolvedAgents: () => MANIFESTS_RESULT,
}));

vi.mock('@/layers/entities/session/model/use-recent-sessions', () => ({
  useRecentSessions: () => ({ data: RECENT, isLoading: false, isSuccess: true }),
}));

import { TransportProvider } from '@/layers/shared/model';
import { useSessionListStore } from '@/layers/entities/session';
import { useAttentionSignals, useAttentionSignalsLoading } from '../model/use-attention-signals';
import { useIdleNudgeStore } from '../model/idle-nudge-store';

/** A `session_status` projection with a lifecycle and, optionally, a live verb. */
function status(lifecycle: SessionStatus['lifecycle'], toolName?: string): SessionStatus {
  return {
    lifecycle,
    ...(toolName === undefined
      ? {}
      : { activity: { kind: 'tool' as const, toolName, at: new Date(NOW).toISOString() } }),
  } as SessionStatus;
}

/**
 * Providers enough to mount the hook: a transport and a query client.
 *
 * Built ONCE per test in `beforeEach`, never inside the wrapper component. A
 * wrapper that minted a fresh `QueryClient` on every render would remount the
 * whole tree under it, and every identity assertion in this file would fail for
 * a reason that has nothing to do with the hook.
 */
let providers: { transport: ReturnType<typeof createMockTransport>; queryClient: QueryClient };

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={providers.queryClient}>
      <TransportProvider transport={providers.transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('useAttentionSignals', () => {
  beforeEach(() => {
    const transport = createMockTransport();
    transport.listPendingApprovals = vi.fn().mockResolvedValue({ approvals: [] });
    providers = {
      transport,
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    };
    useSessionListStore.getState().resetStatuses();
    useIdleNudgeStore.getState().reset();
    // The stale session is parked as working, so only the case that wants a
    // nudge gets one.
    useSessionListStore.getState().setSessionStatus('ses-2', status('streaming'));
  });
  afterEach(() => cleanup());

  it('hands back the SAME list across a hundred activity events', async () => {
    act(() => {
      useSessionListStore.getState().setSessionStatus('ses-1', status('streaming', 'Read'));
    });
    const { result, rerender } = renderHook(() => useAttentionSignals(), { wrapper });
    // Wait for the approvals query to land before taking the reading — its
    // first answer legitimately moves the list, and measuring across that would
    // be measuring the fetch rather than the churn.
    await waitFor(() => expect(providers.transport.listPendingApprovals).toHaveBeenCalled());
    await waitFor(() => expect(result.current).toEqual([]));
    const before = result.current;

    for (let i = 0; i < 100; i += 1) {
      act(() => {
        useSessionListStore.getState().setSessionStatus('ses-1', status('streaming', `Tool${i}`));
      });
      rerender();
    }

    expect(result.current).toBe(before);
  });

  it('DOES hand back a new list when the lifecycle actually changes', async () => {
    // The half that proves the memo is not simply frozen. Without it, a hook
    // returning one hoisted array would pass the case above forever.
    act(() => {
      useSessionListStore.getState().setSessionStatus('ses-1', status('streaming', 'Read'));
    });
    const { result, rerender } = renderHook(() => useAttentionSignals(), { wrapper });
    await waitFor(() => expect(result.current).toEqual([]));
    const before = result.current;

    act(() => {
      useSessionListStore.getState().setSessionStatus('ses-1', status('error'));
    });
    rerender();

    expect(result.current).not.toBe(before);
    expect(result.current.map((signal) => signal.kind)).toEqual(['error']);
    expect(result.current[0]?.primary).toBe('alpha');
  });

  it('drops an idle nudge the moment it is dismissed (BC-10)', async () => {
    act(() => {
      useSessionListStore.getState().setSessionStatus('ses-2', status('idle'));
    });
    const { result, rerender } = renderHook(() => useAttentionSignals(), { wrapper });
    // It is THERE first. "It is gone" says nothing without this line.
    await waitFor(() => expect(result.current.map((s) => s.id)).toEqual(['idle:ses-2']));

    act(() => {
      useIdleNudgeStore.getState().dismiss('idle:ses-2');
    });
    rerender();
    expect(result.current).toEqual([]);
  });

  it('refuses to let a dismissal reach anything that is not dismissible (BC-42)', async () => {
    act(() => {
      useSessionListStore.getState().setSessionStatus('ses-1', status('error'));
    });
    const { result, rerender } = renderHook(() => useAttentionSignals(), { wrapper });
    await waitFor(() => expect(result.current.map((s) => s.id)).toEqual(['error:ses-1']));

    act(() => {
      useIdleNudgeStore.getState().dismiss('error:ses-1');
    });
    rerender();

    // A wedged session is not something the operator may wave away — it clears
    // by being resolved, and nothing in Heads up offers a snooze.
    expect(result.current.map((s) => s.id)).toEqual(['error:ses-1']);
  });
});

describe('useAttentionSignalsLoading', () => {
  beforeEach(() => {
    const transport = createMockTransport();
    transport.listPendingApprovals = vi.fn().mockResolvedValue({ approvals: [] });
    providers = {
      transport,
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    };
    useSessionListStore.getState().resetStatuses();
    useIdleNudgeStore.getState().reset();
  });
  afterEach(() => cleanup());

  it('stays loading while the PROMPT queue has not answered (DOR-1385 review)', async () => {
    // The staggered settle, which is the ordinary shape of a page load: the
    // session listing and the approval queue land, and the prompt queue lands a
    // beat later.
    //
    // Why it matters, in one sentence: `deriveAttentionSignals` reads a blocked
    // session's PROMPT to build the signal's id, so before the prompts arrive a
    // blocked session is `blocked:<sessionId>` and afterwards it is
    // `blocked:<interactionId>`. Calling the list believable in between hands an
    // arrival watcher an id that is about to change, and the change reads as an
    // Ask arriving when it had been sitting there the whole time.
    providers.transport.listPendingInteractions = vi.fn(() => new Promise<never>(() => {}));

    const { result } = renderHook(() => useAttentionSignalsLoading(), { wrapper });

    // Wait for the two that DO settle, so this is asserting "still loading
    // because of the prompts" rather than "still loading because nothing has
    // run yet" — which would pass even with the prompt query omitted.
    await waitFor(() => expect(providers.transport.listPendingApprovals).toHaveBeenCalled());
    await waitFor(() => expect(providers.transport.listPendingInteractions).toHaveBeenCalled());
    expect(result.current).toBe(true);
  });

  it('is believable once all three queries have answered', async () => {
    const { result } = renderHook(() => useAttentionSignalsLoading(), { wrapper });
    await waitFor(() => expect(result.current).toBe(false));
  });
});
