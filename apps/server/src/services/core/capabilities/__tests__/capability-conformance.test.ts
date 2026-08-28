/**
 * Wire the shared Capability Registry conformance suite (`@dorkos/test-utils`,
 * spec `capability-registry`, task 2.6) against the REAL composed DorkOS
 * registry — the per-PR drift gate. Green here proves that every capability the
 * operator, marketplace, and self-description domains declare projects onto
 * exactly the surfaces the real MCP adapters register, that the read-only
 * carve-out equals the registry derivation (never the phase-1 hand-list), that
 * tiers and carve-out flags agree, that no two capabilities collide on an
 * OpenAPI route, and that the docs projection serves the same routes as boot.
 *
 * It also proves the tier gate is real on ALL THREE adapter paths (spec
 * `agent-trust` §3.2). The probes drive the registry's one genuinely `destructive`
 * capability — `marketplace.uninstall` — through the REAL invoke route, the REAL
 * in-session adapter, and the REAL external adapter, with an agent identity and no
 * approval token, and assert each comes back with an `approval_required` payload
 * while the fake `uninstallFlow` never runs. A path that forgets the gate fails
 * here; the shared suite's own test proves this check can fail.
 *
 * And it proves the other half of the gate: `requesterDecideProbe` takes the
 * approval the REAL invoke route just handed an anonymous caller and tries to grant
 * it through the REAL approvals router as that same caller. That must be refused
 * with the approval left pending — otherwise an agent grants its own permission,
 * which is precisely what review reproduced end to end.
 *
 * The registry is composed with FAKE operator + marketplace deps, and the three
 * non-hermetic seams the operator handlers reach through module singletons —
 * `config-patch` (config snapshot/merge), `update-checker` (npm fetch), and the
 * filesystem boundary — are mocked so the `invoke` assertions touch no real
 * `~/.dork` and hit no network. The MCP tool-name fixtures come from the REAL
 * adapters (`capabilityMcpTools` for in-session; `registerCapabilitiesAsMcpTools`
 * onto a real `McpServer` for external), so a bug in either adapter is caught.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { noopLogger } from '@dorkos/shared/logger';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { capabilityConformance } from '@dorkos/test-utils';

import { createTestDb } from '@dorkos/test-utils/db';

// ── Mock the non-hermetic seams the operator handlers reach through ─────────
// config.get / config.patch read + write the real `configManager` singleton via
// `config-patch.ts`; stub it so no real `~/.dork/config.json` is touched.
vi.mock('../../operator/config-patch.js', () => ({
  sanitizedConfigSnapshot: () => ({ version: 1 }),
  applyConfigPatch: (patch: Record<string, unknown>) => ({ version: 1, ...patch }),
}));
// check_update fetches the latest npm version; stub it so the suite hits no network.
vi.mock('../../update-checker.js', () => ({
  getLatestVersion: async () => null,
}));
// update_agent validates its target cwd against the filesystem boundary, which
// throws when uninitialized; stub it to pass the sandbox path through.
vi.mock('../../../../lib/boundary.js', () => ({
  validateBoundaryOrDorkHome: (p: string) => p,
  BoundaryError: class BoundaryError extends Error {},
}));
// update_agent reads the target agent's manifest off disk; stub it to "no agent
// here" so the handler returns its structured NOT_FOUND (a CapabilityToolError),
// never a raw filesystem throw.
vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: async () => null,
  writeManifest: async () => {},
}));
// The rooms domain resolves its caller against two INSTALL facts that live
// outside it — who owns this install, and whether login is on. Both read the real
// singletons, which would make this suite depend on the machine it runs on; the
// stubs pin the default posture (no owner, login off), which is the posture every
// other rooms test drives. Same shape, same reason as
// `routes/__tests__/room-capabilities-unverified-agent.test.ts`.
vi.mock('../../auth/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../auth/index.js')>()),
  readOwnerAccount: () => null,
}));
vi.mock('../../config-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config-manager.js')>()),
  configManager: {
    get: (section: string) => (section === 'auth' ? { enabled: false } : undefined),
    set: () => {},
  },
}));

const { composeDorkOsCapabilityRegistry, composeCapabilityRegistryForDocs } =
  await import('../../self-description/dorkos-registry.js');
const { capabilityMcpTools } =
  await import('../../../runtimes/claude-code/mcp-tools/capability-mcp-tools.js');
const { registerCapabilitiesAsMcpTools } =
  await import('../../external-mcp/capability-mcp-tools.js');
const { READ_ONLY_MCP_TOOL_NAMES } = await import('../../external-mcp/tool-security.js');
import type { McpToolDeps } from '../../../runtimes/claude-code/mcp-tools/types.js';
import type { MarketplaceMcpDeps } from '../../../marketplace-mcp/marketplace-mcp-tools.js';
import { AgentRegistry } from '@dorkos/mesh';
import { AgentMcpServerService } from '../../../mesh/agent-mcp-server-service.js';

/** A tmp path that need not exist — the fakes never touch real disk. */
const SANDBOX_CWD = path.join(os.tmpdir(), 'capability-conformance-sandbox');

