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
 * - exactly five tools always-load on a plain session, because a room turn cannot
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
import { describe, it, expect, vi } from 'vitest';
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

import { createDorkOsToolServer } from '../index.js';
import {
  ALWAYS_LOADED_TOOLS,
  AGENT_TO_AGENT_TOOLS,
  alwaysLoadedToolsFor,
  IN_SESSION_TOOL_PREFIX,
  inSessionToolName,
  searchHintFrom,
} from '../tool-exposure.js';
import { composeCapabilityRegistryForDocs } from '../../../../core/self-description/dorkos-registry.js';
import { NotifyBudget } from '../../../../relay/notify-budget.js';
import type { McpToolDeps } from '../types.js';
import { CONNECTOR_RUNTIME_CAPABILITY_IDS } from '../../../../connectors/runtime-capability-scope.js';
import { createServerPrincipal } from '../../../../connectors/principal/server-principal.js';
import { composeDorkOsCapabilityRegistry } from '../../../../core/self-description/dorkos-registry.js';
import { noopLogger } from '@dorkos/shared/logger';
import type { CapabilityRegistry } from '../../../../core/capabilities/index.js';
import type { ServerPrincipalProof } from '../../../../connectors/principal/server-principal.js';

/** The SDK's private spelling of the two loading controls. */
const ALWAYS_LOAD_META = 'anthropic/alwaysLoad';
const SEARCH_HINT_META = 'anthropic/searchHint';

/** Deps with every optional service handle present, so the whole surface builds. */
function createFullDeps(): McpToolDeps {
  const stub = {} as never;
  return {
    transcriptReader: {
      listSessions: vi.fn().mockResolvedValue([]),
    } as unknown as McpToolDeps['transcriptReader'],
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
    notifyBudget: new NotifyBudget(),
  };
}

