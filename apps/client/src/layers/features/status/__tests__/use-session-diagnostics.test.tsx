/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Session, ServerConfig, SubagentInfo } from '@dorkos/shared/types';
import type { SessionSnapshot } from '@dorkos/shared/session-stream';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';

// The runtime resolution reads the session list for its "started" signal; the
// real useSessions needs router search params, absent in this suite.
const mockSessionRows = vi.fn<() => { sessions: Session[]; isLoading: boolean }>(() => ({
  sessions: [],
  isLoading: false,
}));
vi.mock('@/layers/entities/session/model/use-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session/model/use-sessions')>()),
  useSessions: () => mockSessionRows() as never,
}));

vi.mock('@/layers/entities/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/runtime')>()),
  useRuntimeCapabilities: () => ({ data: { defaultRuntime: 'claude-code', capabilities: {} } }),
}));

import { useSessionDiagnostics } from '../model/use-session-diagnostics';
import {
  useSessionChatStore,
  useSessionSettingsOverridesStore,
  useSessionStreamStore,
  useSessionStatus,
} from '@/layers/entities/session';

/**
 * A session row as the server reports it. `model` is the id the transcript
 * records — the SDK-resolved one, not the option the person picked.
 */
function sessionRow(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    cwd: '/Users/dev/work/dorkos',
    model: 'claude-opus-4-6',
    permissionMode: 'plan',
    effort: 'high',
    fastMode: false,
    runtime: 'claude-code',
    ...overrides,
  } as Session;
}

const SUBAGENTS: SubagentInfo[] = [
  { name: 'researcher', description: 'reads code', model: 'haiku' } as SubagentInfo,
];

/** A hydrated snapshot with server-derived figures the status line reads. */
function snapshot(cursor = 400): SessionSnapshot {
  return {
    messages: [],
    inProgressTurn: [
      {
        seq: cursor + 1,
        type: 'subagent_update',
        taskId: 't1',
        status: 'running',
        description: 'Search the codebase',
        toolUses: 2,
        lastToolName: 'Grep',
      },
    ],
    status: {
      contextUsage: {
        totalTokens: 176_000,
        maxTokens: 200_000,
        outputTokens: 500,
        cacheReadTokens: 9_000,
        cacheCreationTokens: 1_000,
      },
      cost: 0.35,
      usage: { kind: 'pay-as-you-go', costUsd: 0.35 },
      cacheStats: { cacheReadTokens: 9_000, cacheCreationTokens: 1_000 },
      model: 'claude-opus-4-6',
      permissionMode: 'plan',
      todoCounts: null,
      runningSubagentCount: 1,
      lifecycle: 'streaming',
      lastError: null,
    },
    pendingInteractions: [],
    cursor,
  };
}

