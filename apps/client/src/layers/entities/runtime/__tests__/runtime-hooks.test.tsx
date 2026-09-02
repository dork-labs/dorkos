// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import {
  useRuntimeCapabilities,
  useCapabilitiesForRuntime,
} from '../model/use-runtime-capabilities';

function createWrapper(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return {
    queryClient,
    Wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    ),
  };
}

// ---------------------------------------------------------------------------
// The three REAL runtime capability profiles (spec additional-agent-runtimes,
// task 4.2 verification mandate). These mirror the server adapters'
// runtime-constants — if a flag changes server-side, update it here too.
// ---------------------------------------------------------------------------

const CLAUDE_CODE_PROFILE: RuntimeCapabilities = {
  type: 'claude-code',
  supportsToolApproval: true,
  supportsCostTracking: true,
  supportsResume: true,
  supportsMcp: true,
  supportsManagedMcpServers: true,
  supportsQuestionPrompt: true,
  supportsPlugins: true,
  supportsPersistentSession: false,
  supportsSteer: false,
  supportsContextStaging: false,
  mediaOutput: 'none',
  nativeContext: [],
  permissionModes: {
    supported: true,
    default: 'default',
    values: [
      {
        id: 'default',
        label: 'Default',
        stop: 'ask',
        asks: 'always',
        reach: 'edit',
        promise: 'Asks before it edits a file or runs a command.',
      },
      {
        id: 'acceptEdits',
        label: 'Accept edits',
        stop: 'act',
        asks: 'when-risky',
        reach: 'edit',
        promise: 'Edits files on its own. Asks before it runs a command.',
      },
      {
        id: 'plan',
        label: 'Plan',
        stop: 'ask',
        asks: 'always',
        reach: 'read',
        promise: 'Reads and plans only. Nothing changes until you approve the plan.',
      },
      {
        id: 'bypassPermissions',
        label: 'Bypass permissions',
        stop: 'autonomy',
        asks: 'never',
        reach: 'everything',
        promise: 'Runs everything without asking, including outside this project.',
      },
      {
        id: 'auto',
        label: 'Auto',
        stop: 'act',
        asks: 'when-risky',
        reach: 'edit',
        promise: 'Edits files on its own and weighs each command, asking you about the risky ones.',
      },
    ],
  },
  commandIntents: { compact: { supported: false } },
  settings: { configSection: null, supportsEffort: false, sections: [] },
  features: {},
};

const CODEX_PROFILE: RuntimeCapabilities = {
  type: 'codex',
  supportsToolApproval: false,
  supportsCostTracking: false,
  supportsResume: true,
  supportsMcp: false,
  supportsManagedMcpServers: true,
  supportsQuestionPrompt: false,
  supportsPlugins: false,
  supportsPersistentSession: false,
  supportsSteer: false,
  supportsContextStaging: false,
  mediaOutput: 'none',
  nativeContext: [],
  permissionModes: {
    supported: true,
    default: 'default',
    values: [
      {
        id: 'default',
        label: 'Read only',
        stop: 'ask',
        asks: 'never',
        reach: 'read',
        promise: 'Reads files and answers questions. Nothing changes.',
        native: 'read-only',
      },
      {
        id: 'acceptEdits',
        label: 'Workspace write',
        stop: 'act',
        asks: 'never',
        reach: 'workspace',
        promise: "Edits files and runs commands inside the workspace — Codex can't pause to ask.",
        native: 'workspace-write',
      },
      {
        id: 'bypassPermissions',
        label: 'Full access',
        stop: 'autonomy',
        asks: 'never',
        reach: 'everything',
        promise: 'Runs everything without asking, network included.',
        native: 'danger-full-access',
      },
    ],
  },
  commandIntents: { compact: { supported: false } },
  settings: { configSection: null, supportsEffort: false, sections: [] },
  features: {},
};

const OPENCODE_PROFILE: RuntimeCapabilities = {
  type: 'opencode',
  supportsToolApproval: true,
  supportsCostTracking: true,
  supportsResume: true,
  supportsMcp: false,
  supportsManagedMcpServers: false,
  supportsQuestionPrompt: false,
  supportsPlugins: false,
  supportsPersistentSession: false,
  supportsSteer: false,
  supportsContextStaging: false,
  mediaOutput: 'none',
  nativeContext: [],
  permissionModes: {
    supported: true,
    default: 'default',
    values: [
      {
        id: 'default',
        label: 'Default',
        stop: 'ask',
        asks: 'always',
        reach: 'edit',
        promise: 'Asks before it edits a file or runs a command.',
      },
      {
        id: 'acceptEdits',
        label: 'Accept edits',
        stop: 'act',
        asks: 'when-risky',
        reach: 'edit',
        promise: 'Edits files on its own. Asks before it runs a command.',
      },
      {
        id: 'bypassPermissions',
        label: 'Bypass permissions',
        stop: 'autonomy',
        asks: 'never',
        reach: 'everything',
        promise: 'Runs everything without asking, including outside this project.',
      },
    ],
  },
  commandIntents: { compact: { supported: false } },
  settings: { configSection: null, supportsEffort: false, sections: [] },
  features: {},
};

