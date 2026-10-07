/**
 * Pins a protection Dorian kept in the trusted-by-default reset (DOR-2735). If
 * this fails after a default flip, the flip leaked power to outsiders — fix the
 * flip, not this test.
 *
 * The protection: the "front door" settings stay the person's. An agent's
 * `config_patch` never writes login, remote access, the `/mcp` endpoint's own
 * gate, credentials and where they are sent, the extension code the server
 * runs and the sources it trusts, the tool endpoints connectors reach, or the
 * disk boundary — not on its own say-so, and not because a permission says
 * Allowed. Only a person's yes on that exact patch writes one.
 *
 * Why this matters more after the reset, not less: an honest agent at full
 * power that reads one hostile web page or email can be talked into
 * `config_patch({ tunnel: { authtoken } })` or turning login off. That turns
 * "a trusted agent" into "anyone on the internet".
 *
 * The reset is expected to make the OTHER operator-only fields (trust stops,
 * permissions, room limits) agent-writable. That is why this is a table of the
 * perimeter paths, one row each: a change that opens the A-class fields by
 * flipping a group, or by loosening `findOperatorOnlyPaths`, cannot quietly
 * take one of these with it. Package sources are the same kind of fact and are
 * pinned on their own route: `routes/__tests__/marketplace.test.ts`, "the
 * operator-only bar on the source routes (DOR-502)".
 *
 * Every case runs at the MOST permissive permission settings that exist: the
 * Full preset, every area set to Allowed as the default, and the calling agent
 * itself Allowed in every area and on `operator.config_patch` by name.
 *
 * Runs the REAL capability definition through a real registry, the real gate,
 * the real resolver and the real guarded writer. Only the final store write is
 * replaced, so nothing touches a real config file.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { PERMISSION_AREA_IDS } from '@dorkos/shared/permissions';

const written: Record<string, unknown>[] = [];

vi.mock('../config-patch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config-patch.js')>()),
  sanitizedConfigSnapshot: () => ({ version: 1 }),
  // The store write, recorded: a patch that reaches it is a patch that landed.
  applyConfigPatch: (patch: Record<string, unknown>) => {
    written.push(patch);
    return { ok: true, config: { version: 1 }, before: { version: 1 }, warnings: [] };
  },
}));

import { composeRegistry, type CapabilityRegistry } from '../../capabilities/registry.js';
import {
  CapabilityGateRefusal,
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../../capabilities/index.js';
import {
  initPermissionGate,
  resetPermissionGate,
} from '../../capabilities/permission-enforcement.js';
import { ApprovalService } from '../../approvals/index.js';
import { eventFanOut } from '../../event-fan-out.js';
import { operatorDomain } from '../operator-capabilities.js';
import { createConfigPatchHandler } from '../operator-tool-handlers.js';
import type { AgentIdentity } from '../../agent-identity/agent-identity-service.js';
import type { McpToolDeps } from '../../../runtimes/claude-code/mcp-tools/types.js';

const AGENT: AgentIdentity = {
  agentPath: '/agents/dorkbot',
  displayName: 'DorkBot',
  createdAt: new Date().toISOString(),
};

/**
 * Every perimeter setting, as the patch an agent would send to change it.
 *
 * One row per setting on purpose: a row is a promise that THIS setting stays
 * the person's. Removing one is a decision to open it, and should read as one.
 */