/** Fake operator service handles — only the methods the invoked handlers call. */
const operatorDeps = {
  defaultCwd: SANDBOX_CWD,
  transcriptReader: {},
  activityService: { list: async () => ({ items: [], nextCursor: null }) },
  runtimeRegistry: { listRuntimes: () => [] },
  meshCore: { listWithPaths: () => [] },
} as unknown as McpToolDeps;

/**
 * Set by the fake `uninstallFlow` if it is ever reached. The destructive-gate
 * probes read it to prove the capability's handler did NOT run.
 */
let uninstallReached = false;

/** An empty permission preview, the shape `installer.preview` returns. */
const emptyPreview = {
  fileChanges: [],
  extensions: [],
  hooks: [],
  unreadableHooks: [],
  npmDependencies: [],
  schedules: [],
  secrets: [],
  externalHosts: [],
  requires: [],
  conflicts: [],
};

/**
 * Fake marketplace bundle. Read-only lookups resolve over zero sources; the
 * three mutations short-circuit at the confirmation gate (`pending`) before any
 * install/uninstall/create side effect, so their real service handles are never
 * reached. `installer.preview` still resolves because `marketplace_install`
 * builds the preview BEFORE the gate.
 */
const marketplaceDeps = {
  dorkHome: SANDBOX_CWD,
  installer: {
    preview: async () => ({
      preview: emptyPreview,
      manifest: {
        manifestVersion: 1,
        name: 'x',
        version: '1.0.0',
        type: 'plugin',
        description: 'x',
      },
      packagePath: path.join(SANDBOX_CWD, 'x'),
    }),
    install: async () => {
      throw new Error('install must not be reached in conformance (gated at pending)');
    },
    update: async () => {
      throw new Error('update must not be reached in conformance');
    },
  },
  sourceManager: { list: async () => [] },
  fetcher: {},
  cache: {},
  uninstallFlow: {
    uninstall: async () => {
      // Records the side effect the tier gate must prevent, THEN refuses — so a
      // probe can tell "the gate held" from "the gate let it through".
      uninstallReached = true;
      throw new Error('uninstall must not be reached in conformance (gated at pending)');
    },
  },
  confirmationProvider: {
    requestInstallConfirmation: async () => ({ status: 'pending' as const, token: 'conformance' }),
    resolveToken: async () => ({ status: 'pending' as const, token: 'conformance' }),
  },
  logger: noopLogger,
} as unknown as MarketplaceMcpDeps;

// Fake connector bundle: a real registry + binder over an in-memory db with a
// fake provider, so the connector capabilities' invoke assertions run the real
// service code with no network.
const { ConnectorRegistry } = await import('../../../connectors/registry.js');
const { ConnectorFlowBindings } = await import('../../../connectors/flow-bindings.js');
const { SessionConnectorService } = await import('../../../connectors/session-exposure.js');
const { AgentConnectorAttachmentStore, SessionConnectorAttachmentStore } =
  await import('../../../connectors/attachment-store.js');
const { FakeConnectorProvider } = await import('@dorkos/test-utils');
const { runMigrations } = await import('@dorkos/db');