/** Providers plus the transport whose calls back the queries. */
function harness(rows: Session[] = [sessionRow()]) {
  mockSessionRows.mockReturnValue({ sessions: rows, isLoading: false });
  const transport = createMockTransport({
    getSession: vi.fn(async (id: string) => rows.find((r) => r.id === id) ?? sessionRow({ id })),
    getSubagents: vi.fn().mockResolvedValue(SUBAGENTS),
    getModels: vi.fn().mockResolvedValue([{ value: 'default', label: 'Default', isDefault: true }]),
    getGitStatus: vi.fn().mockResolvedValue({ branch: 'dor-460', clean: false, detached: false }),
    getConfig: vi.fn().mockResolvedValue({ version: '1.4.0' } as ServerConfig),
    updateSession: vi.fn(async (_id, opts) => ({ ...sessionRow(), ...opts })),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return { transport, queryClient, wrapper };
}

beforeEach(() => {
  useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [], pinnedSessionId: null });
  useSessionChatStore.setState({ sessions: {} });
  useSessionSettingsOverridesStore.setState({ bySession: {} });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('useSessionDiagnostics — the snapshot it assembles', () => {
  it('reports the stream, the resolution, usage, and the running subagents', async () => {
    useSessionStreamStore.getState().applySnapshot('s1', snapshot());
    useSessionStreamStore.getState().setConnectionState('s1', 'connected');
    useSessionStreamStore.getState().enqueueMessage('s1', 'later');

    const { wrapper } = harness();
    const { result } = renderHook(() => useSessionDiagnostics('s1'), { wrapper });

    await waitFor(() => expect(result.current.cwd).toBe('/Users/dev/work/dorkos'));

    expect(result.current).toMatchObject({
      sessionId: 's1',
      runtime: 'claude-code',
      model: 'claude-opus-4-6',
      selectedModel: 'claude-opus-4-6',
      effort: 'high',
      fastMode: false,
      permissionMode: 'plan',
      contextPercent: 88,
      connectionState: 'connected',
      lifecycle: 'streaming',
      streaming: true,
      triggerPending: false,
      // A snapshot's own `inProgressTurn` events do not advance the watermark —
      // the cursor already reflects them.
      lastEventSeq: 400,
      snapshotCursor: 400,
      queueDepth: 1,
      clientVersion: '1.4.0',
    });
    expect(result.current.cache).toEqual({
      readTokens: 9_000,
      creationTokens: 1_000,
      contextTokens: 176_000,
    });
    expect(result.current.gitBranch).toBe('dor-460');
    expect(result.current.gitDirty).toBe(true);
    expect(result.current.subagents.map((a) => a.name)).toEqual(['researcher']);
    expect(result.current.activeSubagents).toEqual([
      {
        taskId: 't1',
        status: 'running',
        description: 'Search the codebase',
        toolUses: 2,
        lastToolName: 'Grep',
        summary: undefined,
      },
    ]);
  });

  it('degrades to honest empty values before anything has hydrated', async () => {
    const { wrapper } = harness([]);
    const { result } = renderHook(() => useSessionDiagnostics('s-new'), { wrapper });

    await waitFor(() => expect(result.current.clientVersion).toBe('1.4.0'));
    expect(result.current).toMatchObject({
      lifecycle: null,
      lastEventSeq: 0,
      snapshotCursor: null,
      lastEventAt: null,
      queueDepth: 0,
      contextPercent: null,
      contextUsage: null,
      cache: null,
      usage: null,
    });
    expect(result.current.activeSubagents).toEqual([]);
  });

  it('separates the resolved model id from the option the person picked', async () => {
    // They are genuinely two values: the picker and the auto-mode gate key off the
    // option (`default`), the transcript records the id it resolved to. A readout
    // that collapsed them would hide exactly the mismatch it exists to surface.
    const { wrapper } = harness();
    const writer = renderHook(() => useSessionStatus('s1', null, false, 'claude-code'), {
      wrapper,
    });
    const { result } = renderHook(() => useSessionDiagnostics('s1'), { wrapper });
    await waitFor(() => expect(result.current.selectedModel).toBe('claude-opus-4-6'));

    void writer.result.current.updateSession({ model: 'default' });
    await waitFor(() => expect(result.current.selectedModel).toBe('default'));
    expect(result.current.model).toBe('claude-opus-4-6');
  });

  it('stamps when the last frame was applied, so a silent stream is visible', async () => {
    const { wrapper } = harness();
    const before = Date.now();
    useSessionStreamStore.getState().applySnapshot('s1', snapshot());

    const { result } = renderHook(() => useSessionDiagnostics('s1'), { wrapper });
    await waitFor(() => expect(result.current.lastEventAt).not.toBeNull());
    expect(result.current.lastEventAt!).toBeGreaterThanOrEqual(before);
  });
});

describe('useSessionDiagnostics — one source of truth', () => {
  it('gives two independent readers the identical snapshot', async () => {
    // The whole point of the hook: the `⋯` panel and the right-panel tab must
    // never be able to report different values for the same session.
    useSessionStreamStore.getState().applySnapshot('s1', snapshot());
    const { wrapper } = harness();

    const a = renderHook(() => useSessionDiagnostics('s1'), { wrapper });
    const b = renderHook(() => useSessionDiagnostics('s1'), { wrapper });

    await waitFor(() => expect(a.result.current.cwd).not.toBeNull());
    await waitFor(() => expect(b.result.current.cwd).not.toBeNull());
    expect(a.result.current).toEqual(b.result.current);
  });

  it('shows a second reader an optimistic settings change in the same tick', async () => {
    // Before the optimistic overrides moved into a shared store this failed: the
    // writing surface flipped instantly and every other reader stayed stale for a
    // whole PATCH round-trip.
    const { wrapper } = harness();
    const writer = renderHook(() => useSessionStatus('s1', null, false, 'claude-code'), {
      wrapper,
    });
    const reader = renderHook(() => useSessionDiagnostics('s1'), { wrapper });

    await waitFor(() => expect(reader.result.current.permissionMode).toBe('plan'));

    void writer.result.current.updateSession({ permissionMode: 'bypassPermissions' });
    await waitFor(() => expect(reader.result.current.permissionMode).toBe('bypassPermissions'));
  });

  it('never leaks the previous session values after a switch', async () => {
    useSessionStreamStore.getState().applySnapshot('s1', snapshot());
    useSessionStreamStore.getState().setConnectionState('s1', 'connected');
    useSessionStreamStore.getState().enqueueMessage('s1', 'later');

    const { wrapper } = harness([sessionRow(), sessionRow({ id: 's2', cwd: '/other/repo' })]);
    const { result, rerender } = renderHook(({ id }: { id: string }) => useSessionDiagnostics(id), {
      wrapper,
      initialProps: { id: 's1' },
    });
    await waitFor(() => expect(result.current.queueDepth).toBe(1));

    rerender({ id: 's2' });
    await waitFor(() => expect(result.current.sessionId).toBe('s2'));
    expect(result.current).toMatchObject({
      queueDepth: 0,
      lastEventSeq: 0,
      snapshotCursor: null,
      lastEventAt: null,
      lifecycle: null,
      contextPercent: null,
      cache: null,
      usage: null,
    });
    expect(result.current.activeSubagents).toEqual([]);
  });
});
