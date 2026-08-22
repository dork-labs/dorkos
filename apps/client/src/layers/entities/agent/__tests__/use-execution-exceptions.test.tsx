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

/**
 * An account nobody registered is a CATALOG-FREE breakage: the registry rides
 * `GET /api/config`, which every surface already holds, so unlike a missing
 * model it needs no per-runtime fetch. That is what lets it reach the sidebar's
 * Needs-attention group — `brokenPaths` here feeds `useAgentAttentionMap`
 * through `use-sidebar-state.ts` — and it is only true while `checkModels` is
 * off, which is how the sidebar calls this hook.
 */
describe('useExecutionExceptions — a billing account nobody registered', () => {
  const ACCOUNT_AGENT = {
    id: 'a',
    name: 'alpha',
    description: '',
    runtime: 'claude-code',
    capabilities: [],
  } as unknown as AgentManifest;

  function renderAccounts(
    agentAccount: string | undefined,
    claudeCode:
      | {
          resolvedAccount: string;
          inherited: boolean;
          accounts: { id: string | null; path: string; label: string | null }[];
          accountsUnavailable?: boolean;
        }
      | undefined,
    /**
     * The server's default runtime. Worth varying for one reason only: it is
     * the single value in this hook's answer that reads differently before and
     * after the config query lands, which makes it the only honest thing to
     * wait on when the assertion is an ABSENCE. `ACCOUNT_AGENT` pins its own
     * runtime, so changing this moves no account logic.
     */
    defaultRuntime = 'claude-code'
  ) {
    const transport: Transport = createMockTransport({
      getConfig: vi.fn().mockResolvedValue({
        version: '1.0.0',
        port: 4242,
        uptime: 0,
        workingDirectory: '/test',
        nodeVersion: 'v20.0.0',
        platform: 'linux-x64',
        runtimes: ['claude-code'],
        claudeCliPath: null,
        claudeCode,
        executionDefaults: {
          runtime: defaultRuntime,
          trustStop: null,
          perRuntime: [
            {
              runtime: 'claude-code',
              model: null,
              effort: null,
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
        capabilities: { 'claude-code': runtimeEntry('claude-code', true) },
        defaultRuntime: 'claude-code',
      }),
      listMeshAgentPaths: vi
        .fn()
        .mockResolvedValue({ agents: [{ id: 'a', name: 'alpha', projectPath: '/p/alpha' }] }),
      resolveAgents: vi
        .fn()
        .mockResolvedValue({ '/p/alpha': { ...ACCOUNT_AGENT, account: agentAccount } }),
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    // No `checkModels` — exactly how the sidebar calls it.
    return renderHook(() => useExecutionExceptions(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>{children}</TransportProvider>
        </QueryClientProvider>
      ),
    });
  }

  const REGISTRY = {
    resolvedAccount: '/Users/dev/.claude',
    inherited: true,
    accounts: [{ id: 'work', path: '/Users/dev/.claude-work', label: 'Acme Corp' }],
  };

  it('puts the agent in brokenPaths, so the sidebar can raise it', async () => {
    const { result } = renderAccounts('retired-client', REGISTRY);
    await waitFor(() => expect(result.current.brokenPaths).toEqual(['/p/alpha']));
    expect(result.current.exceptions[0].report.breakages.map((b) => b.kind)).toEqual([
      'account-unregistered',
    ]);
  });

  // The discriminator: only the id changes, and the same agent goes quiet.
  it('leaves a registered account out of brokenPaths entirely', async () => {
    const { result } = renderAccounts('work', REGISTRY);
    await waitFor(() => expect(result.current.exceptions).toHaveLength(1));
    expect(result.current.brokenPaths).toEqual([]);
    expect(result.current.exceptions[0].report.deviations).toEqual([
      { field: 'account', label: 'Acme Corp' },
    ]);
  });

  it('says nothing at all when the server could not READ the registry', async () => {
    // An empty list that means "nobody knows", not "nothing is registered".
    // Judged as the latter it would light every account-carrying agent in the
    // fleet amber for the length of an outage.
    //
    // The default runtime is deliberately CODEX here, and it is the whole
    // reason this test can fail. Every claim below is an absence, and an
    // absence asserted before the config lands is no claim at all —
    // `defaultRuntime` reads 'claude-code' on the first render whatever the
    // server eventually says, so waiting for THAT would certify nothing.
    // Waiting for it to flip to a value only the response can produce is
    // waiting for the response.
    const { result } = renderAccounts(
      'retired-client',
      {
        resolvedAccount: '/Users/dev/.claude',
        inherited: true,
        accounts: [],
        accountsUnavailable: true,
      },
      'codex'
    );
    await waitFor(() => expect(result.current.defaultRuntime).toBe('codex'));

    // The agent still deviates — it pins claude-code while the fleet default is
    // codex — so it is in the list, which is what makes the two absences below
    // absences rather than an empty list nobody populated.
    expect(result.current.exceptions.flatMap((e) => e.report.deviations)).toEqual([
      { field: 'runtime', label: 'Claude Code' },
    ]);
    expect(result.current.exceptions.flatMap((e) => e.report.breakages)).toEqual([]);
    expect(result.current.brokenPaths).toEqual([]);
  });

  // The discriminator for the flag: the same empty list WITHOUT it is an
  // answer, and the same agent is broken against it.
  it('still calls it broken against an empty registry the server DID read', async () => {
    const { result } = renderAccounts('retired-client', {
      resolvedAccount: '/Users/dev/.claude',
      inherited: true,
      accounts: [],
    });
    await waitFor(() => expect(result.current.brokenPaths).toEqual(['/p/alpha']));
  });
});
