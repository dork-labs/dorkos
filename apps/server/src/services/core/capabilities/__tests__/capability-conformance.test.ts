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
const { createCapabilitiesInvokeRouter } = await import('../../../../routes/capabilities-invoke.js');
const { initCapabilityTierGate } = await import('../tier-enforcement.js');
const { ApprovalService } = await import('../../approvals/index.js');

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
initCapabilityTierGate({ approvals: new ApprovalService(createTestDb()) });

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

capabilityConformance(registry, {
  name: 'DorkOS capability registry — conformance (real registry)',
  destructiveGateProbes: {
    // POST /api/capabilities/:id/invoke, with an identity on `res.locals` exactly
    // as the real `resolveAgentIdentity` middleware puts it there.
    'invoke-route': () =>
      probe(async () => {
        const app = express();
        app.use(express.json());
        app.use((_req, res, next) => {
          res.locals.agentIdentity = PROBE_IDENTITY;
          next();
        });
        app.use('/api/capabilities', createCapabilitiesInvokeRouter(registry));
        const res = await request(app)
          .post(`/api/capabilities/${DESTRUCTIVE_ID}/invoke`)
          .send(DESTRUCTIVE_INPUT);
        expect(res.status).toBe(202);
        return res.body;
      }),

    // The in-session `dorkos` server's real tool definition, invoked through the
    // handler the Claude Agent SDK would call.
    'in-session-mcp': () =>
      probe(async () => {
        const tools = capabilityMcpTools(registry, 'in-session', async () => ({
          identity: PROBE_IDENTITY,
        }));
        const tool = tools.find((t) => (t as { name: string }).name === DESTRUCTIVE_TOOL)!;
        const handler = (tool as unknown as { handler: (args: unknown, extra: unknown) => Promise<{ content: { type: string; text?: string }[] }> }).handler;
        return unwrapText(await handler(DESTRUCTIVE_INPUT, {}));
      }),

    // The external `/mcp` server's real registered tool callback.
    'external-mcp': () =>
      probe(async () => {
        const server = new McpServer({ name: 'gate-probe', version: '0.0.0' });
        registerCapabilitiesAsMcpTools(server, registry, 'external', {
          identity: PROBE_IDENTITY,
        });
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
      }),
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