const connectorDb = createTestDb();
runMigrations(connectorDb);
const conformanceConnectorRegistry = new ConnectorRegistry({ db: connectorDb });
conformanceConnectorRegistry.register(
  new FakeConnectorProvider({ type: 'composio', custody: 'managed' })
);
const connectorDeps = {
  registry: conformanceConnectorRegistry,
  sessionConnectors: new SessionConnectorService({
    registry: conformanceConnectorRegistry,
    agentAttachments: new AgentConnectorAttachmentStore(connectorDb),
    sessionAttachments: new SessionConnectorAttachmentStore(connectorDb),
  }),
  flowBindings: new ConnectorFlowBindings(),
};

// The MCP-server-management domain. The locator returns undefined (no agent), so
// the observe/act verbs answer with a structured AGENT_NOT_FOUND rather than
// touching disk; the destructive verbs are refused by the gate before the handler.
const mcpDeps = {
  service: new AgentMcpServerService({ agents: { get: () => undefined } }),
  agents: new AgentRegistry(createTestDb()),
};

// The rooms domain, over the same harness every rooms test uses: a real
// `RoomService` on a throwaway database, with one channel the conformance caller
// is a member of. It is here because `dorkos-registry.ts` gates the domain on
// `roomDeps`, so a fixture without it left the rooms verbs OUTSIDE the shared
// drift gate entirely — their surfaces, tiers and carve-out state were checked by
// nothing. That is a prerequisite for the tool-group check below, not an extra:
// the check derives its subjects from the registry, and a domain the registry
// does not carry has no subjects to derive.
const { createRoomHarness, agentLookupFor, scriptedRunner } =
  await import('../../../rooms/__tests__/room-test-harness.js');

const roomHarness = createRoomHarness({
  agents: agentLookupFor({
    '/agents/conformance': {
      name: 'conformance',
      displayName: 'Conformance',
      responseMode: 'always',
    },
  }),
  runner: scriptedRunner(() => null),
});

/** A channel the conformance caller (the operator, login off) belongs to. */
const CONFORMANCE_ROOM = roomHarness.service.createRoom(
  { kind: 'channel', title: 'Conformance', members: [], agentPaths: [] },
  roomHarness.human
);
const CONFORMANCE_ROOM_ID = CONFORMANCE_ROOM.id;

/**
 * The channel's own `#name`, read off the room rather than assumed from its
 * title — `find_room`'s fixture has to name a room that really exists, and a
 * slug this file spelled by hand would keep passing after `slugify` changed its
 * mind. Loud rather than defaulted: a channel with no slug means the fixture
 * stopped being what this suite thinks it is.
 */
const CONFORMANCE_ROOM_SLUG = CONFORMANCE_ROOM.slug;
if (!CONFORMANCE_ROOM_SLUG) {
  throw new Error('conformance fixture: the channel came back with no slug to search by');
}

const registry = composeDorkOsCapabilityRegistry({
  logger: noopLogger,
  operatorDeps,
  marketplaceDeps,
  connectorDeps,
  mcpDeps,
  roomDeps: { rooms: roomHarness.service },
});

/** Tool names the real in-session adapter registers for the capability surface. */
const inSessionToolNames = capabilityMcpTools(registry, 'in-session').map(
  (t) => (t as { name: string }).name
);

/** Tool names the real external adapter registers onto a live `McpServer`. */
const externalServer = new McpServer({ name: 'conformance', version: '0.0.0' });
registerCapabilitiesAsMcpTools(externalServer, registry, 'external');
const externalToolNames = Object.keys(
  (externalServer as unknown as { _registeredTools: Record<string, unknown> })._registeredTools
);

// The top-level CLI verbs `dorkos` recognizes (packages/cli/src/cli.ts operator
// interception). No capability declares a `cli` surface yet, so this coverage
// check is future-proofing; keep it in lock-step with cli.ts if that changes.
const CLI_VERBS = ['agent', 'task', 'activity', 'capabilities', 'call', 'version'];

// ── Destructive-gate probes: the three real adapter paths ──────────────────
const { createCapabilitiesInvokeRouter } =
  await import('../../../../routes/capabilities-invoke.js');
