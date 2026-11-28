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
 * adapters (`registerClaudeCapabilityTools` for in-session; `registerCapabilitiesAsMcpTools`
 * onto a real `McpServer` for external), so a bug in either adapter is caught.
 *
 * @vitest-environment node
 */
import { conformanceSampleInputs } from './capability-conformance-samples.js';
import { DevLinkError } from '../../../marketplace/dev-links/errors.js';
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import os from 'node:os';
import path from 'node:path';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { noopLogger } from '@dorkos/shared/logger';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { capabilityConformance } from '@dorkos/test-utils';

import { createTestDb } from '@dorkos/test-utils/db';
import { ROOM_REPO_CAP_DEFAULTS } from '@dorkos/shared/room-repo';
import {
  RoomMergeService,
  RoomRepoMutex,
  RoomRepoService,
  RoomRepoStore,
} from '../../../rooms/repo/index.js';
import { conformanceMeshDeps } from './capability-conformance-mesh.js';
import { conformancePersonDoorDeps } from './capability-conformance-person-doors.js';

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
vi.mock('../../../../lib/boundary.js', () => {
  class BoundaryError extends Error {
    constructor(
      message: string,
      readonly code: string
    ) {
      super(message);
    }
  }
  return {
    validateBoundaryOrDorkHome: (p: string) => p,
    // The diff review's paths land outside, so each answers its own refusal.
    validateBoundary: async () => {
      throw new BoundaryError('outside', 'OUTSIDE_BOUNDARY');
    },
    getBoundary: () => '/conformance-boundary',
    resolveAgentsRoot: async () => '/conformance-agents',
    BoundaryError,
  };
});
// update_agent reads the target agent's manifest off disk; stub it to "no agent
// here" so the handler returns its structured NOT_FOUND (a CapabilityToolError),
// never a raw filesystem throw.
// The rest of the module stays real: the permission gate reads an agent's own
// settings file by the manifest path constants.
vi.mock('@dorkos/shared/manifest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@dorkos/shared/manifest')>()),
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
    // `feedback_draft` reads allowlisted on/off settings by DOTTED path, the way
    // the CLI's own gatherer does, so the fake needs the same reader the real
    // manager has (DOR-2056). Answering `undefined` is a real state: every flag
    // is then dropped and the draft reports "(none available)".
    getDot: () => undefined,
    set: () => {},
  },
}));

const { composeDorkOsCapabilityRegistry, composeCapabilityRegistryForDocs } =
  await import('../../self-description/dorkos-registry.js');
const { createCapabilityMcpClient } =
  await import('../../../runtimes/claude-code/mcp-tools/__tests__/capability-mcp-client.js');
const { registerCapabilitiesAsMcpTools } =
  await import('../../external-mcp/capability-mcp-tools.js');
const { READ_ONLY_MCP_TOOL_NAMES } = await import('../../external-mcp/tool-security.js');
const { createDorkLinkLookups } = await import('../../links/link-lookups.js');
const { callerAuthor } = await import('../../../rooms/service/room-caller-author.js');
import type { CapabilityDeps } from '../capability-definition.js';
import type { AgentToolDeps } from '../../agent-tool-kit/agent-tool-kit.js';
import type { MarketplaceMcpDeps } from '../../../marketplace-mcp/marketplace-mcp-tools.js';
import { AgentRegistry } from '@dorkos/mesh';
import { AgentMcpServerService } from '../../../mesh/agent-mcp-server-service.js';
import { DocRouteGrantError } from '../../../canvas/doc-channel/grant-policy.js';
import { DocDownstreamError } from '../../../canvas/doc-channel/downstream/service.js';

/** A tmp path that need not exist — the fakes never touch real disk. */
const SANDBOX_CWD = path.join(os.tmpdir(), 'capability-conformance-sandbox');

