/**
 * How the in-session server's tools are LOADED, read off the live server
 * (DOR-1292).
 *
 * Tool search is on in this SDK, so an MCP server's tools are deferred by
 * default: absent from the turn-1 prompt, reachable only after `ToolSearch`. The
 * SDK offers `alwaysLoad` (server-wide on `createSdkMcpServer`, per-tool on
 * `tool()`'s fifth argument) and `searchHint`, both surfaced as `_meta` keys —
 * verified against the real factory and an in-memory MCP client rather than read
 * off the type declarations.
 *
 * DorkOS uses both unevenly on purpose, and this file is where that decision is
 * pinned rather than merely commented:
 *
 * - the standing tools always-load on a plain session, because a room turn cannot
 *   afford a lookup before it can react and `list_capabilities` is how everything
 *   else is found;
 * - a session that IS a registered mesh agent, with Relay wired, gets six more —
 *   the agent-to-agent path, for the same reason (DOR-1337 / F8);
 * - every advertised tool carries a hint, so the deferred remainder is findable
 *   by intent instead of by guessing a name;
 * - nothing else always-loads, because eighty-odd schemas on every turn's prompt
 *   is a worse trade than one search.
 *
 * The counts and the always-load set are asserted exactly, against the real
 * server, so growth in the tool surface is visible here rather than absorbed by a
 * `>` bound that can never fail.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('../../../../../env.js', () => ({
  env: { DORKOS_PORT: 4242, MCP_API_KEY: undefined },
}));
vi.mock('../../../../../lib/version.js', () => ({ SERVER_VERSION: 'test', IS_DEV_BUILD: false }));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@dorkos/shared/manifest', () => ({ readManifest: vi.fn().mockResolvedValue(null) }));

import {
  createDorkOsToolServer,
  handRegisteredInSessionTools,
  dorkosToolSurfaceOf,
} from '../index.js';
import {
  ALWAYS_LOADED_TOOLS,
  AGENT_TO_AGENT_TOOLS,
  alwaysLoadedToolsFor,
  searchHintFrom,
  toolExposure,
} from '../tool-exposure.js';
import {
  IN_SESSION_TOOL_PREFIX,
  inSessionToolName,
} from '../../../../core/tool-names/tool-names.js';
import { composeCapabilityRegistryForDocs } from '../../../../core/self-description/dorkos-registry.js';
import type { AgentToolDeps } from '../../../../core/agent-tool-kit/agent-tool-kit.js';
import { CONNECTOR_RUNTIME_CAPABILITY_IDS } from '../../../../connectors/runtime-capability-scope.js';
import { createServerPrincipal } from '../../../../connectors/principal/server-principal.js';
import { composeDorkOsCapabilityRegistry } from '../../../../core/self-description/dorkos-registry.js';
import {
  capabilitiesForMcpServer,
  capabilityMcpInputObject,
  deriveMcpAnnotations,
} from '../../../../core/capabilities/mcp-projection.js';
import { toolSurfaceDigest } from '../tool-surface.js';
import { noopLogger } from '@dorkos/shared/logger';
import type { CapabilityRegistry } from '../../../../core/capabilities/index.js';
import type { ServerPrincipalProof } from '../../../../core/connections-lease/index.js';
import {
  clearTestHomes,
  registerEveryFolderAsHome,
} from '../../../../core/agent-identity/__tests__/agent-home-fixture.js';

// Every scratch folder counts as a registered home here, so this suite's
// mocked mesh decides who is an agent, as it did before homes (DOR-2355).
beforeEach(() => registerEveryFolderAsHome());
afterEach(() => clearTestHomes());

/** The SDK's private spelling of the two loading controls. */
const ALWAYS_LOAD_META = 'anthropic/alwaysLoad';