const { createApprovalsRouter } = await import('../../../../routes/approvals.js');
const { initCapabilityTierGate, APPROVAL_TOKEN_HEADER } = await import('../tier-enforcement.js');
const { ApprovalGrantService, ApprovalService } = await import('../../approvals/index.js');

/** The agent every probe calls as: unrestricted ceiling, so only the tier gates it. */
const PROBE_IDENTITY = {
  agentPath: path.join(SANDBOX_CWD, 'agents', 'prober'),
  displayName: 'Prober',
  tierCeiling: 'destructive' as const,
  createdAt: new Date().toISOString(),
};

/** The one genuinely destructive capability in the composed registry. */
const DESTRUCTIVE_ID = 'marketplace.uninstall';

/** Its MCP tool name, read off the registry rather than restated. */
const DESTRUCTIVE_TOOL = registry.get(DESTRUCTIVE_ID)!.surfaces.mcp!.toolName;

/** The input every probe attempts, and that the approval would be bound to. */
const DESTRUCTIVE_INPUT = { name: 'nonexistent-conformance-pkg', purge: true };

// Arm the gate over a real approval service on a throwaway database, exactly as
// boot does — so the probes exercise the real request/consume path, not a stub.
const approvalDb = createTestDb();
const approvalService = new ApprovalService(approvalDb);
const approvalGrantService = new ApprovalGrantService(approvalDb);
initCapabilityTierGate({ approvals: approvalService });

/** Read a plain payload back out of an MCP text-content result. */
function unwrapText(result: { content: { type: string; text?: string }[] }): unknown {
  return JSON.parse(result.content[0].text ?? 'null');
}

/** What one adapter path did when handed a destructive capability with no approval. */
interface AdapterProbeResult {
  /** Whether the capability's handler actually RAN. Must be false. */
  sideEffectHappened: boolean;
  /** What the adapter handed back, unwrapped to plain JSON. */
  payload: unknown;
}

/** Run one probe with a fresh side-effect flag. */
async function probe(run: () => Promise<unknown>): Promise<AdapterProbeResult> {
  uninstallReached = false;
  const payload = await run();
  return { sideEffectHappened: uninstallReached, payload };
}

/**
 * The invoke route with an identity on `res.locals` exactly where the real
 * `resolveAgentIdentity` middleware puts it — or with none at all, which is what
 * `env -u DORKOS_AGENT_TOKEN dorkos call …` and a bare curl look like from here.
 */
function routeProbe(identity?: typeof PROBE_IDENTITY) {
  return () =>
    probe(async () => {
      const app = express();
      app.use(express.json());
      app.use((_req, res, next) => {
        if (identity) res.locals.agentIdentity = identity;
        next();
      });
      app.use('/api/capabilities', createCapabilitiesInvokeRouter(registry));
      const res = await request(app)
        .post(`/api/capabilities/${DESTRUCTIVE_ID}/invoke`)
        .send(DESTRUCTIVE_INPUT);
      expect(res.status).toBe(202);
      return res.body;
    });
}

/** The in-session `dorkos` server's real tool definition, identified or not. */
function inSessionProbe(identity?: typeof PROBE_IDENTITY) {
  return () =>
    probe(async () => {
      const tools = capabilityMcpTools(
        registry,
        'in-session',
        identity ? async () => ({ identity }) : undefined
      );
      const tool = tools.find((t) => (t as { name: string }).name === DESTRUCTIVE_TOOL)!;
      const handler = (
        tool as unknown as {
          handler: (
            args: unknown,
            extra: unknown
          ) => Promise<{ content: { type: string; text?: string }[] }>;
        }
      ).handler;
      return unwrapText(await handler(DESTRUCTIVE_INPUT, {}));
    });
}

/** The external `/mcp` server's real registered tool callback, identified or not. */
function externalProbe(identity?: typeof PROBE_IDENTITY) {
  return () =>
    probe(async () => {
      const server = new McpServer({ name: 'gate-probe', version: '0.0.0' });
      registerCapabilitiesAsMcpTools(
        server,
        registry,
        'external',
        identity ? { identity } : undefined
      );
      const registered = (
        server as unknown as {
          _registeredTools: Record<
            string,
            {
              handler: (
                args: unknown,
                extra: unknown
              ) => Promise<{ content: { type: string; text?: string }[] }>;
            }
          >;
        }
      )._registeredTools[DESTRUCTIVE_TOOL];
      return unwrapText(await registered.handler(DESTRUCTIVE_INPUT, {}));
    });
}