interface AdvertisedTool {
  name: string;
  inputSchema?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

/**
 * Every tool the live in-session server advertises, with its `_meta`.
 *
 * @param session - The per-query session, when the case under test needs one.
 *   Omitted, the server builds as a plain session with no identity — which is
 *   what every assertion about the standing five relies on.
 * @param deps - Dependency override, for the mesh/relay wiring cases.
 */
async function advertisedTools(
  session?: { cwd?: string; connectorTurn?: unknown },
  deps: McpToolDeps = createFullDeps(),
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
function createAgentSessionDeps(overrides: Partial<McpToolDeps> = {}): McpToolDeps {
  return {
    ...createFullDeps(),
    meshCore: {
      getSubjectByPath: (cwd: string) =>
        cwd === '/agents/alpha'
          ? { subject: 'relay.agent.team.alpha', agentId: 'alpha' }
          : undefined,
    } as unknown as McpToolDeps['meshCore'],
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
  it('adds exactly seven strict connector tools to an authenticated runtime turn', async () => {
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

  it('rejects private selectors on all five Claude tools before resolving a principal', async () => {
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

    await client.callTool({ name: 'connectors.list_granted_connections', arguments: {} });
    session!.connectorTurn = {
      isConnectorCapabilityId: () => true,
      resolvePrincipal: second,
    };
    await client.callTool({ name: 'connectors.list_granted_connections', arguments: {} });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    await Promise.all([client.close(), server.instance.close()]);
  });

  it('always-loads exactly the nine a turn cannot search for first', async () => {
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
      ].sort()
    );
    // The declared set and the served surface are the same set, in both
    // directions — a name declared here but never registered would otherwise sit
    // in the constant forever, doing nothing and looking load-bearing.
    expect(eager).toEqual([...ALWAYS_LOADED_TOOLS].sort());
  });

  it('leaves the rest deferred rather than flooding the prompt', async () => {
    const tools = await advertisedTools();
    const deferred = tools.filter((t) => t._meta?.[ALWAYS_LOAD_META] !== true);
    // The exact surface, so a tool added tomorrow shows up here as a number to
    // look at rather than silently passing a `>` bound.
    //
    // 88 → 93 for the five room-MANAGEMENT verbs (DOR-1611), and all five land
    // in the DEFERRED column, which is the half worth checking. The four room
    // CONVERSATION verbs above are always-loaded because a room turn is a person
    // waiting; these are deliberate and occasional, and always-loading five more
    // schemas onto every turn of every session is the trade this file exists to
    // refuse. Both counts moving by the same five is what says so.
    //
    // 93 → 95 for the two room-REPO verbs, `merge_to_room_main` and
    // `room_repo_status` (DOR-1598), and both land in the DEFERRED column beside
    // the management five for the same reason. A merge is what an agent does
    // when a piece of work is FINISHED, and the status read is what it does
    // just before — deliberate and occasional, not the per-turn path a room
    // conversation takes. The rule that would force them the other way is the
    // one `context-tool-names.test.ts` owns: a tool the PROMPT names may not be
    // deferred, because the model is told to call it and then cannot. No prompt
    // block names either of these, which is what makes deferring them safe
    // rather than merely cheap. Both counts moving by the same two is what says
    // no schema quietly joined the always-loaded set.
    //
    // 95 → 96 for `update_agent_boundaries`, the NOPE.md write split out of
    // `update_agent` so it can be tier `destructive` (DOR-1698). It lands in the
    // DEFERRED column: rewriting an agent's safety boundaries is a deliberate,
    // rare act that a person has to approve anyway, so the turn that reaches for
    // it can afford the ToolSearch hop — and no prompt block names it, which is
    // the rule `context-tool-names.test.ts` owns. Both counts moving by one is
    // what says it did not quietly join the always-loaded set.
    //
    // 96 → 91 when brokered connector execution retired the five account,
    // connect-flow, and attachment capabilities from this general-purpose MCP
    // server. Their replacements live only on principal-bound runtime
    // projections; they must never reappear as deferred tools an ordinary
    // session or external projection can call.
    //
    // 91 → 92 for `read_canvas`, the one verb a room's shared canvas adds
    // (DOR-1999), and it lands in the DEFERRED column: reading the table is
    // something an agent does when it wants to, not the per-turn path a room
    // REPLY takes — and the room's own context block already tells every turn
    // what is on the canvas without any tool call at all. The rule that would
    // force it the other way is the one `context-tool-names.test.ts` owns: a
    // tool the PROMPT names may not be deferred. `<room_tools>` does name it,
    // and that is exactly why it also joins `ALWAYS_LOADED_TOOLS` above — both
    // counts move by one, which is what says nothing else came with it.
    //
    // 92 -> 98 for the six browser-driving verbs (spec `canvas-agent-seat`):
    // click, type, press, scroll, wait_for and read_page. All six land in the
    // DEFERRED column, and both counts moving by the same six is what says so.
    // A turn that is about to drive a page can afford the ToolSearch hop — it is
    // already several round trips into the preview — and always-loading six more
    // schemas onto every turn of every session is the trade this file refuses.
    // The rule that would force them the other way is the one
    // `context-tool-names.test.ts` owns: a tool the PROMPT names may not be
    // deferred. `<ui_tools>` does name them, in full and prefixed, which is the
    // same shape `control_ui` and `get_ui_state` have always had there and which
    // costs one search rather than a failed call.
    expect(tools).toHaveLength(98);
    expect(deferred).toHaveLength(89);
    const retiredConnectorTools = [
      'connector_list_accounts',
      'connector_start_connect',
      'connector_poll_connect',
      'connector_attach_account',
      'connector_detach_account',
    ];
    expect(
      tools.map((tool) => tool.name).filter((name) => retiredConnectorTools.includes(name))
    ).toEqual([]);
  });

  it('gives every advertised tool something to be found by', async () => {
    const tools = await advertisedTools();
    const unhinted = tools
      .filter((t) => typeof t._meta?.[SEARCH_HINT_META] !== 'string')
      .map((t) => t.name)
      .sort();
    expect(
      unhinted,
      'these tools carry no searchHint, so they can only be found by guessing their name'
    ).toEqual([]);
  });

  // DOR-1337 (F8). An agent asking another agent a question had to ToolSearch
  // for `mesh_list` and the relay schemas first, inside its own timeout — the
  // tester quoted the agent narrating exactly that. A session that IS an agent
  // gets those six eagerly; nothing else does.
  it('adds the six agent-to-agent tools for a session that is a registered agent', async () => {
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
        'mesh_list',
        'mesh_inspect',
        'relay_send',
        'relay_send_async',
        'relay_send_and_wait',
        'relay_inbox',
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

  it('leaves a plain session in the same directory family on the standing five', async () => {
    // Same deps, a cwd Mesh does not recognise: the six stay deferred, which is
    // the half that keeps eighty-odd schemas off most sessions' prompts.
    const tools = await advertisedTools({ cwd: '/tmp/just-a-project' }, createAgentSessionDeps());
    const eager = tools
      .filter((t) => t._meta?.[ALWAYS_LOAD_META] === true)
      .map((t) => t.name)
      .sort();
    expect(eager).toEqual([...ALWAYS_LOADED_TOOLS].sort());
  });

  it('keeps the six deferred for an agent session with Relay switched off', async () => {
    // No `relayCore` means no relay tool can do anything, so preloading their
    // schemas would spend prompt on six tools that answer RELAY_DISABLED.
    const deps = createAgentSessionDeps();
    delete (deps as { relayCore?: unknown }).relayCore;
    const tools = await advertisedTools({ cwd: '/agents/alpha' }, deps);
    const eager = tools
      .filter((t) => t._meta?.[ALWAYS_LOAD_META] === true)
      .map((t) => t.name)
      .sort();
    expect(eager).toEqual([...ALWAYS_LOADED_TOOLS].sort());
  });

  it('hints the room verbs with their curated capability titles', async () => {
    // The registry path hints from `capability.title`, the hand-registered path
    // from the description's first sentence. Both are pinned, because a hint
    // derived from the wrong field reads as noise and nothing else would notice.
    const byName = new Map((await advertisedTools()).map((t) => [t.name, t]));
    expect(byName.get('react_to_room_entry')?._meta?.[SEARCH_HINT_META]).toBe('React to a message');
    expect(byName.get('post_to_room')?._meta?.[SEARCH_HINT_META]).toBe('Post to a room');
    // Hand-registered: `relay_send`'s description opens with what it does.
    expect(typeof byName.get('relay_send')?._meta?.[SEARCH_HINT_META]).toBe('string');
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
      await import('../../messaging/interactive-handlers.js');
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
    const { DORKOS_AGENT_TOOLS } = await import('../../messaging/interactive-handlers.js');
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

  it('does not split on an abbreviation or a decimal', () => {
    expect(searchHintFrom('Put one emoji on one message, e.g. 👍 on a post')).toBe(
      'Put one emoji on one message, e.g. 👍 on a post'
    );
  });

  it('truncates a long description at a word boundary, never mid-word', () => {
    const hint = searchHintFrom(`${'alpha beta '.repeat(40)}omega`);
    expect(hint?.endsWith('…')).toBe(true);
    expect(hint!.length).toBeLessThanOrEqual(120);
    // The cut lands after a whole word: dropping the ellipsis leaves words that
    // are all intact. Cutting at the character count produced "…or o" for
    // `relay_inbox`, which nothing can match on.
    const words = hint!.slice(0, -1).split(' ');
    expect(words.every((word) => word === 'alpha' || word === 'beta')).toBe(true);
  });

  it('cuts a single over-long word where it is, having no boundary to use', () => {
    const hint = searchHintFrom('x'.repeat(400));
    expect(hint).toHaveLength(120);
    expect(hint?.endsWith('…')).toBe(true);
  });

  it('has nothing to say about an empty description', () => {
    expect(searchHintFrom('   ')).toBeUndefined();
  });
});