const mockCapabilitiesResponse = {
  capabilities: {
    'claude-code': CLAUDE_CODE_PROFILE,
    codex: CODEX_PROFILE,
    opencode: OPENCODE_PROFILE,
  },
  defaultRuntime: 'claude-code',
};

// ---------------------------------------------------------------------------
// useRuntimeCapabilities
// ---------------------------------------------------------------------------
describe('useRuntimeCapabilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches capabilities from transport.getCapabilities', async () => {
    const transport = createMockTransport({
      getCapabilities: vi.fn().mockResolvedValue(mockCapabilitiesResponse),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useRuntimeCapabilities(), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mockCapabilitiesResponse);
    expect(transport.getCapabilities).toHaveBeenCalledTimes(1);
  });

  it('exposes error state on transport failure', async () => {
    const transport = createMockTransport({
      getCapabilities: vi.fn().mockRejectedValue(new Error('Capabilities fetch failed')),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useRuntimeCapabilities(), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBeInstanceOf(Error);
  });

  it('uses staleTime: Infinity — does not refetch on re-mount with cached data', async () => {
    const transport = createMockTransport({
      getCapabilities: vi.fn().mockResolvedValue(mockCapabilitiesResponse),
    });
    const { Wrapper, queryClient } = createWrapper(transport);

    // First render — loads data
    const { result: r1 } = renderHook(() => useRuntimeCapabilities(), { wrapper: Wrapper });
    await waitFor(() => {
      expect(r1.current.isSuccess).toBe(true);
    });

    // Second render of the same hook with the same query client — should use cache
    const { result: r2 } = renderHook(() => useRuntimeCapabilities(), { wrapper: Wrapper });
    await waitFor(() => {
      expect(r2.current.isSuccess).toBe(true);
    });

    // getCapabilities should only have been called once despite two renders
    expect(transport.getCapabilities).toHaveBeenCalledTimes(1);
    void queryClient; // keep reference alive
  });

  it('returns capabilities with correct runtime type', async () => {
    const transport = createMockTransport({
      getCapabilities: vi.fn().mockResolvedValue(mockCapabilitiesResponse),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useRuntimeCapabilities(), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data?.defaultRuntime).toBe('claude-code');
    expect(result.current.data?.capabilities['claude-code'].type).toBe('claude-code');
  });
});

// ---------------------------------------------------------------------------
// useCapabilitiesForRuntime — the static per-runtime lookup. Verified against
// all three REAL profiles so a capability-gated surface can trust the flags.
// ---------------------------------------------------------------------------
describe('useCapabilitiesForRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves the Claude Code profile: every gate open', async () => {
    const transport = createMockTransport({
      getCapabilities: vi.fn().mockResolvedValue(mockCapabilitiesResponse),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useCapabilitiesForRuntime('claude-code'), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current).toBeDefined();
    });

    expect(result.current?.type).toBe('claude-code');
    expect(result.current?.supportsToolApproval).toBe(true);
    expect(result.current?.supportsCostTracking).toBe(true);
    expect(result.current?.supportsMcp).toBe(true);
    expect(result.current?.supportsQuestionPrompt).toBe(true);
    expect(result.current?.supportsPlugins).toBe(true);
    expect(result.current?.permissionModes.values.map((m) => m.id)).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'bypassPermissions',
      'auto',
    ]);
  });

  it('resolves the Codex profile: approval, cost, MCP, question, and plugin gates closed', async () => {
    const transport = createMockTransport({
      getCapabilities: vi.fn().mockResolvedValue(mockCapabilitiesResponse),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useCapabilitiesForRuntime('codex'), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current).toBeDefined();
    });

    expect(result.current?.type).toBe('codex');
    expect(result.current?.supportsToolApproval).toBe(false);
    expect(result.current?.supportsCostTracking).toBe(false);
    expect(result.current?.supportsMcp).toBe(false);
    expect(result.current?.supportsQuestionPrompt).toBe(false);
    expect(result.current?.supportsPlugins).toBe(false);
    // Codex declares sandbox-posture modes, not Claude's mode set.
    expect(result.current?.permissionModes.values.map((m) => m.label)).toEqual([
      'Read only',
      'Workspace write',
      'Full access',
    ]);
  });

  it('resolves the OpenCode profile: approval and cost open, MCP/question/plugins closed', async () => {
    const transport = createMockTransport({
      getCapabilities: vi.fn().mockResolvedValue(mockCapabilitiesResponse),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useCapabilitiesForRuntime('opencode'), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current).toBeDefined();
    });

    expect(result.current?.type).toBe('opencode');
    expect(result.current?.supportsToolApproval).toBe(true);
    expect(result.current?.supportsCostTracking).toBe(true);
    expect(result.current?.supportsMcp).toBe(false);
    expect(result.current?.supportsQuestionPrompt).toBe(false);
    expect(result.current?.supportsPlugins).toBe(false);
    expect(result.current?.permissionModes.values.map((m) => m.id)).toEqual([
      'default',
      'acceptEdits',
      'bypassPermissions',
    ]);
  });

  it('falls back to the server-default runtime for a nullish runtime type', async () => {
    const transport = createMockTransport({
      getCapabilities: vi.fn().mockResolvedValue(mockCapabilitiesResponse),
    });
    const { Wrapper } = createWrapper(transport);

    const { result: nullResult } = renderHook(() => useCapabilitiesForRuntime(null), {
      wrapper: Wrapper,
    });
    await waitFor(() => {
      expect(nullResult.current).toBeDefined();
    });
    expect(nullResult.current?.type).toBe('claude-code');

    const { result: undefinedResult } = renderHook(() => useCapabilitiesForRuntime(undefined), {
      wrapper: Wrapper,
    });
    await waitFor(() => {
      expect(undefinedResult.current).toBeDefined();
    });
    expect(undefinedResult.current?.type).toBe('claude-code');
  });

  it('returns undefined while the capabilities map is loading', () => {
    const transport = createMockTransport({
      getCapabilities: vi.fn().mockReturnValue(new Promise(() => {})),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useCapabilitiesForRuntime('codex'), {
      wrapper: Wrapper,
    });

    expect(result.current).toBeUndefined();
  });

  it('returns undefined for a runtime type not registered with this server', async () => {
    const transport = createMockTransport({
      getCapabilities: vi.fn().mockResolvedValue(mockCapabilitiesResponse),
    });
    const { Wrapper } = createWrapper(transport);

    // Both hooks in one render, and the wait is for the MAP to have loaded —
    // not for `getCapabilities` to have been called. The call happens on
    // mount, a tick before its promise resolves, so waiting on the call
    // asserts "undefined" against a map that is not there yet and passes
    // however the lookup behaves — classic verification-that-cannot-fail
    // (DOR-1639). Same shape the prototype-key cases below use.
    const { result } = renderHook(
      () => ({
        map: useRuntimeCapabilities(),
        caps: useCapabilitiesForRuntime('mystery-rt'),
      }),
      { wrapper: Wrapper }
    );

    await waitFor(() => {
      expect(result.current.map.isSuccess).toBe(true);
    });

    expect(result.current.caps).toBeUndefined();
  });

  it.each(['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty'])(
    'returns undefined for "%s" instead of an inherited member',
    async (runtimeType) => {
      // A runtime type is a free string that arrives from stored data — a task's
      // `runtime`, an agent manifest — so these five are reachable lookups. A
      // plain index answers every one of them off `Object.prototype`: truthy,
      // and shaped like nothing, so a caller takes it for a profile and reads
      // fields that are not there (DOR-1615). Unregistered is unregistered.
      const transport = createMockTransport({
        getCapabilities: vi.fn().mockResolvedValue(mockCapabilitiesResponse),
      });
      const { Wrapper } = createWrapper(transport);

      // Both hooks in one render, and the wait is for the MAP to have loaded —
      // not for `getCapabilities` to have been called. The call happens on mount,
      // a tick before its promise resolves, so waiting on the call would assert
      // "undefined" against a map that is not there yet and pass however the
      // lookup behaves. Measured: written that way, this survived reverting the
      // guard.
      const { result } = renderHook(
        () => ({
          map: useRuntimeCapabilities(),
          caps: useCapabilitiesForRuntime(runtimeType),
        }),
        { wrapper: Wrapper }
      );

      await waitFor(() => {
        expect(result.current.map.isSuccess).toBe(true);
      });

      expect(result.current.caps).toBeUndefined();
    }
  );

  it('never issues a per-session fetch — one capabilities call serves every lookup', async () => {
    // Regression guard for the staleness trap this hook replaced: resolving a
    // session's runtime used to hit an infer-on-miss endpoint per session and
    // cache the answer forever, pinning the wrong profile for sessions that
    // later bound to a non-default runtime.
    const getCapabilities = vi.fn().mockResolvedValue(mockCapabilitiesResponse);
    const transport = createMockTransport({ getCapabilities });
    const { Wrapper } = createWrapper(transport);

    const { result: r1 } = renderHook(() => useCapabilitiesForRuntime('codex'), {
      wrapper: Wrapper,
    });
    await waitFor(() => {
      expect(r1.current).toBeDefined();
    });

    const { result: r2 } = renderHook(() => useCapabilitiesForRuntime('opencode'), {
      wrapper: Wrapper,
    });
    await waitFor(() => {
      expect(r2.current).toBeDefined();
    });

    expect(getCapabilities).toHaveBeenCalledTimes(1);
    expect(transport.getSessionRuntimeType).not.toHaveBeenCalled();
  });
});