/** Fake operator service handles — only the methods the invoked handlers call. */
const operatorDeps = {
  defaultCwd: SANDBOX_CWD,
  transcriptReader: {},
  activityService: { list: async () => ({ items: [], nextCursor: null }) },
  runtimeRegistry: { listRuntimes: () => [] },
  meshCore: { listWithPaths: () => [] },
} as unknown as AgentToolDeps;

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
  mcpServers: [],
  lspServers: [],
  monitors: [],
  executables: [],
  skillTools: [],
  skillCommands: [],
  skippedLinks: [],
  unreadableDeclarations: [],
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
  // `marketplace.link` describes its card before the gate (the description is
  // bound into the approval), so the stub answers that; a call past the gate
  // meets a structured refusal and never touches the disk.
  devLinks: {
    describeApproval: async () => 'Folder: /nonexistent-conformance-folder',
    link: async () => {
      throw new DevLinkError('dev_link_not_a_package', 400, 'No package found in this folder.');
    },
  },
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
  // The sandbox has nothing installed, so an advisory `marketplace.update`
  // checks nothing; an apply would find nothing to reinstall either.
  updateFlow: {
    planInstallations: async () => ({ checks: [], steps: [] }),
  },
  confirmationProvider: {
    requestInstallConfirmation: async () => ({ status: 'pending' as const, token: 'conformance' }),
    resolveToken: async () => ({ status: 'pending' as const, token: 'conformance' }),
  },
  logger: noopLogger,
} as unknown as MarketplaceMcpDeps;

// Fake connector discovery bundle: a real registry over an in-memory database,
// so the two nonprivate discovery handlers run real aggregation without a network.
const { ConnectorRegistry } = await import('../../../connectors/registry.js');
const { FakeConnectorProvider } = await import('@dorkos/test-utils');
const { runMigrations } = await import('@dorkos/db');