/** Deps with every optional service handle present, so the whole surface builds. */
function createFullDeps(): AgentToolDeps {
  const stub = {} as never;
  return {
    transcriptReader: {
      listSessions: vi.fn().mockResolvedValue([]),
    } as unknown as AgentToolDeps['transcriptReader'],
    defaultCwd: '/tmp/dor-1292-exposure',
    dorkHome: '/tmp/dorkos-test-home',
    taskStore: stub,
    relayCore: stub,
    adapterManager: stub,
    traceStore: stub,
    bindingStore: stub,
    bindingRouter: stub,
    meshCore: stub,
    extensionManager: stub,
    runtimeRegistry: stub,
    activityService: stub,
  };
}

interface AdvertisedTool {
  name: string;
  inputSchema?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/**
 * Every tool the live in-session server advertises, with its `_meta`.
 *
 * @param session - The per-query session, when the case under test needs one.
 *   Omitted, the server builds as a plain session with no identity — which is
 *   what every assertion about the standing set relies on.
 * @param deps - Dependency override, for the mesh/relay wiring cases.
 */
async function advertisedTools(
  session?: { cwd?: string; connectorTurn?: unknown },
  deps: AgentToolDeps = createFullDeps(),
  registry: CapabilityRegistry = composeCapabilityRegistryForDocs()
): Promise<AdvertisedTool[]> {
  const server = createDorkOsToolServer(
    deps,
    session
      ? ({ eventQueue: [], ...session } as unknown as NonNullable<
          Parameters<typeof createDorkOsToolServer>[1]
        >)
      : undefined,
    undefined,
    undefined,
    registry
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'dor-1292-exposure-probe', version: '0.0.0' });
  await Promise.all([server.instance.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools as AdvertisedTool[];
}

/**
 * Deps whose Mesh recognises `/agents/alpha` as a registered agent.
 *
 * `getSubjectByPath` is the ONLY thing that makes a session an agent session —
 * the same server-side lookup `resolveSenderIdentity` uses, so nothing the model
 * says can put a session on this path.
 */
function createAgentSessionDeps(overrides: Partial<AgentToolDeps> = {}): AgentToolDeps {
  return {
    ...createFullDeps(),
    meshCore: {
      getSubjectByPath: (cwd: string) =>
        cwd === '/agents/alpha'
          ? { subject: 'relay.agent.team.alpha', agentId: 'alpha' }
          : undefined,
    } as unknown as AgentToolDeps['meshCore'],
    ...overrides,
  };
}

function runtimePrincipal(bindingId: string): ServerPrincipalProof {
  return createServerPrincipal({
    kind: 'runtime',
    owner: { kind: 'local_install', installationId: 'install-a' },
    bindingId,
    runtime: 'claude-code',
    canonicalSessionId: 'session-a',
    agentId: 'agent-a',
    agentPath: '/agents/alpha',
    canonicalCwd: '/agents/alpha',
  });
}

function connectorRegistry(access = vi.fn().mockResolvedValue({ connections: [] })) {
  return composeDorkOsCapabilityRegistry({
    logger: noopLogger,
    connectorExecutionDeps: {
      authorization: { assertAvailable: vi.fn() } as never,
      broker: {} as never,
      access: { listRuntimeConnections: access } as never,
      requests: {
        create: vi.fn(),
        getForRuntime: vi.fn(),
        waitForResolution: vi.fn(),
      } as never,
    },
  });
}

describe('in-session tool exposure', () => {
  it('RT-MCP-01: adds every strict principal-bound connector tool to an authenticated runtime turn', async () => {
    const resolvePrincipal = vi.fn().mockResolvedValue(runtimePrincipal('binding-a'));
    const registry = connectorRegistry();
    const tools = await advertisedTools(
      {
        cwd: '/agents/alpha',
        connectorTurn: {
          isConnectorCapabilityId: (id: string) =>
            CONNECTOR_RUNTIME_CAPABILITY_IDS.some((candidate) => candidate === id),
          resolvePrincipal,
          cancel: vi.fn().mockResolvedValue(undefined),
          revoke: vi.fn().mockResolvedValue(undefined),
          cancelled: false,
        },
      },
      createAgentSessionDeps(),
      registry
    );

    const connectorTools = tools.filter((tool) =>
      CONNECTOR_RUNTIME_CAPABILITY_IDS.some((candidate) => candidate === tool.name)
    );
    expect(connectorTools.map((tool) => tool.name)).toEqual(CONNECTOR_RUNTIME_CAPABILITY_IDS);
    expect(connectorTools.every((tool) => tool.inputSchema?.additionalProperties === false)).toBe(
      true
    );
    expect(
      connectorTools.find((tool) => tool.name === 'connectors.execute_destructive')?.inputSchema
    ).toMatchObject({ properties: { approvalToken: { type: 'string' } } });
    expect(resolvePrincipal).not.toHaveBeenCalled();
  });

  it('rejects private selectors on every principal-bound Claude tool before resolving a principal', async () => {
    const resolvePrincipal = vi.fn().mockResolvedValue(runtimePrincipal('binding-a'));
    const session = {
      cwd: '/agents/alpha',
      connectorTurn: {
        isConnectorCapabilityId: (id: string) =>
          CONNECTOR_RUNTIME_CAPABILITY_IDS.some((candidate) => candidate === id),
        resolvePrincipal,
      },
    };
    const server = createDorkOsToolServer(
      createAgentSessionDeps(),
      session as unknown as NonNullable<Parameters<typeof createDorkOsToolServer>[1]>,
      undefined,
      undefined,
      connectorRegistry()
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'connector-strict-schema-probe', version: '0.0.0' });
    await Promise.all([server.instance.connect(serverTransport), client.connect(clientTransport)]);

    const forbidden = [
      { name: 'connectors.list_granted_connections', arguments: { ownerId: 'install-b' } },
      {
        name: 'connectors.list_granted_operations',
        arguments: { connectionId: 'connection-a', providerInstanceId: 'provider-b' },
      },
      ...(['read', 'write', 'destructive'] as const).map((classification) => ({
        name: `connectors.execute_${classification}`,
        arguments: {
          connectionId: 'connection-a',
          operationRevisionId: 'revision-a',
          arguments: {},
          agentId: 'agent-b',
        },
      })),
    ];
    for (const request of forbidden) {
      await expect(client.callTool(request)).resolves.toMatchObject({ isError: true });
    }
    expect(resolvePrincipal).not.toHaveBeenCalled();
    const allowed = await client.callTool({
      name: 'connectors.list_granted_connections',
      arguments: {},
    });
    expect(allowed.isError).not.toBe(true);
    expect(resolvePrincipal).toHaveBeenCalledTimes(1);
    await Promise.all([client.close(), server.instance.close()]);
  });

  it('resolves the current Claude turn on every call from one warm SDK server', async () => {
    const first = vi.fn().mockResolvedValue(runtimePrincipal('binding-first'));
    const second = vi.fn().mockResolvedValue(runtimePrincipal('binding-second'));
    const session = {
      cwd: '/agents/alpha',
      connectorTurn: {
        isConnectorCapabilityId: () => true,
        resolvePrincipal: first,
      },
    };
    const server = createDorkOsToolServer(
      createAgentSessionDeps(),
      session as unknown as NonNullable<Parameters<typeof createDorkOsToolServer>[1]>,
      undefined,
      undefined,
      connectorRegistry()
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'connector-warm-turn-probe', version: '0.0.0' });
    await Promise.all([server.instance.connect(serverTransport), client.connect(clientTransport)]);

    expect(
      (await client.callTool({ name: 'connectors.list_granted_connections', arguments: {} }))
        .isError
    ).not.toBe(true);
    session!.connectorTurn = {
      isConnectorCapabilityId: () => true,
      resolvePrincipal: second,
    };
    expect(
      (await client.callTool({ name: 'connectors.list_granted_connections', arguments: {} }))
        .isError
    ).not.toBe(true);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    await Promise.all([client.close(), server.instance.close()]);
  });

  it('hands connector_recommend the turn principal so connected reads only this agent’s accounts', async () => {
    const principal = runtimePrincipal('binding-a');
    const access = vi.fn().mockResolvedValue({
      connections: [{ connectionId: 'c', toolkit: 'gmail', label: 'Mail', status: 'active' }],
    });
    const registry = composeDorkOsCapabilityRegistry({
      logger: noopLogger,
      connectorDeps: {
        registry: {
          assertAvailable: vi.fn(),
          providersForToolkit: async () => ({ providers: [], warnings: [] }),
          listProviders: () => [],
        } as never,
        catalog: vi.fn(async () => ({ services: [], warnings: [] })) as never,
      },
      connectorExecutionDeps: {
        authorization: { assertAvailable: vi.fn() } as never,
        broker: {} as never,
        access: { listRuntimeConnections: access } as never,
      },
    });
    const call = async (
      connectorTurn?: object,
      connectorTools = true,
      tool: { name: string; arguments: Record<string, unknown> } = {
        name: 'connector_recommend',
        arguments: { service: 'gmail' },
      }
    ) => {
      const session = { cwd: '/agents/alpha', ...(connectorTurn && { connectorTurn }) };
      const server = createDorkOsToolServer(
        createAgentSessionDeps(),
        session as unknown as NonNullable<Parameters<typeof createDorkOsToolServer>[1]>,
        undefined,
        undefined,
        registry,
        new Set(),
        undefined,
        connectorTools
      );
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'connector-recommend-probe', version: '0.0.0' });
      await Promise.all([
        server.instance.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const result = (await client.callTool(tool)) as { content: Array<{ text: string }> };
      await Promise.all([client.close(), server.instance.close()]);
      return JSON.parse(result.content[0]!.text) as { connected?: boolean };
    };
    const turn = (resolvePrincipal: () => Promise<unknown>) => ({
      isConnectorCapabilityId: (id: string) =>
        CONNECTOR_RUNTIME_CAPABILITY_IDS.some((candidate) => candidate === id),
      resolvePrincipal,
    });

    expect((await call(turn(async () => principal))).connected).toBe(true);
    expect(access).toHaveBeenCalledWith(principal);
    // No connector access this turn, connector tools not listed, or the turn
    // could not be bound: the flag is left out, never guessed.
    const unbound = vi.fn(async () => principal);
    expect(await call()).not.toHaveProperty('connected');
    expect(await call(turn(unbound), false)).not.toHaveProperty('connected');
    expect(unbound).not.toHaveBeenCalled();
    expect(
      await call(
        turn(async () => {
          throw new Error('turn ended');
        })
      )
    ).not.toHaveProperty('connected');
    // Only the allowlisted reader gets the principal: an ordinary in-session
    // tool on the same connector turn never opens or receives it.
    const notForOthers = vi.fn(async () => principal);
    await call(turn(notForOthers), true, { name: 'connector_list_toolkits', arguments: {} });
    expect(notForOthers).not.toHaveBeenCalled();
  });

  it('always-loads exactly the twelve a turn cannot search for first', async () => {
    const tools = await advertisedTools();
    const eager = tools
      .filter((t) => t._meta?.[ALWAYS_LOAD_META] === true)
      .map((t) => t.name)
      .sort();

    expect(eager).toEqual(
      [
        'list_capabilities',
        'post_to_room',
        'react_to_room_entry',
        'read_room_history',
        'search_room_history',
        // DOR-632: there must be no ToolSearch hop between an agent and
        // remembering. The prompt tells every agent on every turn to save what
        // it learns before the turn ends; a tool named in that instruction and
        // then deferred costs the turn it was written to save.
        'memory_write',
        // ADR 261017-153539, the same rule: `<session_model>` and the memory
        // block's notes line both name the tool that opens a notes file.
        'memory_read',
        // DOR-1532, the same rule applied to the same prompt. `<session_model>`
        // now names `search_member_rooms` as what to do when a turn is asked
        // about something said in another room — and names `list_member_rooms`
        // beside it — so both are prompt-named tools and neither may be deferred.
        'list_member_rooms',
        'search_member_rooms',
        // DOR-1999, the same rule again. `<room_tools>` names `read_canvas`
        // callably, and the turn that reaches for it is a room reply somebody is
        // waiting on: the context says WHAT is on the canvas and never what a
        // document says.
        'read_canvas',
        // Spec `agent-permissions` D15: the line that replaces a Blocked area's
        // tools names this one, so it may not be deferred.
        'request_permission',
        // DOR-2732: the `<context_warning>` note names it on the turn with the
        // least room to spend on a lookup.
        'compact_my_session',
      ].sort()
    );
    // The declared set and the served surface are the same set, in both
    // directions — a name declared here but never registered would otherwise sit
    // in the constant forever, doing nothing and looking load-bearing.
    expect(eager).toEqual([...ALWAYS_LOADED_TOOLS].sort());
  });

  // DOR-1337 (F8). An agent asking another agent a question had to ToolSearch
  // for `mesh_list` and the messaging schemas first, inside its own timeout —
  // the tester quoted the agent narrating exactly that. A session that IS an
  // agent gets those four eagerly; nothing else does. Two of them (`chat_send`,
  // `chat_read`) are capability-projected, so this also pins that the
  // capability half reads the session's set, not the standing one.
  it('adds the four agent-to-agent tools for a session that is a registered agent', async () => {
    const tools = await advertisedTools({ cwd: '/agents/alpha' }, createAgentSessionDeps());
    const eager = tools
      .filter((t) => t._meta?.[ALWAYS_LOAD_META] === true)
      .map((t) => t.name)
      .sort();

    expect(eager).toEqual(
      [
        'list_capabilities',
        'post_to_room',
        'react_to_room_entry',
        'read_room_history',
        'search_room_history',
        'list_member_rooms',
        'search_member_rooms',
        'read_canvas',
        'memory_write',
        'memory_read',
        'request_permission',
        'compact_my_session',
        'mesh_list',
        'mesh_inspect',
        'chat_send',
        'chat_read',
      ].sort()
    );
    expect(eager).toEqual([...alwaysLoadedToolsFor(true)].sort());
    // Every name in the constant is a tool the server really advertises, and the
    // two sets do not overlap — a stale or duplicated name would sit there
    // looking load-bearing while changing nothing.
    const advertised = new Set(tools.map((t) => t.name));
    expect([...AGENT_TO_AGENT_TOOLS].filter((n) => !advertised.has(n))).toEqual([]);
    expect([...AGENT_TO_AGENT_TOOLS].filter((n) => ALWAYS_LOADED_TOOLS.has(n))).toEqual([]);
  });
});

