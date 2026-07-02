// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { SystemRequirements } from '@dorkos/shared/agent-runtime';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import {
  useRuntimeRequirements,
  useRuntimeReadiness,
  isRuntimeReady,
  selectUnsatisfiedDeps,
} from '../model/use-runtime-requirements';

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

const mixedRequirements: SystemRequirements = {
  runtimes: {
    'claude-code': {
      dependencies: [
        {
          name: 'Claude Code CLI',
          description: 'Powers agent sessions.',
          status: 'satisfied',
          version: '1.0.0',
        },
      ],
    },
    codex: {
      dependencies: [
        {
          name: 'Codex CLI',
          description: 'The Codex CLI binary.',
          status: 'missing',
          installHint: 'npm i -g @openai/codex && codex login',
          infoUrl: 'https://developers.openai.com/codex',
        },
        {
          name: 'Codex login',
          description: 'ChatGPT or API-key auth.',
          status: 'satisfied',
        },
      ],
    },
  },
  allSatisfied: false,
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
describe('isRuntimeReady', () => {
  it('is true when every dependency is satisfied', () => {
    expect(isRuntimeReady(mixedRequirements, 'claude-code')).toBe(true);
  });

  it('is false when any dependency is missing or outdated', () => {
    expect(isRuntimeReady(mixedRequirements, 'codex')).toBe(false);
    const outdated: SystemRequirements = {
      runtimes: {
        opencode: {
          dependencies: [
            { name: 'OpenCode CLI', description: 'The OpenCode binary.', status: 'outdated' },
          ],
        },
      },
      allSatisfied: false,
    };
    expect(isRuntimeReady(outdated, 'opencode')).toBe(false);
  });

  it('is optimistically true while requirements are unknown (loading / not present)', () => {
    expect(isRuntimeReady(undefined, 'codex')).toBe(true);
    expect(isRuntimeReady(mixedRequirements, 'opencode')).toBe(true);
  });
});

describe('selectUnsatisfiedDeps', () => {
  it('returns only the failing dependency checks for a runtime', () => {
    const deps = selectUnsatisfiedDeps(mixedRequirements, 'codex');
    expect(deps).toHaveLength(1);
    expect(deps[0].name).toBe('Codex CLI');
    expect(deps[0].installHint).toBe('npm i -g @openai/codex && codex login');
  });

  it('returns [] for satisfied or unknown runtimes', () => {
    expect(selectUnsatisfiedDeps(mixedRequirements, 'claude-code')).toEqual([]);
    expect(selectUnsatisfiedDeps(mixedRequirements, 'nope')).toEqual([]);
    expect(selectUnsatisfiedDeps(undefined, 'codex')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// useRuntimeRequirements
// ---------------------------------------------------------------------------
describe('useRuntimeRequirements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches requirements from transport.checkRequirements', async () => {
    const transport = createMockTransport({
      checkRequirements: vi.fn().mockResolvedValue(mixedRequirements),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useRuntimeRequirements(), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mixedRequirements);
    expect(transport.checkRequirements).toHaveBeenCalledTimes(1);
  });

  it('exposes error state on transport failure', async () => {
    const transport = createMockTransport({
      checkRequirements: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useRuntimeRequirements(), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// useRuntimeReadiness
// ---------------------------------------------------------------------------
describe('useRuntimeReadiness', () => {
  const capabilitiesResponse = {
    capabilities: {
      'claude-code': { type: 'claude-code' },
      codex: { type: 'codex' },
    },
    defaultRuntime: 'claude-code',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports a registered runtime with satisfied checks as ready', async () => {
    const transport = createMockTransport({
      getCapabilities: vi.fn().mockResolvedValue(capabilitiesResponse),
      checkRequirements: vi.fn().mockResolvedValue(mixedRequirements),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useRuntimeReadiness('claude-code'), { wrapper: Wrapper });

    await waitFor(() => {
      expect(transport.checkRequirements).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(result.current).toEqual({ registered: true, ready: true, unsatisfiedDeps: [] });
    });
  });

  it('reports a registered runtime with a missing dependency as not ready', async () => {
    const transport = createMockTransport({
      getCapabilities: vi.fn().mockResolvedValue(capabilitiesResponse),
      checkRequirements: vi.fn().mockResolvedValue(mixedRequirements),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useRuntimeReadiness('codex'), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.ready).toBe(false);
    });
    expect(result.current.registered).toBe(true);
    expect(result.current.unsatisfiedDeps).toHaveLength(1);
  });

  it('reports a known-but-unregistered runtime as not ready once data loads', async () => {
    const transport = createMockTransport({
      getCapabilities: vi.fn().mockResolvedValue(capabilitiesResponse),
      checkRequirements: vi.fn().mockResolvedValue(mixedRequirements),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useRuntimeReadiness('opencode'), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.registered).toBe(false);
    });
    expect(result.current.ready).toBe(false);
  });

  it('is optimistically ready for undefined runtime and while data loads', () => {
    const transport = createMockTransport({
      getCapabilities: vi.fn().mockReturnValue(new Promise(() => {})),
      checkRequirements: vi.fn().mockReturnValue(new Promise(() => {})),
    });
    const { Wrapper } = createWrapper(transport);

    const { result: noType } = renderHook(() => useRuntimeReadiness(undefined), {
      wrapper: Wrapper,
    });
    expect(noType.current).toEqual({ registered: true, ready: true, unsatisfiedDeps: [] });

    const { result: loading } = renderHook(() => useRuntimeReadiness('codex'), {
      wrapper: Wrapper,
    });
    expect(loading.current.ready).toBe(true);
  });
});
