/**
 * Extension tools in every agent tool list, and in none of the privileged sets
 * (DOR-2685, task 3.2).
 *
 * An extension's tools join the live capability registry while it runs. Two
 * lists read that registry and must follow it both ways:
 *
 * - the in-session `dorkos` server Claude Code is handed (`createDorkOsToolServer`);
 * - the agent route of the runtime listener Codex and OpenCode call
 *   (`createAgentRuntimeMcpServer`, built for every request).
 *
 * And five hand-kept sets must never contain one, because each of them skips a
 * check: the always-loaded tools and the agent-to-agent six skip the search, the
 * DorkOS agent tools and Claude's read-only tools skip the approval card, and
 * the read-only MCP names skip the external server's token.
 *
 * Every case runs the real factories over the real docs registry with the
 * fixture extension's tools contributed through the same check discovery uses.
 * Lives under `claude-code/` because only this directory may load the Agent SDK.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ExtensionManifestSchema } from '@dorkos/extension-api';
import { checkDeclaredTools } from '@dorkos/extension-api/tool-check';
import { createTestDb } from '@dorkos/test-utils/db';
import type { AgentPermissions } from '@dorkos/shared/permissions';

vi.mock('../../../../../env.js', () => ({
  env: { DORKOS_PORT: 4242, MCP_API_KEY: undefined },
}));
vi.mock('../../../../../lib/version.js', () => ({ SERVER_VERSION: 'test', IS_DEV_BUILD: false }));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@dorkos/shared/manifest', () => ({ readManifest: vi.fn().mockResolvedValue(null) }));

import { createDorkOsToolServer, handRegisteredInSessionTools } from '../index.js';
import {
  ALWAYS_LOADED_TOOLS,
  AGENT_TO_AGENT_TOOLS,
  alwaysLoadedToolsFor,
  inSessionToolName,
} from '../tool-exposure.js';
import { DORKOS_AGENT_TOOLS, READ_ONLY_TOOLS } from '../../messaging/interactive-handlers.js';
import { READ_ONLY_MCP_TOOL_NAMES } from '../../../../core/external-mcp/tool-security.js';
import { composeCapabilityRegistryForDocs } from '../../../../core/self-description/dorkos-registry.js';
import {
  initPermissionGate,
  resetPermissionGate,
} from '../../../../core/capabilities/permission-enforcement.js';
import {
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../../../../core/capabilities/tier-enforcement.js';
import { ApprovalService } from '../../../../core/approvals/index.js';
import { eventFanOut } from '../../../../core/event-fan-out.js';
import { permissionActions } from '../../../../core/permissions/index.js';
import { resolveToolVisibility } from '../../../shared/permission-tool-filter.js';
import { createAgentRuntimeMcpServer } from '../../../connector-mcp/agent-runtime-server.js';
import {
  startConnectorRuntimeMcpListener,
  type ConnectorRuntimeMcpListener,
} from '../../../connector-mcp/listener.js';
import {
  CONNECTOR_RUNTIME_CWD_HEADER,
  CONNECTOR_RUNTIME_KIND_HEADER,
} from '../../../connector-tools.js';
import { createServerPrincipal } from '../../../../connectors/principal/server-principal.js';
import { NotifyBudget } from '../../../../relay/notify-budget.js';
import type { McpToolDeps } from '../types.js';
import type { CapabilityRegistry } from '../../../../core/capabilities/index.js';
import {
  clearTestHomes,
  registerEveryFolderAsHome,
} from '../../../../core/agent-identity/__tests__/agent-home-fixture.js';

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../extensions/__fixtures__/agent-tools-ext/extension.json'
);

/** The fixture's three tools, by the name the dorkos server lists them under. */
const FIXTURE_TOOLS = [
  'ext_agent_tools_ext__bump_counter',
  'ext_agent_tools_ext__delete_note',
  'ext_agent_tools_ext__echo',
];