describe('the auto-approval allow-lists are spelled the way the SDK sends names', () => {
  it('qualifies every entry with the in-session prefix', async () => {
    // These sets are compared against the tool name Claude Code hands
    // `canUseTool`, which is `mcp__<server>__<tool>`. They used to type that
    // prefix out by hand, so renaming the MCP server would have emptied both
    // sets — silently, and fail-CLOSED: every DorkOS tool would start raising an
    // approval card, the four room verbs included, whose whole point is not to
    // raise one where nobody is watching to answer it.
    const { DORKOS_AGENT_TOOLS, IDENTITY_SCOPED_TOOLS } =
      await import('../../tool-gate/auto-allow.js');
    const unqualified = [...DORKOS_AGENT_TOOLS, ...IDENTITY_SCOPED_TOOLS].filter(
      (name) => !name.startsWith(IN_SESSION_TOOL_PREFIX)
    );
    expect(unqualified).toEqual([]);
    expect(DORKOS_AGENT_TOOLS.has(inSessionToolName('react_to_room_entry'))).toBe(true);
    // And the bare name is NOT a member, which is the half that would let an
    // unqualified spelling look like it worked.
    expect(DORKOS_AGENT_TOOLS.has('react_to_room_entry')).toBe(false);
  });

  it('covers every always-loaded room verb, so a room turn raises no card', async () => {
    // The two decisions have to agree: a tool put in the turn-1 prompt because a
    // room turn cannot afford a lookup must also skip the card that same turn.
    const { DORKOS_AGENT_TOOLS } = await import('../../tool-gate/auto-allow.js');
    const roomVerbs = [...ALWAYS_LOADED_TOOLS].filter((name) => name !== 'list_capabilities');
    for (const verb of roomVerbs) {
      expect(DORKOS_AGENT_TOOLS.has(inSessionToolName(verb)), `${verb} would raise a card`).toBe(
        true
      );
    }
  });
});