const connectorDb = createTestDb();
runMigrations(connectorDb);
const conformanceConnectorRegistry = new ConnectorRegistry({ db: connectorDb });
const conformanceConnectorProvider = new FakeConnectorProvider({
  type: 'composio',
  custody: 'managed',
});
conformanceConnectorRegistry.register(conformanceConnectorProvider);
const connectorDeps = {
  registry: conformanceConnectorRegistry,
  catalog: async () => ({ services: [], warnings: [] }),
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

/**
 * The two repo verbs' service, wired for real over the same harness database
 * (spec `project-rooms` §3.6).
 *
 * Real rather than stubbed, and ENABLED rather than switched off, because both
 * shortcuts would hide the thing this suite asks about. `requireMergeDeps`
 * raises a plain `Error` when the bag has no merge service — an UNSTRUCTURED
 * throw, which the invoke check reads as "not wired", exactly as it should — so
 * omitting this handle does not skip the two verbs, it fails them. And a
 * `enabled: () => false` stub would refuse at the first line of
 * `requireProjectRoom`, never reaching the membership check or the store.
 *
 * Enabled, the conformance channel is simply a room with no files: the caller's
 * membership resolves, the store reports no sidecar row, and both verbs answer
 * the structured `NOT_A_PROJECT_ROOM` this suite accepts. Nothing here touches
 * git — there is no repo to touch.
 */
const roomMerges = new RoomMergeService({
  store: new RoomRepoStore(roomHarness.db, SANDBOX_CWD),
  mutex: new RoomRepoMutex(),
  enabled: () => true,
  mergeQueueWaitMs: () => 5000,
  requireMembership: (roomId, authorId) => roomHarness.service.requireMembership(roomId, authorId),
  listAgentMembers: (roomId) => roomHarness.service.listAgentMembers(roomId),
  listStrandedWorktrees: () => Promise.resolve([]),
  announce: (roomId, input) => roomHarness.service.postMergeEvent(roomId, input),
  isOwnerAuthor: (authorId) => authorId === roomHarness.human,
});

const registry = composeDorkOsCapabilityRegistry({
  logger: noopLogger,
  // A data directory with no user templates, so the list is the built-in ones.
  templateDeps: { dorkHome: '/conformance-no-such-dork-home' },
  // The to-do and promise reads and a person's "add a promise" serve REST paths
  // (DOR-4978), so the boot registry carries them for the docs/boot parity check.
  // Empty lists, no agents and nobody the owner: every call answers on its own.
  todoViewDeps: {
    todos: { list: () => ({ todos: [], doneCount: 0, badge: 0 }), get: () => undefined },
  },
  todoPromiseHttpDeps: {
    service: {
      list: () => [],
      create: () => {
        throw new Error('no promise is made in conformance');
      },
    },
    agentExists: () => false,
    isOwner: () => false,
    personProven: () => false,
    ownerExists: () => true,
  },
  // A person's to-do writes and promise changes (DOR-4978): person-only, so an anonymous
  // conformance call is refused `PERSON_ONLY` before any of these is reached.
  todoWriteDeps: {
    todos: {
      create: () => {
        throw new Error('no to-do is made in conformance');
      },
      update: () => {
        throw new Error('no to-do is changed in conformance');
      },
    },
    ownerExists: () => true,
    readSource: () => undefined,
  },
  todoPromiseWriteDeps: {
    service: {
      update: () => {
        throw new Error('no promise is changed in conformance');
      },
    },
    confirm: {
      answer: () => {
        throw new Error('no promise is confirmed in conformance');
      },
    },
    isOwner: () => false,
    personProven: () => false,
    ownerExists: () => true,
  },
  operatorDeps,
  marketplaceDeps,
  connectorDeps,
  mcpDeps,
  roomDeps: {
    rooms: roomHarness.service,
    merges: roomMerges,
    // Switched off, so the verb reaches the real service and answers the
    // structured `ROOM_REPOS_DISABLED` without making a repo on disk.
    repos: new RoomRepoService({
      store: new RoomRepoStore(roomHarness.db, SANDBOX_CWD),
      mutex: new RoomRepoMutex(),
      queueWaitMs: () => 5000,
      enabled: () => false,
      getRoom: (roomId, viewerAuthorId) => roomHarness.service.getRoom(roomId, viewerAuthorId),
      isOwnerAuthor: (authorId) => authorId === roomHarness.human,
      getAuthor: () => null,
      operatorGitName: () => null,
      pinRoomMd: () => {},
      caps: () => ({ ...ROOM_REPO_CAP_DEFAULTS }),
      maxRoomMdBytes: () => ROOM_REPO_CAP_DEFAULTS.maxRoomMdBytes,
    }),
  },
  // The audit domain serves `GET /api/audit/verify`, so the boot registry must
  // carry it for the docs/boot parity check (spec `audit-trail`).
  auditDeps: {
    log: {
      verify: () => ({ ok: true, checked: 0, lastSeq: 0, lastHash: '0'.repeat(64) }),
      query: () => ({ events: [], more: false }),
      getWithLinks: () => undefined,
      timeline: () => ({ events: [], more: false }),
    },
  },
  // The pause domain serves `/api/agents/{agentId}/pause|resume` and
  // `/api/agents/pauses` (spec `audit-trail` PR5), so the boot registry carries it.
  agentPauseDeps: {
    pauses: {
      pause: async () => ({ agentId: 'a', paused: true, changed: true }),
      resume: () => ({ agentId: 'a', paused: false, changed: true }),
      list: () => [],
    },
  },
  // The person's work queue domain serves its doors (`/api/agents/{agentId}/work-queue/*`,
  // `/api/work-queues/stop`, DOR-4978); no agent is on this team.
  // The agents' own work queue tools (`work-queue.*`, DOR-3462), checked
  // beside the person's doors. The prober is the one agent on this team, with
  // an empty queue and one ended item, so its destructive calls reach the gate
  // (and an anonymous call meets the tool's own NO_AGENT first).
  workQueueDeps: {
    service: {
      read: () => ({ enabled: false, target: 1, dailyStartCap: 1, items: [] }),
      item: () => ({ agentId: 'prober', title: 'Probe', prompt: 'A probe.', state: 'done' }),
    } as unknown as NonNullable<CapabilityDeps['workQueueDeps']>['service'],
    agentIdForPath: () => 'prober',
    agentName: (id: string) => (id === 'prober' ? 'Prober' : undefined),
  },
  workQueuePersonDeps: {
    service: {} as NonNullable<CapabilityDeps['workQueuePersonDeps']>['service'],
    agentExists: () => false,
    isOwner: () => true,
  },
  // The agent registry's doors on `/api/mesh/*` (DOR-4978), over an empty registry.
  meshDeps: conformanceMeshDeps,
  // A person's doors on the MCP servers every agent gets and on chat from the web (DOR-4978).
  ...conformancePersonDoorDeps,
  // The link domain serves `GET /api/links/target` (DOR-5046), over the
  // harness's real rooms; it holds no chats and no agents.
  linkDeps: {
    lookups: createDorkLinkLookups({
      db: roomHarness.db,
      rooms: roomHarness.service,
      roomCaller: (context) => callerAuthor(roomHarness.service, context),
      chatExists: async () => false,
    }),
  },
});

/** Tool names the real in-session adapter registers for the capability surface. */
const inSessionToolNames = (await createCapabilityMcpClient(registry, 'in-session')).tools.map(
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
const { createCapabilitiesInvokeRoutes } =
  await import('../../../../routes/capabilities-invoke.js');
const { honoGroupListener } = await import('../../../../http/__tests__/hono-group-listener.js');
const { createApprovalsRoutes } = await import('../../../../routes/approvals.js');
const { initCapabilityTierGate, APPROVAL_TOKEN_HEADER } = await import('../tier-enforcement.js');
const { askFor } = await import('./permission-gate-fixtures.js');
const { ApprovalService } = await import('../../approvals/index.js');

/** The agent every probe calls as: unrestricted ceiling, so only the tier gates it. */
const PROBE_IDENTITY = {
  agentPath: path.join(SANDBOX_CWD, 'agents', 'prober'),
  displayName: 'Prober',
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
const requestTarget = swappableServer();
initCapabilityTierGate({ approvals: approvalService });
// Under Trusted (ADR 261006-225605) the two destructive capabilities whose area
// is Allowed and that run no third-party code (`marketplace.uninstall`,
// `mcp.import`) run, recorded, with no card. These probes are about the card
// reaching every adapter path, so a person has set those two to Ask; every
// other capability resolves exactly as Trusted has it.
// `trusted-destructive.test.ts` pins which destructive capabilities ask under
// Trusted with nothing set.
askFor(DESTRUCTIVE_ID, 'mcp.import');

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
 * The invoke route with an identity set exactly where the `/api` chain's
 * identity step puts it — or with none at all, which is what
 * `env -u DORKOS_AGENT_TOKEN dorkos call …` and a bare curl look like from here.
 */
function routeProbe(identity?: typeof PROBE_IDENTITY) {
  return () =>
    probe(async () => {
      requestTarget.mount(
        honoGroupListener(
          { path: '/api/capabilities', routes: createCapabilitiesInvokeRoutes(registry) },
          {
            before: async (c, next) => {
              if (identity) c.set('agentIdentity', identity);
              await next();
            },
          }
        )
      );
      const res = await request(requestTarget.server)
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
      const { tools } = await createCapabilityMcpClient(
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
  requestTarget.mount(
    honoGroupListener([
      { path: '/api/capabilities', routes: createCapabilitiesInvokeRoutes(registry) },
      {
        path: '/api/approvals',
        routes: createApprovalsRoutes(approvalService, { isLoginEnabled: () => false }),
      },
    ])
  );

  const asked = await request(requestTarget.server)
    .post(`/api/capabilities/${DESTRUCTIVE_ID}/invoke`)
    .send(DESTRUCTIVE_INPUT);
  expect(asked.status).toBe(202);
  const { approvalId, approvalToken } = asked.body as {
    approvalId: string;
    approvalToken: string;
  };

  const decided = await request(requestTarget.server)
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
  expectedInvokeRefusal: {
    'ui.configure_doc_channel': (error) =>
      error instanceof DocRouteGrantError &&
      error.code === 'INVALID_PRINCIPAL' &&
      error.status === 403,
    'ui.approve_doc_route': (error) =>
      error instanceof DocRouteGrantError &&
      error.code === 'INVALID_PRINCIPAL' &&
      error.status === 403,
    'ui.revoke_doc_route': (error) =>
      error instanceof DocRouteGrantError &&
      error.code === 'INVALID_PRINCIPAL' &&
      error.status === 403,
    'ui.send_canvas_event': (error) =>
      error instanceof DocDownstreamError &&
      error.code === 'DOC_CHANNEL_UNAVAILABLE' &&
      error.status === 503,
    'ui.patch_canvas_state': (error) =>
      error instanceof DocDownstreamError &&
      error.code === 'DOC_CHANNEL_UNAVAILABLE' &&
      error.status === 503,
    // No workspace subsystem starts in this suite; the real server sets it up at boot.
    'workspaces.list': (error) => error.message === 'WorkspaceManager not initialized',
    'workspaces.scan': (error) => error.message === 'Workspace root not initialized',
  },
  // The agents' destructive queue tools refuse an unidentified caller before
  // the gate (NO_AGENT, no card), so the gate probe calls them as an agent.
  sampleContexts: {
    'work-queue.add': { identity: PROBE_IDENTITY },
    'work-queue.configure': { identity: PROBE_IDENTITY },
    'work-queue.requeue': { identity: PROBE_IDENTITY },
  },
  sampleInputs: conformanceSampleInputs({
    sandboxCwd: SANDBOX_CWD,
    roomId: CONFORMANCE_ROOM_ID,
    roomSlug: CONFORMANCE_ROOM_SLUG,
  }),
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

  it('keeps runtime, model and effort out of what update_agent may write, and says where they go', () => {
    // An agent's runtime, model and effort move every schedule that follows the
    // agent (DOR-2328), so they live on `operator.update_agent_execution`, which
    // is destructive and asks a person. `update_agent` DECLARES them only so its
    // handler can refuse them with a pointer: undeclared, the schema would strip
    // them and an agent would report a model change that never happened (the
    // DOR-1253 shape). They are `unknown` so the refusal is the answer whatever
    // they hold; the refusal itself is pinned in `agent-execution-gate.test.ts`.
    const updateAgent = registry.capabilities.find((c) => c.id === 'operator.update_agent');
    const shape = (updateAgent!.input as z.ZodObject<z.ZodRawShape>).shape;
    for (const field of ['runtime', 'model', 'effort']) {
      expect(String((shape[field] as z.ZodType).description)).toContain('update_agent_execution');
    }
    const gated = registry.capabilities.find((c) => c.id === 'operator.update_agent_execution');
    expect(gated?.tier).toBe('destructive');
    expect(gated?.describeApprovalChange).toBeTypeOf('function');
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
  it('never turns login off on its own: the gate decides it in Reach & secrets', async () => {
    // Turning login off is a Reach & secrets change (spec `agent-permissions`
    // D6), a floor area that is never Allowed, so the gate stops the call before
    // the handler runs, whatever the preset. The handler's own refusal (for a
    // call that somehow reached it without a person's yes) is pinned in its
    // unit tests.
    await expect(
      registry.invoke('operator.config_patch', { patch: { auth: { enabled: false } } })
    ).rejects.toMatchObject({ name: 'CapabilityGateRefusal' });
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