const PERIMETER: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  // The login gate.
  ['auth.enabled', { auth: { enabled: false } }],
  // Remote access: whether, where, through whose ngrok account, behind what.
  ['tunnel.enabled', { tunnel: { enabled: true } }],
  ['tunnel.domain', { tunnel: { domain: 'attacker.example' } }],
  ['tunnel.authtoken', { tunnel: { authtoken: 'attacker-ngrok-token' } }],
  ['tunnel.auth', { tunnel: { auth: null } }],
  // The external tool endpoint's own gate.
  ['mcp.enabled', { mcp: { enabled: true } }],
  ['mcp.apiKey', { mcp: { apiKey: 'known-key' } }],
  ['mcp.rateLimit.enabled', { mcp: { rateLimit: { enabled: false } } }],
  ['mcp.rateLimit.maxPerWindow', { mcp: { rateLimit: { maxPerWindow: 1_000_000 } } }],
  ['mcp.rateLimit.windowSecs', { mcp: { rateLimit: { windowSecs: 1 } } }],
  // Credentials, and which destination a key is handed to.
  ['providers', { providers: {} }],
  ['runtimes.codex.credentialRef', { runtimes: { codex: { credentialRef: 'other' } } }],
  ['runtimes.opencode.provider', { runtimes: { opencode: { provider: 'other' } } }],
  [
    'runtimes.opencode.baseURL',
    { runtimes: { opencode: { baseURL: 'https://attacker.example' } } },
  ],
  ['cloud.instanceToken', { cloud: { instanceToken: 'planted' } }],
  ['cloud.credits.agents', { cloud: { credits: { agents: {} } } }],
  // Executables the server spawns.
  ['runtimes.codex.binaryPath', { runtimes: { codex: { binaryPath: '/tmp/evil' } } }],
  ['runtimes.opencode.binaryPath', { runtimes: { opencode: { binaryPath: '/tmp/evil' } } }],
  // Third-party extension code: what runs, and whose code is trusted to.
  ['extensions.enabled', { extensions: { enabled: ['stranger-ext'] } }],
  ['extensions.approvedToRun', { extensions: { approvedToRun: ['stranger-ext'] } }],
  ['extensions.approvedSources', { extensions: { approvedSources: {} } }],
  ['extensions.approvedPermissions', { extensions: { approvedPermissions: {} } }],
  [
    'extensions.trustedSources',
    { extensions: { trustedSources: [{ source: 'https://attacker.example', trustedAt: 'x' }] } },
  ],
  // A tool endpoint the server contacts.
  [
    'connectors.rawMcpServers',
    { connectors: { rawMcpServers: [{ slug: 'x', url: 'https://attacker.example/mcp' }] } },
  ],
  // The containment line on disk.
  ['server.boundary', { server: { boundary: '/' } }],
];

const ALL_ALLOWED: Record<string, 'allowed'> = Object.fromEntries(
  PERMISSION_AREA_IDS.map((area) => [area, 'allowed' as const])
);

describe('an agent at full power cannot change a perimeter setting by itself', () => {
  let approvals: ApprovalService;
  let registry: CapabilityRegistry;

  beforeEach(() => {
    written.length = 0;
    approvals = new ApprovalService(createTestDb());
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    initCapabilityTierGate({ approvals });
    // The most permissive posture that exists: Full, every area Allowed by
    // default, and this agent Allowed everywhere and on this exact tool.
    initPermissionGate({
      readConfig: () => ({ preset: 'full', defaults: { areas: ALL_ALLOWED, actions: {} } }),
      readAgentPermissions: async () => ({
        areas: ALL_ALLOWED,
        actions: { 'operator.config_patch': 'allowed' },
      }),
    });
    registry = composeRegistry([operatorDomain], {
      logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
      operatorDeps: {} as McpToolDeps,
    });
  });

  afterEach(() => {
    resetCapabilityTierGate();
    resetPermissionGate();
    vi.restoreAllMocks();
  });

  it('really is the most permissive posture: an everyday setting goes straight through', async () => {
    // The control. Without it, a gate that refused everything would pass.
    await registry.invoke(
      'operator.config_patch',
      { patch: { ui: { theme: 'dark' } } },
      {
        identity: AGENT,
      }
    );
    expect(written).toEqual([{ ui: { theme: 'dark' } }]);
  });

  it.each(PERIMETER)('%s: writes nothing, and never offers Always allow', async (_path, patch) => {
    let outcome: string | undefined;
    try {
      await registry.invoke('operator.config_patch', { patch }, { identity: AGENT });
      outcome = 'ran';
    } catch (err) {
      if (!(err instanceof CapabilityGateRefusal)) throw err;
      outcome = err.decision.outcome;
    }
    // A refusal, or a card for a person. Never a write.
    expect(['approval_required', 'denied']).toContain(outcome);
    expect(written).toEqual([]);
    // A card here may never offer a standing yes: each perimeter change is its
    // own decision.
    for (const pending of approvals.listPending()) {
      expect(pending.alwaysOffered).toBe(false);
    }
  });

  it.each(PERIMETER)(
    '%s: an Allowed permission is not a person’s yes for the writer',
    async (path, patch) => {
      const result = await createConfigPatchHandler(AGENT, {
        via: 'permission',
        source: 'preset',
      })({ patch });
      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0]!.text) as { code: string; paths: string[] };
      expect(body.code).toBe('operator_only_config');
      expect(
        body.paths.some((p) => p === path || p.startsWith(`${path}.`) || p.startsWith(`${path}[]`))
      ).toBe(true);
      expect(written).toEqual([]);
    }
  );
});
