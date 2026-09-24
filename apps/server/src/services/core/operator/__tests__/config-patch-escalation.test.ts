/**
 * `operator.config_patch` asks in a floor area when its input touches a setting
 * only a person may change, and an approved change goes through (spec
 * `agent-permissions` D6, task 3.2).
 *
 * Runs the REAL capability definition through a real registry, the real gate,
 * the real resolver and the real guarded writer. Only the final store write is
 * replaced, so nothing touches a real config file.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { PermissionPreset } from '@dorkos/shared/permissions';

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
  areasForCall,
  initPermissionGate,
  resetPermissionGate,
} from '../../capabilities/permission-enforcement.js';
import { ApprovalService } from '../../approvals/index.js';
import { eventFanOut } from '../../event-fan-out.js';
import { operatorDomain } from '../operator-capabilities.js';
import { createConfigPatchHandler } from '../operator-tool-handlers.js';
import { operatorOnlyAreasForPatch } from '../config-write-policy.js';
import type { AgentIdentity } from '../../agent-identity/agent-identity-service.js';
import type { McpToolDeps } from '../../../runtimes/claude-code/mcp-tools/types.js';

const AGENT: AgentIdentity = {
  agentPath: '/agents/dorkbot',
  displayName: 'DorkBot',
  createdAt: new Date().toISOString(),
};

const TUNNEL_PATCH = { patch: { tunnel: { enabled: true } } };

describe('which areas a config patch reaches', () => {
  it('reaches no floor area for an everyday setting', () => {
    expect(operatorOnlyAreasForPatch({ ui: { theme: 'dark' } })).toEqual([]);
  });

  it('puts the tunnel in Reach & secrets', () => {
    expect(operatorOnlyAreasForPatch({ tunnel: { enabled: true } })).toEqual(['reach']);
  });

  it('puts a room reply limit in Safety limits', () => {
    expect(operatorOnlyAreasForPatch({ rooms: { maxAgentDepth: 9 } })).toEqual(['safety']);
  });

  it('puts a trust stop and a consent stamp in Permissions', () => {
    expect(operatorOnlyAreasForPatch({ runtimes: { defaultTrustStop: 'autonomy' } })).toEqual([
      'permissions',
    ]);
    expect(operatorOnlyAreasForPatch({ ui: { fullPowerChoice: 'full' } })).toEqual(['permissions']);
  });

  it('names every area a mixed patch reaches, each once', () => {
    expect(
      operatorOnlyAreasForPatch({
        ui: { theme: 'dark' },
        tunnel: { enabled: true },
        rooms: { maxAgentDepth: 9 },
        runtimes: { defaultTrustStop: 'act' },
      }).sort()
    ).toEqual(['permissions', 'reach', 'safety']);
  });
});

describe('the areas one call is decided in', () => {
  const base = { id: 'probe.escalate', tier: 'act' as const };

  it('keeps its own area first and adds what the input reaches', () => {
    expect(areasForCall({ ...base, area: 'settings', areasForInput: () => ['reach'] }, {})).toEqual(
      ['settings', 'reach']
    );
  });

  it('keeps its own area when the input reaches nothing more', () => {
    expect(areasForCall({ ...base, area: 'settings', areasForInput: () => [] }, {})).toEqual([
      'settings',
    ]);
  });

  it('adds Permissions when the input cannot be read for its areas', () => {
    const throwing = () => {
      throw new Error('boom');
    };
    expect(areasForCall({ ...base, area: 'settings', areasForInput: throwing }, {})).toEqual([
      'settings',
      'permissions',
    ]);
  });
});

describe('an agent patching a guarded setting', () => {
  let approvals: ApprovalService;
  let registry: CapabilityRegistry;
  let preset: PermissionPreset | null;
  let defaultAreas: Record<string, 'blocked' | 'ask' | 'allowed'>;
  let own:
    | {
        areas?: Record<string, 'blocked' | 'ask' | 'allowed'>;
        actions?: Record<string, 'blocked' | 'ask' | 'allowed'>;
      }
    | undefined;

  beforeEach(() => {
    written.length = 0;
    preset = 'full';
    defaultAreas = {};
    own = undefined;
    approvals = new ApprovalService(createTestDb());
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    initCapabilityTierGate({ approvals });
    initPermissionGate({
      readConfig: () => ({ preset, defaults: { areas: defaultAreas, actions: {} } }),
      readAgentPermissions: async () => own,
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

  /** Invoke as DorkBot and hand back the refusal the gate raised. */
  async function refusal(input: unknown, token?: string) {
    try {
      await registry.invoke('operator.config_patch', input, {
        identity: AGENT,
        ...(token ? { approvalToken: token } : {}),
      });
    } catch (err) {
      if (err instanceof CapabilityGateRefusal) return err.decision;
      throw err;
    }
    return undefined;
  }

  it('raises a card in Reach & secrets with no Always allow, and writes nothing yet', async () => {
    const decision = await refusal(TUNNEL_PATCH);
    expect(decision?.outcome).toBe('approval_required');
    const [pending] = approvals.listPending();
    expect(pending).toMatchObject({ area: 'reach', alwaysOffered: false });
    // The card names the setting, never the patch object.
    expect(pending!.summary).toContain('tunnel.enabled: yes');
    expect(written).toEqual([]);
  });

  it('applies the change once the person says Allow', async () => {
    const decision = await refusal(TUNNEL_PATCH);
    if (decision?.outcome !== 'approval_required') throw new Error('expected a card');
    approvals.grant(decision.payload.approvalId);
    await registry.invoke('operator.config_patch', TUNNEL_PATCH, {
      identity: AGENT,
      approvalToken: decision.payload.approvalToken,
    });
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ tunnel: { enabled: true } });
  });

  it('asks about an everyday setting in DorkOS settings, where Always allow is offered', async () => {
    // DorkOS settings is Ask on every preset, so it asks, in its own area.
    const decision = await refusal({ patch: { ui: { theme: 'dark' } } });
    expect(decision?.outcome).toBe('approval_required');
    expect(approvals.listPending()[0]).toMatchObject({ area: 'settings', alwaysOffered: true });
  });

  it('cannot carry a Blocked area past its setting by touching another floor area', async () => {
    // Careful blocks Reach & secrets. Alone, a trust-stop change asks in
    // Permissions; the tunnel riding along must not ride that card through.
    preset = 'careful';
    const decision = await refusal({
      patch: { tunnel: { enabled: true }, runtimes: { defaultTrustStop: 'act' } },
    });
    expect(decision).toMatchObject({
      outcome: 'denied',
      payload: { reason: 'permission_blocked' },
    });
    expect(approvals.listPending()).toEqual([]);
    expect(written).toEqual([]);
  });

  it('refuses when any area the patch reaches is Blocked for this agent', async () => {
    own = { areas: { safety: 'blocked' } };
    const decision = await refusal({
      patch: { tunnel: { enabled: true }, rooms: { maxAgentDepth: 9 } },
    });
    expect(decision).toMatchObject({
      outcome: 'denied',
      payload: { reason: 'permission_blocked' },
    });
    expect(approvals.listPending()).toEqual([]);
  });

  it('keeps an Always allow on the tool to its own area', async () => {
    // Allowed for config_patch runs everyday settings without asking, but it is
    // no answer for Reach & secrets, which is decided there, area-level.
    own = { actions: { 'operator.config_patch': 'allowed' } };
    defaultAreas = { reach: 'blocked' };
    const decision = await refusal(TUNNEL_PATCH);
    expect(decision).toMatchObject({
      outcome: 'denied',
      payload: { reason: 'permission_blocked' },
    });
  });

  it('asks in a floor area when every area it reaches asks', async () => {
    const decision = await refusal({
      patch: { tunnel: { enabled: true }, runtimes: { defaultTrustStop: 'act' } },
    });
    expect(decision?.outcome).toBe('approval_required');
    expect(approvals.listPending()[0]).toMatchObject({ alwaysOffered: false });
  });

  it('is Blocked on an undecided install, as the refusal before it was', async () => {
    preset = null;
    const decision = await refusal(TUNNEL_PATCH);
    expect(decision).toMatchObject({
      outcome: 'denied',
      payload: { reason: 'permission_blocked' },
    });
    expect(written).toEqual([]);
  });
});

describe('the handler without a person’s yes', () => {
  beforeEach(() => {
    written.length = 0;
  });

  it('still refuses a guarded setting, exactly as before', async () => {
    const result = await createConfigPatchHandler(AGENT)({ patch: { tunnel: { enabled: true } } });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ code: 'operator_only_config' });
    expect(written).toEqual([]);
  });

  it('writes a guarded setting when the gate spent a person’s approval on it', async () => {
    const result = await createConfigPatchHandler(AGENT, {
      via: 'approval',
      approvalId: 'appr-1',
    })({ patch: { tunnel: { enabled: true } } });
    expect(result.isError).toBeUndefined();
    expect(written).toHaveLength(1);
  });

  it('never lets an Allowed permission stand in for that yes', async () => {
    const result = await createConfigPatchHandler(AGENT, { via: 'permission', source: 'preset' })({
      patch: { tunnel: { enabled: true } },
    });
    expect(result.isError).toBe(true);
    expect(written).toEqual([]);
  });
});
