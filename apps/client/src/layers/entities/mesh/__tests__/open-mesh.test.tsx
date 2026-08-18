// @vitest-environment jsdom
/**
 * The mesh-wide "Let all my agents talk to each other" switch (DOR-1338), on
 * the two behaviours a person notices when they are wrong: the switch that
 * lies about its state after a failed write, and a notice that nags about
 * DorkBot — an agent every install has and every agent can already reach.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, renderHook, screen, waitFor, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { AgentManifest, TopologyView } from '@dorkos/shared/mesh-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useSetOpenMesh } from '../model/use-mesh-access';
import { useTopology } from '../model/use-mesh-topology';
import { useRegisteredAgents } from '../model/use-mesh-agents';
import { OpenMeshNotice, OPEN_MESH_LABEL } from '../ui/OpenMeshSwitch';

const TOPOLOGY_KEY = ['mesh', 'topology'] as const;

const CLOSED_MESH: TopologyView = {
  callerNamespace: '*',
  namespaces: [],
  accessRules: [
    { sourceNamespace: 'ns-a', targetNamespace: 'ns-b', action: 'allow', origin: 'explicit' },
  ],
  openMesh: false,
};

function makeAgent(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    id: 'agent-1',
    name: 'scout',
    description: '',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: '2026-01-01T00:00:00.000Z',
    registeredBy: 'test',
    personaEnabled: true,
    enabledToolGroups: {},
    mcpServers: [],
    ...overrides,
  } as AgentManifest;
}

function createHarness(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }
  return { queryClient, Wrapper };
}

describe('useSetOpenMesh — the optimistic flip', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it('flips openMesh before the request settles — the switch answers the click', async () => {
    // The PUT is held open, so the only thing that can have flipped the cached
    // flag is the optimistic update.
    let releaseWrite!: (value: unknown) => void;
    const inFlight = new Promise((resolve) => {
      releaseWrite = resolve;
    });
    const transport = createMockTransport({
      getMeshTopology: vi.fn().mockResolvedValue(CLOSED_MESH),
      updateMeshAccessRule: vi.fn().mockReturnValue(inFlight),
    });
    const { queryClient, Wrapper } = createHarness(transport);

    const { result } = renderHook(
      () => ({ topology: useTopology(), setOpenMesh: useSetOpenMesh() }),
      { wrapper: Wrapper }
    );
    await waitFor(() => expect(result.current.topology.data?.openMesh).toBe(false));

    act(() => {
      result.current.setOpenMesh.mutate(true);
    });

    await waitFor(() =>
      expect(queryClient.getQueryData<TopologyView>([...TOPOLOGY_KEY, undefined])?.openMesh).toBe(
        true
      )
    );
    expect(transport.updateMeshAccessRule).toHaveBeenCalledWith({
      sourceNamespace: '*',
      targetNamespace: '*',
      action: 'allow',
    });

    await act(async () => {
      releaseWrite({
        sourceNamespace: '*',
        targetNamespace: '*',
        action: 'allow',
        origin: 'explicit',
      });
      await inFlight;
    });
  });

  it('rolls the cache back — flag AND rules — when the write fails', async () => {
    // Only the FIRST fetch resolves; `onSettled`'s refetch is held open, so a
    // correct-looking cache here can only be the rollback's doing. Without the
    // held refetch this assertion passes with `onError` deleted — it would be
    // reading the refetched server state, not the rollback.
    const getMeshTopology = vi
      .fn()
      .mockResolvedValueOnce(CLOSED_MESH)
      .mockReturnValue(new Promise(() => {}));
    const transport = createMockTransport({
      getMeshTopology,
      updateMeshAccessRule: vi.fn().mockRejectedValue(new Error('server said no')),
    });
    const { queryClient, Wrapper } = createHarness(transport);

    const { result } = renderHook(
      () => ({ topology: useTopology(), setOpenMesh: useSetOpenMesh() }),
      { wrapper: Wrapper }
    );
    await waitFor(() => expect(result.current.topology.data?.openMesh).toBe(false));

    await act(async () => {
      result.current.setOpenMesh.mutate(true);
    });
    await waitFor(() => expect(result.current.setOpenMesh.isError).toBe(true));
    expect(getMeshTopology).toHaveBeenCalledTimes(2); // the refetch fired and is pending

    // A switch that stays on after a failed write tells the operator the mesh
    // is open when it is not — the exact lie this feature exists to remove.
    const rolledBack = queryClient.getQueryData<TopologyView>([...TOPOLOGY_KEY, undefined]);
    expect(rolledBack?.openMesh).toBe(false);
    expect(rolledBack?.accessRules).toEqual(CLOSED_MESH.accessRules);
  });
});

describe('OpenMeshNotice — who counts as "another agent"', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  /**
   * Renders the notice beside a probe that only appears once BOTH queries have
   * resolved. Awaiting the probe is what makes "the switch is absent" mean
   * "the rule excluded it" rather than "the data had not arrived yet" — a bare
   * `queryByRole` here passes on the first tick no matter what the rule does.
   */
  function renderNotice(agents: AgentManifest[], openMesh = false) {
    const transport = createMockTransport({
      getMeshTopology: vi.fn().mockResolvedValue({ ...CLOSED_MESH, openMesh }),
      listMeshAgents: vi.fn().mockResolvedValue({ agents }),
    });
    const { Wrapper } = createHarness(transport);

    function Probe() {
      const { data: topology } = useTopology();
      const { data: agentList } = useRegisteredAgents();
      if (!topology || !agentList) return null;
      return <div data-testid="loaded" />;
    }

    render(
      <>
        <OpenMeshNotice />
        <Probe />
      </>,
      { wrapper: Wrapper }
    );
    return screen.findByTestId('loaded');
  }

  it('stays silent when the only other agent is a system agent', async () => {
    await renderNotice([makeAgent({ id: 'dorkbot', name: 'dorkbot', isSystem: true })]);

    // DorkBot reaches every namespace through its own bridge rules, so it is
    // never the agent a new one fails to message. Nagging about it would be a
    // notice that is simply untrue.
    expect(screen.queryByRole('switch', { name: OPEN_MESH_LABEL })).not.toBeInTheDocument();
  });

  it('speaks up as soon as one non-system agent exists', async () => {
    renderNotice([
      makeAgent({ id: 'dorkbot', name: 'dorkbot', isSystem: true }),
      makeAgent({ id: 'agent-2', name: 'alpha' }),
    ]);

    expect(await screen.findByRole('switch', { name: OPEN_MESH_LABEL })).toBeInTheDocument();
  });

  it('stays silent when the switch is already on', async () => {
    await renderNotice([makeAgent({ id: 'agent-2', name: 'alpha' })], true);

    expect(screen.queryByRole('switch', { name: OPEN_MESH_LABEL })).not.toBeInTheDocument();
  });
});