/**
 * Ask for an approval through the REAL invoke route as an anonymous caller, then
 * try to GRANT it through the REAL approvals router as that same caller — carrying
 * exactly what the 202 handed it and nothing a person in the cockpit would carry.
 *
 * Login is off here (`isLoginEnabled: () => false`), which is the DEFAULT posture
 * and therefore the one worth pinning: the refusal must not depend on accounts
 * being switched on.
 */
const requesterDecideProbe = async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/capabilities', createCapabilitiesInvokeRouter(registry));
  app.use(
    '/api/approvals',
    createApprovalsRouter(approvalService, approvalGrantService, { isLoginEnabled: () => false })
  );

  const asked = await request(app)
    .post(`/api/capabilities/${DESTRUCTIVE_ID}/invoke`)
    .send(DESTRUCTIVE_INPUT);
  expect(asked.status).toBe(202);
  const { approvalId, approvalToken } = asked.body as {
    approvalId: string;
    approvalToken: string;
  };

  const decided = await request(app)
    .post(`/api/approvals/${approvalId}/grant`)
    .set(APPROVAL_TOKEN_HEADER, approvalToken)
    .send();

  // Read the outcome from the service rather than trusting the status code: the
  // approval must still be spendable-only-after-a-human, i.e. still pending.
  const stillPending = approvalService
    .listPending()
    .some((pending) => pending.approvalId === approvalId);

  return { status: decided.status, approvalDecided: !stillPending };
};

capabilityConformance(registry, {
  name: 'DorkOS capability registry — conformance (real registry)',
  requesterDecideProbe,
  registeredMcpToolNames: {
    'in-session': inSessionToolNames,
    external: externalToolNames,
  },
  cliVerbs: CLI_VERBS,
  readOnlyToolNames: READ_ONLY_MCP_TOOL_NAMES,
  docsRegistry: composeCapabilityRegistryForDocs(),
  sampleInputs: {
    'operator.update_agent': { cwd: SANDBOX_CWD, displayName: 'Conformance' },
    'operator.config_patch': { patch: { ui: { sidebar: { collapsed: true } } } },
    'marketplace.get': { name: 'nonexistent-conformance-pkg' },
    'marketplace.recommend': { context: 'observability for a next.js app' },
    'marketplace.install': { name: 'nonexistent-conformance-pkg' },
    'marketplace.uninstall': { name: 'nonexistent-conformance-pkg' },
    'marketplace.create_package': {
      name: 'conformance-pkg',
      type: 'plugin',
      description: 'A conformance fixture package.',
    },
    'connector.recommend': { service: 'gmail' },
    'connector.start_connect': { service: 'gmail', label: 'conformance' },
    // An unknown flow: the handler answers with its structured CapabilityToolError.
    'connector.poll_connect': { flowId: 'conformance-flow' },
    // Destructive: refused by the gate before the handler runs (asserted above).
    'connector.attach_account': { accountId: 'conformance-account', sessionId: 'conformance' },
    'connector.detach_account': { accountId: 'conformance-account', sessionId: 'conformance' },
    // Every mcp verb needs a PARSEABLE fixture: the destructive writes so the gate
    // (not a ZodError) refuses them, and the observe/act verbs so they reach the
    // handler and answer with a structured AGENT_NOT_FOUND (the locator has no
    // agent). All are keyed by agent id (spec §5).
    // No identity in a conformance invocation, so the handler answers its own
    // `no-agent` refusal — wired and reachable, which is what this suite asks.
    'memory.write': { action: 'add', text: 'a conformance note' },
    'mcp.list': { agentId: 'conformance-agent' },
    'mcp.add': {
      agentId: 'conformance-agent',
      name: 'conformance-srv',
      connection: { transport: 'stdio', command: 'node', args: [], env: {} },
    },
    'mcp.import': { agentId: 'conformance-agent', name: 'conformance-srv' },
    'mcp.update': { agentId: 'conformance-agent', name: 'conformance-srv', enabled: false },
    'mcp.remove': { agentId: 'conformance-agent', name: 'conformance-srv' },
    'mcp.enable': { agentId: 'conformance-agent', name: 'conformance-srv' },
    'mcp.disable': { agentId: 'conformance-agent', name: 'conformance-srv' },
    'mcp.test': { agentId: 'conformance-agent', name: 'conformance-srv' },
    // Sign-in verbs (DOR-942): act-tier, so they reach the handler and answer with
    // a structured error — the mcpDeps here carry no OAuth engine, so signin fails
    // as SIGNIN_UNAVAILABLE after the agent lookup, and poll as the same.
    'mcp.signin': { agentId: 'conformance-agent', name: 'conformance-srv' },
    'mcp.poll_signin': { flowId: 'conformance-flow' },
    'mcp.set_client': {
      agentId: 'conformance-agent',
      name: 'conformance-srv',
      clientId: 'conformance-client',
    },
    // The rooms verbs, against the harness room above. No identity travels in a
    // conformance invocation and login is off, so `callerAuthor` resolves the
    // operator — who is a member of that room — and each verb reaches its handler
    // and really runs. A verb that stopped being wired would raise an
    // unstructured throw here rather than a `RoomError`, which is the failure
    // this suite is asking about.
    'rooms.post': { roomId: CONFORMANCE_ROOM_ID, text: 'a conformance message' },
    'rooms.react': { roomId: CONFORMANCE_ROOM_ID, entryId: 'conformance-entry', emoji: '👍' },
    'rooms.read_history': { roomId: CONFORMANCE_ROOM_ID, limit: 5 },
    'rooms.search_history': { roomId: CONFORMANCE_ROOM_ID, query: 'conformance' },
    'rooms.list_member_rooms': {},
    'rooms.search_member_rooms': { query: 'conformance' },
    'rooms.get_room': { roomId: CONFORMANCE_ROOM_ID },
    // A REAL filter, deliberately. `find_room` would have passed this suite with
    // `{}` too — but only by accident: its no-filter guard answers a typed
    // MISSING_FILTER, which reads as "structured refusal, therefore wired" while
    // never reaching the service at all. Naming the room's own `#slug` makes the
    // invocation do the thing the suite is asking about, and exercises the sigil
    // that `normalizeRoomNameNeedle` strips on the way in.
    'rooms.find_room': { name: `#${CONFORMANCE_ROOM_SLUG}` },
  },
});

