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
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { noopLogger } from '@dorkos/shared/logger';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { capabilityConformance } from '@dorkos/test-utils';
import type { DestructiveGateProbeResult } from '@dorkos/test-utils';
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

const { composeDorkOsCapabilityRegistry, composeCapabilityRegistryForDocs } =
  await import('../../self-description/dorkos-registry.js');
const { capabilityMcpTools } =
  await import('../../../runtimes/claude-code/mcp-tools/capability-mcp-tools.js');
const { registerCapabilitiesAsMcpTools } =
  await import('../../external-mcp/capability-mcp-tools.js');
const { READ_ONLY_MCP_TOOL_NAMES } = await import('../../external-mcp/tool-security.js');
import type { McpToolDeps } from '../../../runtimes/claude-code/mcp-tools/types.js';
import type { MarketplaceMcpDeps } from '../../../marketplace-mcp/marketplace-mcp-tools.js';

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
  tasks: [],
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

const registry = composeDorkOsCapabilityRegistry({
  logger: noopLogger,
  operatorDeps,
  marketplaceDeps,
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
const { ApprovalService, hashApprovalInput } = await import('../../approvals/index.js');

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

/** A schema-satisfying sample per destructive capability, for the idempotence check. */
const DESTRUCTIVE_SAMPLE_INPUTS: Record<string, unknown> = {
  [DESTRUCTIVE_ID]: DESTRUCTIVE_INPUT,
};

// Arm the gate over a real approval service on a throwaway database, exactly as
// boot does — so the probes exercise the real request/consume path, not a stub.
const approvalService = new ApprovalService(createTestDb());
initCapabilityTierGate({ approvals: approvalService });

/** Read a plain payload back out of an MCP text-content result. */
function unwrapText(result: { content: { type: string; text?: string }[] }): unknown {
  return JSON.parse(result.content[0].text ?? 'null');
}

/** Run one probe with a fresh side-effect flag. */
async function probe(run: () => Promise<unknown>): Promise<DestructiveGateProbeResult> {
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
    createApprovalsRouter(approvalService, { isLoginEnabled: () => false })
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
  destructiveGateProbes: {
    // Identified agent on each adapter path…
    'invoke-route': routeProbe(PROBE_IDENTITY),
    'in-session-mcp': inSessionProbe(PROBE_IDENTITY),
    'external-mcp': externalProbe(PROBE_IDENTITY),
    // …and the same three with NO identity, which is the shape of the bypass an
    // agent with shell access would reach for: drop the token, keep the effect.
    'invoke-route-anonymous': routeProbe(),
    'in-session-mcp-anonymous': inSessionProbe(),
    'external-mcp-anonymous': externalProbe(),
  },
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
  },
});

// A tiny sanity assertion so this file also documents the shape of the fixtures
// it feeds the shared suite (and fails loudly if a domain stops registering).
describe('capability conformance wiring', () => {
  it('composes a non-empty registry across all three domains', () => {
    const ids = registry.capabilities.map((c) => c.id);
    expect(ids).toContain('operator.config_get');
    expect(ids).toContain('marketplace.search');
    expect(ids).toContain('capabilities.list');
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
 * Both choke points parse the input, gate on the parsed value, and hand that same
 * value to `registry.invoke` — which parses it a second time. That is only safe
 * while a destructive capability's schema is parse-idempotent: if `parse(parse(x))`
 * ever differed from `parse(x)`, the approval would be bound to a hash of
 * something other than what actually executes, and the whole binding guarantee
 * would quietly evaporate.
 *
 * True today (every destructive input is a plain `z.object` of scalars), so this
 * asserts it rather than assuming it: a schema that grows a non-idempotent
 * `.transform()` fails HERE, at the boundary that depends on the property.
 */
describe('destructive capability input schemas are parse-idempotent', () => {
  const destructive = registry.capabilities.filter((cap) => cap.tier === 'destructive');

  it('has at least one destructive capability to check', () => {
    expect(destructive.length).toBeGreaterThan(0);
  });

  for (const cap of destructive) {
    it(`${cap.id}: parsing twice hashes the same as parsing once`, () => {
      const sample = DESTRUCTIVE_SAMPLE_INPUTS[cap.id] ?? {};
      const once = cap.input.parse(sample);
      const twice = cap.input.parse(once);
      expect(hashApprovalInput(twice)).toBe(hashApprovalInput(once));
    });
  }
});