describe('searchHintFrom', () => {
  it('keeps the opening sentence and drops the elaboration', () => {
    expect(searchHintFrom('Post to a room. Not for direct messages.')).toBe('Post to a room');
    expect(searchHintFrom('React to a message — the quiet way to say seen')).toBe(
      'React to a message'
    );
  });
});

describe('complete full-object wire surface', () => {
  it.each(['plain', 'agent', 'principal'] as const)(
    'preserves exact names, SDK metadata, annotations and digest on %s sessions',
    async (kind) => {
      const registry = composeCapabilityRegistryForDocs();
      const deps = kind === 'plain' ? createFullDeps() : createAgentSessionDeps();
      const session =
        kind === 'plain'
          ? undefined
          : ({
              cwd: '/agents/alpha',
              eventQueue: [],
              ...(kind === 'principal'
                ? {
                    connectorTurn: {
                      isConnectorCapabilityId: (id: string) =>
                        CONNECTOR_RUNTIME_CAPABILITY_IDS.some((candidate) => candidate === id),
                      resolvePrincipal: vi.fn(async () => runtimePrincipal('surface-binding')),
                    },
                  }
                : {}),
            } as unknown as Parameters<typeof createDorkOsToolServer>[1]);
      const hidden = new Set(['list_capabilities', 'mesh_list']);
      const server = createDorkOsToolServer(deps, session, undefined, undefined, registry, hidden);
      const hand = handRegisteredInSessionTools(deps, { ...(session ? { session } : {}) }).filter(
        (entry) => !hidden.has(entry.name)
      );
      const ordinary = capabilitiesForMcpServer(registry, 'in-session').filter(
        (cap) => !hidden.has(cap.surfaces.mcp!.toolName)
      );
      expect(ordinary.length).toBeGreaterThan(0);
      expect(hand.length).toBeGreaterThan(0);
      const privateCaps =
        kind === 'principal'
          ? CONNECTOR_RUNTIME_CAPABILITY_IDS.map((id) => {
              const cap = registry.get(id);
              expect(cap, id).toBeDefined();
              return cap!;
            })
          : [];
      const expected = [
        ...hand.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        ...ordinary.map((cap) => ({
          name: cap.surfaces.mcp!.toolName,
          description: cap.description,
          inputSchema: capabilityMcpInputObject(cap),
        })),
        ...privateCaps.map((cap) => ({
          name: cap.id,
          description: cap.description,
          inputSchema: capabilityMcpInputObject(cap),
        })),
      ];
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'full-surface-proof', version: '1.0.0' });
      try {
        await Promise.all([server.instance.connect(b), client.connect(a)]);
        const tools = (await client.listTools()).tools;
        const names = tools.map((entry) => entry.name);
        expect(names).toHaveLength(expected.length);
        expect(new Set(names).size).toBe(names.length);
        expect([...names].sort()).toEqual(expected.map((entry) => entry.name).sort());
        expect(names).not.toContain('list_capabilities');
        expect(names).not.toContain('mesh_list');
        const byName = new Map(tools.map((entry) => [entry.name, entry]));
        for (const cap of ordinary) {
          const name = cap.surfaces.mcp!.toolName;
          const descriptor = tool(
            name,
            cap.description,
            {},
            async () => ({ content: [] }),
            toolExposure(name, cap.title, alwaysLoadedToolsFor(kind !== 'plain'))
          );
          expect(byName.get(name)?._meta, name).toEqual(descriptor._meta);
          expect(byName.get(name)?.annotations, name).toBeUndefined();
        }
        for (const cap of privateCaps)
          expect(byName.get(cap.id)?.annotations, cap.id).toEqual(deriveMcpAnnotations(cap));
        expect(dorkosToolSurfaceOf(server.instance)).toBe(toolSurfaceDigest(expected));
      } finally {
        await client.close();
      }
    }
  );
});