// A tiny sanity assertion so this file also documents the shape of the fixtures
// it feeds the shared suite (and fails loudly if a domain stops registering).
describe('capability conformance wiring', () => {
  it('composes a non-empty registry across all five domains', () => {
    const ids = registry.capabilities.map((c) => c.id);
    expect(ids).toContain('operator.config_get');
    expect(ids).toContain('marketplace.search');
    expect(ids).toContain('connector.list_toolkits');
    expect(ids).toContain('capabilities.list');
    // Rooms is the newest arrival (DOR-1611) and the one most at risk of
    // dropping back out: it is gated on `roomDeps`, so forgetting the handle in
    // this fixture would silently take eight verbs out of every check above
    // without failing a single one of them.
    expect(ids).toContain('rooms.post');
  });

  it('keeps runtime, model and effort out of what an agent may edit on ITS OWN manifest', () => {
    // Not a spend guard, and saying so would be false: the machine-wide
    // defaults (`runtimes.*.defaultModel` / `.defaultEffort`) are deliberately
    // `agent-writable` through `config_patch`, on the operator's own call —
    // "set yourself to the cheapest model for this batch" is a reasonable thing
    // to ask an agent to do (see `config-write-policy.ts`).
    //
    // The asymmetry is about durability and visibility, not cost. A config
    // write is one value, in one file the Settings screen shows, that a person
    // can see and reverse in one place. A manifest write is per agent, scattered
    // across as many `agent.json` files as there are agents, and it silently
    // outranks the server default from then on — so an agent quietly pinning
    // itself would be invisible exactly where somebody would look to explain the
    // behavior. `update_agent` is the AGENT-facing surface; the operator's HTTP
    // PATCH carries all three, because a person is driving it.
    //
    // A caller that sends one anyway has it dropped, not rejected: the schema
    // strips unknown keys, so an over-eager agent gets its personality edit
    // applied and its execution edit ignored.
    const updateAgent = registry.capabilities.find((c) => c.id === 'operator.update_agent');
    const shape = (updateAgent!.input as z.ZodObject<z.ZodRawShape>).shape;
    expect(Object.keys(shape)).not.toContain('runtime');
    expect(Object.keys(shape)).not.toContain('model');
    expect(Object.keys(shape)).not.toContain('effort');

    const parsed = updateAgent!.input.parse({
      cwd: SANDBOX_CWD,
      displayName: 'Still fine',
      model: 'opus',
      effort: 'xhigh',
      runtime: 'codex',
    });
    expect(parsed).toEqual({ cwd: SANDBOX_CWD, displayName: 'Still fine' });
  });
});

