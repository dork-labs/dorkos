// @vitest-environment jsdom
/**
 * The hook's effort verdict comes from the runtime's own declaration.
 *
 * The rules themselves are tested one layer down in `execution-config.test.ts`;
 * what is worth pinning here is the WIRING — that the capability map's
 * `settings.supportsEffort` is what reaches `describeAgentExecution`, so a
 * runtime that declares it takes no effort is the reason a row reads broken,
 * rather than a list of runtime names kept anywhere in the client.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useExecutionExceptions } from '../model/use-execution-exceptions';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** A capability entry that declares only what this hook reads. */
function runtimeEntry(type: string, supportsEffort: boolean): RuntimeCapabilities {
  return {
    type,
    supportsToolApproval: true,
    supportsCostTracking: false,
    supportsResume: true,
    supportsMcp: true,
    supportsManagedMcpServers: true,
    supportsQuestionPrompt: true,
    supportsPlugins: false,
    supportsPersistentSession: false,
    supportsSteer: false,
    supportsContextStaging: false,
    permissionModes: { supported: false, values: [] },
    settings: { configSection: type, supportsEffort, sections: [] },
    commandIntents: { compact: { supported: false } },
    nativeContext: [],
    features: {},
  };
}

const AGENT: AgentManifest = {
  id: 'a',
  name: 'alpha',
  description: '',
  runtime: 'opencode',
  effort: 'high',
  capabilities: [],
} as unknown as AgentManifest;

function renderExceptions(opencodeSupportsEffort: boolean) {
  const transport: Transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue({
      version: '1.0.0',
      port: 4242,
      uptime: 0,
      workingDirectory: '/test',
      nodeVersion: 'v20.0.0',
      platform: 'linux-x64',
      runtimes: ['claude-code', 'opencode'],
      claudeCliPath: null,
      executionDefaults: {
        runtime: 'claude-code',
        trustStop: null,
        // Deliberately no `opencode` row: the defaults are not the source of
        // this answer, the capability map is.
        perRuntime: [
          {
            runtime: 'claude-code',
            model: 'opus',
            effort: 'medium',
            supportsEffort: true,
            trustStop: null,
          },
        ],
      },
      tunnel: {
        enabled: false,
        connected: false,
        url: null,
        authEnabled: false,
        tokenConfigured: false,
      },
    }),
    getCapabilities: vi.fn().mockResolvedValue({
      capabilities: {
        'claude-code': runtimeEntry('claude-code', true),
        opencode: runtimeEntry('opencode', opencodeSupportsEffort),
      },
      defaultRuntime: 'claude-code',
    }),
    listMeshAgentPaths: vi
      .fn()
      .mockResolvedValue({ agents: [{ id: 'a', name: 'alpha', projectPath: '/p/alpha' }] }),
    resolveAgents: vi.fn().mockResolvedValue({ '/p/alpha': AGENT }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return renderHook(() => useExecutionExceptions(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    ),
  });
}

describe('useExecutionExceptions — runtime-declared effort support', () => {
  it('breaks an agent whose runtime declares it takes no effort', async () => {
    const { result } = renderExceptions(false);
    await waitFor(() => expect(result.current.exceptions).toHaveLength(1));
    const { report, path } = result.current.exceptions[0];
    expect(path).toBe('/p/alpha');
    expect(report.isBroken).toBe(true);
    expect(report.breakages.map((b) => b.message)).toEqual([
      'OpenCode has no effort setting, so this one does nothing.',
    ]);
    expect(result.current.brokenPaths).toEqual(['/p/alpha']);
  });

  // The discriminator: nothing but the declaration changes between the two
  // renders, so a verdict that survived this flip would not be reading it.
  it('leaves the same agent unbroken when the runtime declares it does', async () => {
    const { result } = renderExceptions(true);
    await waitFor(() => expect(result.current.exceptions).toHaveLength(1));
    const { report } = result.current.exceptions[0];
    expect(report.breakages).toEqual([]);
    expect(report.isBroken).toBe(false);
    expect(result.current.brokenPaths).toEqual([]);
  });
});