const SEARCH_HINT_META = 'anthropic/searchHint';
const ALWAYS_LOAD_META = 'anthropic/alwaysLoad';

const identity = {
  agentPath: '/agents/a',
  displayName: 'Agent A',
  createdAt: '2026-10-04T00:00:00.000Z',
};

const principal = createServerPrincipal({
  kind: 'runtime',
  owner: { kind: 'local_install', installationId: 'install-a' },
  bindingId: 'binding-a',
  runtime: 'codex',
  canonicalSessionId: 'session-a',
  agentId: 'agent-a',
  agentPath: '/agents/a',
  canonicalCwd: '/agents/a',
});

/** Deps with every optional service handle present, so the whole surface builds. */
function createFullDeps(): McpToolDeps {
  const stub = {} as never;
  return {
    transcriptReader: {
      listSessions: vi.fn().mockResolvedValue([]),
    } as unknown as McpToolDeps['transcriptReader'],
    defaultCwd: '/tmp/dor-2685-every-list',
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

/** The fixture extension's tools, checked as discovery checks them. */
function fixtureContribution(ran: string[]) {
  const manifest = ExtensionManifestSchema.parse(JSON.parse(fs.readFileSync(FIXTURE, 'utf-8')));
  return {
    owner: manifest.id,
    displayName: manifest.name,
    tools: checkDeclaredTools(manifest).flatMap((c) =>
      c.ok
        ? [
            {
              ...c,
              invoke: async () => {
                ran.push(c.name);
                return 'ok';
              },
            },
          ]
        : []
    ),
  };
}

interface ListedTool {
  name: string;
  _meta?: Record<string, unknown>;
}

/** What the in-session `dorkos` server lists for one launch. */
async function inSessionList(
  registry: CapabilityRegistry,
  hidden: ReadonlySet<string> = new Set()
): Promise<ListedTool[]> {
  const server = createDorkOsToolServer(
    createFullDeps(),
    undefined,
    undefined,
    undefined,
    registry,
    hidden
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'dor-2685-in-session', version: '0.0.0' });
  await Promise.all([server.instance.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools as ListedTool[];
}

/** The extension tool names in a list, sorted. */
function extNames(tools: readonly { name: string }[]): string[] {
  return tools
    .map((tool) => tool.name)
    .filter((name) => name.startsWith('ext_'))
    .sort();
}

let registry: CapabilityRegistry;
let agent: AgentPermissions | undefined;
let ran: string[];

beforeEach(() => {
  registerEveryFolderAsHome();
  registry = composeCapabilityRegistryForDocs();
  agent = undefined;
  ran = [];
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  initCapabilityTierGate({ approvals: new ApprovalService(createTestDb()) });
  initPermissionGate({
    readConfig: () => ({ preset: 'balanced', defaults: { areas: {}, actions: {} } }),
    readAgentPermissions: async () => agent,
    listActions: () => permissionActions(registry),
  });
});

afterEach(() => {
  clearTestHomes();
  resetCapabilityTierGate();
  resetPermissionGate();
  vi.restoreAllMocks();
});

describe('the extension namespace (DOR-2685)', () => {
  it('is never used by a core capability or a hand-registered in-session tool', () => {
    // Purpose: `ext_` and `__` are how an extension tool is spelled. A core
    // tool in that shape could collide with one, or lock an extension out of
    // its own name.
    const capabilityNames = registry.capabilities.flatMap((c) => [
      c.id,
      ...(c.surfaces.mcp ? [c.surfaces.mcp.toolName] : []),
    ]);
    expect(capabilityNames.filter((name) => name.startsWith('ext_'))).toEqual([]);
    const handNames = handRegisteredInSessionTools(createFullDeps()).map((tool) => tool.name);
    expect(handNames.length).toBeGreaterThan(20);
    expect(handNames.filter((name) => name.startsWith('ext_') || name.includes('__'))).toEqual([]);
  });

  it('is empty in the docs registry, which is why the count guards never move', () => {
    // Purpose: the exact counts in `tool-exposure.test.ts` and
    // `context-tool-names.test.ts` read this registry. It composes no
    // extension, so an installed extension can never change those counts.
    expect(registry.capabilities.filter((c) => c.source?.kind === 'extension')).toEqual([]);
  });
});

describe('extension tools never enter a privileged set (DOR-2685)', () => {
  it('keeps every fixture tool out of all five, bare and qualified', () => {
    // Purpose: each set skips a check. Membership is hand-kept, so this pins
    // that no extension name was ever added and that no qualified spelling
    // could match one.
    const contributed = registry.contribute(fixtureContribution(ran));
    if (!contributed.ok) throw new Error(contributed.reason);
    const extTools = permissionActions(registry).filter((a) => a.source?.kind === 'extension');
    expect(extTools.map((a) => a.toolName).sort()).toEqual(FIXTURE_TOOLS);

    const privileged: ReadonlyArray<[string, ReadonlySet<string>]> = [
      ['ALWAYS_LOADED_TOOLS', ALWAYS_LOADED_TOOLS],
      ['AGENT_TO_AGENT_TOOLS', AGENT_TO_AGENT_TOOLS],
      ['alwaysLoadedToolsFor(agent)', alwaysLoadedToolsFor(true)],
      ['DORKOS_AGENT_TOOLS', DORKOS_AGENT_TOOLS],
      ['READ_ONLY_TOOLS', READ_ONLY_TOOLS],
      ['READ_ONLY_MCP_TOOL_NAMES', READ_ONLY_MCP_TOOL_NAMES],
    ];
    for (const name of FIXTURE_TOOLS) {
      for (const [setName, set] of privileged) {
        expect(set.has(name), `${name} is in ${setName}`).toBe(false);
        expect(set.has(inSessionToolName(name)), `${name} (qualified) is in ${setName}`).toBe(
          false
        );
      }
    }
    contributed.remove();
  });

  it('puts every fixture tool in the Extension tools area, deferred and findable', async () => {
    // Purpose: one switch takes them all away, and none rides the turn-1
    // prompt, but each can still be found by search.
    const contributed = registry.contribute(fixtureContribution(ran));
    if (!contributed.ok) throw new Error(contributed.reason);
    for (const capability of registry.capabilities.filter((c) => c.source?.kind === 'extension')) {
      expect(capability.area).toBe('extensions');
    }
    const listed = (await inSessionList(registry)).filter((tool) => tool.name.startsWith('ext_'));
    expect(listed).toHaveLength(FIXTURE_TOOLS.length);
    for (const tool of listed) {
      expect(tool._meta?.[ALWAYS_LOAD_META], tool.name).not.toBe(true);
      const hint = tool._meta?.[SEARCH_HINT_META];
      expect(typeof hint === 'string' && hint.length > 0, `${tool.name} has no search hint`).toBe(
        true
      );
    }
    contributed.remove();
  });
});

describe('extension tools reach and leave the Claude Code list (DOR-2685)', () => {
  it('lists the fixture tools after they are contributed and not after they are removed', async () => {
    // Purpose: a fresh launch lists exactly what is running; a warm process
    // follows through the `toolSurface` relaunch pin (`tool-surface.test.ts`).
    expect(extNames(await inSessionList(registry))).toEqual([]);
    const contributed = registry.contribute(fixtureContribution(ran));
    if (!contributed.ok) throw new Error(contributed.reason);
    expect(extNames(await inSessionList(registry))).toEqual(FIXTURE_TOOLS);
    contributed.remove();
    expect(extNames(await inSessionList(registry))).toEqual([]);
  });
});

describe('extension tools reach and leave the Codex and OpenCode list (DOR-2685)', () => {
  const listeners: ConnectorRuntimeMcpListener[] = [];

  afterEach(async () => {
    await Promise.all(listeners.splice(0).map((listener) => listener.close()));
  });

  /** A real runtime listener whose agent route builds from the live registry per request. */
  async function connectRuntimeClient(): Promise<Client> {
    const listener = await startConnectorRuntimeMcpListener({
      principals: {
        openTurn: vi.fn(),
        renew: vi.fn(),
        resolve: vi.fn().mockResolvedValue({ status: 'resolved', principal }),
        revoke: vi.fn(),
      },
      serverFactory: () => new McpServer({ name: 'connections', version: '1.0.0' }),
      // As the composition root does: visibility read fresh for this request.
      agentServerFactory: (verified) =>
        createAgentRuntimeMcpServer(
          registry,
          verified,
          identity,
          resolveToolVisibility(agent).hiddenToolNames
        ),
    });
    listeners.push(listener);
    const client = new Client({ name: 'dor-2685-runtime', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(listener.agentUrl), {
        requestInit: {
          headers: {
            authorization: 'Bearer turn-secret',
            [CONNECTOR_RUNTIME_KIND_HEADER]: 'codex',
            [CONNECTOR_RUNTIME_CWD_HEADER]: encodeURIComponent('/agents/a'),
          },
        },
      })
    );
    return client;
  }

  it('gives a client that stays connected the new list on its next tools/list', async () => {
    // Purpose: the proof behind "Codex and OpenCode see new tools the next
    // time they ask". One connected client, no reconnect: each request builds
    // its server from the live registry, so the next list carries the change.
    const client = await connectRuntimeClient();
    expect(extNames((await client.listTools()).tools)).toEqual([]);

    const contributed = registry.contribute(fixtureContribution(ran));
    if (!contributed.ok) throw new Error(contributed.reason);
    expect(extNames((await client.listTools()).tools)).toEqual(FIXTURE_TOOLS);

    contributed.remove();
    expect(extNames((await client.listTools()).tools)).toEqual([]);
    await client.close();
  });
});

describe('an agent whose Extension tools are Blocked (DOR-2685)', () => {
  beforeEach(() => {
    agent = { areas: { extensions: 'blocked' } };
  });

  it('sees no fixture tool in either list', async () => {
    // Purpose: hiding follows the same resolution the gate runs, in both
    // tool-list builders.
    const contributed = registry.contribute(fixtureContribution(ran));
    if (!contributed.ok) throw new Error(contributed.reason);
    const hidden = resolveToolVisibility(agent).hiddenToolNames;
    for (const name of FIXTURE_TOOLS) expect(hidden.has(name)).toBe(true);

    expect(extNames(await inSessionList(registry, hidden))).toEqual([]);

    const server = createAgentRuntimeMcpServer(registry, principal, identity, hidden);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'dor-2685-blocked', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    expect(extNames((await client.listTools()).tools)).toEqual([]);
    await client.close();
    contributed.remove();
  });

  it('is still refused by the gate when it calls a fixture tool directly', async () => {
    // Purpose: hiding is a courtesy, never the enforcement. A call that names
    // the tool anyway is refused, and the extension's handler never runs.
    const contributed = registry.contribute(fixtureContribution(ran));
    if (!contributed.ok) throw new Error(contributed.reason);
    const calls: ReadonlyArray<[string, Record<string, unknown>]> = [
      ['ext_agent_tools_ext.echo', { message: 'hi' }],
      ['ext_agent_tools_ext.bump_counter', { by: 1 }],
      ['ext_agent_tools_ext.delete_note', { noteId: 'n1' }],
    ];
    for (const [id, input] of calls) {
      const refusal = await registry
        .invoke(id, input, { identity, retryChannel: 'mcp-argument' })
        .then(
          () => undefined,
          (err: unknown) => err
        );
      expect(refusal, id).toMatchObject({ decision: { payload: { status: 'denied' } } });
      expect(String((refusal as Error).message), id).toMatch(/Extension tools/);
    }
    expect(ran).toEqual([]);
    contributed.remove();
  });
});