/**
 * The posture guard on `operator.config_patch` (DOR-488), asserted through the
 * REAL composed registry rather than through its handler.
 *
 * The guard's own unit tests all call `createConfigPatchHandler()` directly, so
 * they would stay green if `operator-capabilities.ts` were ever rewired to call
 * `applyConfigPatch` itself and skip the handler. This is the assertion that
 * notices. It runs the same path an agent runs, and the file's existing mock of
 * `applyConfigPatch` (which happily "writes" anything it is given) means a bypass
 * surfaces here as a SUCCESS where a refusal belongs.
 */
describe('operator.config_patch refuses posture changes through the registry', () => {
  it('refuses to turn login off', async () => {
    await expect(
      registry.invoke('operator.config_patch', { patch: { auth: { enabled: false } } })
    ).rejects.toMatchObject({
      name: 'CapabilityToolError',
      payload: { code: 'operator_only_config', paths: ['auth.enabled'] },
    });
  });

  it('lets an ordinary preference past the guard', async () => {
    // This file's `applyConfigPatch` mock returns a bare object rather than a
    // `ConfigPatchResult`, so the call cannot reach a `success` payload here no
    // matter what. What IS provable at this seam is the part that matters: an
    // ordinary preference is not stopped by the POSTURE guard. That the write
    // then lands is proven against a real store in the handler's own tests.
    await registry.invoke('operator.config_patch', { patch: { ui: { theme: 'dark' } } }).then(
      () => undefined,
      (err: { payload?: { code?: string } }) => {
        expect(err.payload?.code).not.toBe('operator_only_config');
      }
    );
  });
});

/**
 * Regression coverage for each real adapter, kept as ordinary tests rather than as
 * a conformance CONTRACT (DOR-467).
 *
 * The conformance suite used to demand one probe per hand-listed adapter path, and
 * that list is what failed: it could only go red for a path already on it, so the
 * legacy marketplace routes — never listed — shipped ungated and nothing noticed.
 * The contract is now derived from the registry (`registry.invoke` must refuse
 * every destructive capability), which covers these three and any future adapter
 * without anyone maintaining a list.
 *
 * These stay because they prove something the registry-level check cannot: that
 * each adapter TRANSLATES a refusal correctly — a `202` on the route, an ordinary
 * non-error result on both MCP servers — and that no handler ran.
 */
describe('every adapter path refuses an unapproved destructive call', () => {
  const paths = {
    'invoke-route': routeProbe,
    'in-session-mcp': inSessionProbe,
    'external-mcp': externalProbe,
  };

  for (const [name, make] of Object.entries(paths)) {
    // Identified, and then with NO identity at all — which is the shape of the
    // bypass an agent with shell access reaches for: drop the token, keep the
    // effect. The gate keys on the capability's TIER, so both must refuse.
    for (const [who, identity] of [
      ['identified', PROBE_IDENTITY],
      ['anonymous', undefined],
    ] as const) {
      it(`${name} (${who}): approval_required, nothing removed`, async () => {
        const result = await make(identity)();
        expect(result.sideEffectHappened).toBe(false);
        expect((result.payload as { status?: string }).status).toBe('approval_required');
        expect((result.payload as { approvalToken?: string }).approvalToken).toBeTruthy();
      });
    }
  }
});
