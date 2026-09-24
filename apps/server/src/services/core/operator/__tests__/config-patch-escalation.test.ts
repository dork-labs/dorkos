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
  areaForCall,
  initPermissionGate,
  resetPermissionGate,
} from '../../capabilities/permission-enforcement.js';
import { ApprovalService } from '../../approvals/index.js';
import { eventFanOut } from '../../event-fan-out.js';
import { operatorDomain } from '../operator-capabilities.js';
import { createConfigPatchHandler } from '../operator-tool-handlers.js';
import { operatorOnlyAreaForPatch } from '../config-write-policy.js';
import type { AgentIdentity } from '../../agent-identity/agent-identity-service.js';
import type { McpToolDeps } from '../../../runtimes/claude-code/mcp-tools/types.js';

const AGENT: AgentIdentity = {
  agentPath: '/agents/dorkbot',
  displayName: 'DorkBot',
  createdAt: new Date().toISOString(),
};

const TUNNEL_PATCH = { patch: { tunnel: { enabled: true } } };

describe('which area a config patch is asked about in', () => {
  it('keeps an everyday setting in DorkOS settings', () => {
    expect(operatorOnlyAreaForPatch({ ui: { theme: 'dark' } })).toBeNull();
  });

  it('puts the tunnel in Reach & secrets', () => {
    expect(operatorOnlyAreaForPatch({ tunnel: { enabled: true } })).toBe('reach');
  });

  it('puts a room reply limit in Safety limits', () => {
    expect(operatorOnlyAreaForPatch({ rooms: { maxAgentDepth: 9 } })).toBe('safety');
  });

  it('puts a trust stop and a consent stamp in Permissions', () => {
    expect(operatorOnlyAreaForPatch({ runtimes: { defaultTrustStop: 'autonomy' } })).toBe(
      'permissions'
    );
    expect(operatorOnlyAreaForPatch({ ui: { fullPowerChoice: 'full' } })).toBe('permissions');
  });

  it('asks a mixed patch in the strictest area it touches', () => {
    // Permissions beats Reach & secrets beats Safety limits.
    expect(
      operatorOnlyAreaForPatch({
        ui: { theme: 'dark' },
        tunnel: { enabled: true },
        rooms: { maxAgentDepth: 9 },
      })
    ).toBe('reach');
    expect(
      operatorOnlyAreaForPatch({
        tunnel: { enabled: true },
        runtimes: { defaultTrustStop: 'act' },
      })
    ).toBe('permissions');
  });
});

describe('an input can only make a call stricter', () => {
  const base = { id: 'probe.escalate', tier: 'act' as const };

  it('takes a floor area over an everyday one', () => {
    expect(areaForCall({ ...base, area: 'settings', areaForInput: () => 'reach' }, {})).toBe(
      'reach'
    );
  });

  it('ignores an answer that would loosen a floor area', () => {
    expect(areaForCall({ ...base, area: 'reach', areaForInput: () => 'settings' }, {})).toBe(
      'reach'
    );
  });

  it('keeps the static area when the input asks for nothing', () => {
    expect(areaForCall({ ...base, area: 'settings', areaForInput: () => null }, {})).toBe(
      'settings'
    );
  });

  it('decides in Permissions when the escalation itself fails', () => {
    const throwing = () => {
      throw new Error('boom');
    };
    expect(areaForCall({ ...base, area: 'settings', areaForInput: throwing }, {})).toBe(
      'permissions'
    );
  });
});

describe('an agent patching a guarded setting', () => {
  let approvals: ApprovalService;
  let registry: CapabilityRegistry;
  let preset: PermissionPreset | null;

  beforeEach(() => {
    written.length = 0;
    preset = 'full';
    approvals = new ApprovalService(createTestDb());
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    initCapabilityTierGate({ approvals });
    initPermissionGate({
      readConfig: () => ({ preset, defaults: { areas: {}, actions: {} } }),
      readAgentPermissions: async () => undefined,
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
