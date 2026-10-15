/**
 * Which destructive actions still ask under Trusted, the default since ADR
 * `261006-225605` (spec `trusted-by-default-flip` §5.1).
 *
 * An area-level Allowed now runs a destructive action, recorded. Four kinds
 * still raise a card with nothing set: an action with no area (its tier alone
 * decides: the perimeter and third-party code), one that declares
 * `consent: 'third-party-code'`, one in a floor area (Safety limits, Reach &
 * secrets), and one whose card shows the change it would make (`alwaysAsks`).
 *
 * Every destructive action the real registry and the hand-tool table declare
 * is listed here by name, so a new one cannot arrive without somebody deciding
 * which side of that line it is on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';

import { composeCapabilityRegistryForDocs } from '../../self-description/dorkos-registry.js';
import { MCP_TOOL_TIERS, gatedActionForMcpTool } from '../../mcp-tools/mcp-tool-tiers.js';
import { APPLY_SHAPE_ACTION } from '../../../../routes/shapes.js';
import { ApprovalService } from '../../approvals/index.js';
import { eventFanOut } from '../../event-fan-out.js';
import type { AgentIdentity } from '../../agent-identity/agent-identity-service.js';
import {
  enforceCapabilityTier,
  initCapabilityTierGate,
  resetCapabilityTierGate,
  type GatedAction,
} from '../tier-enforcement.js';
import {
  initPermissionGate,
  resetPermissionGate,
  resolveCallPermission,
  type PermissionGatedAction,
} from '../permission-enforcement.js';

/** An identified agent with nothing of its own set. */
const AGENT: AgentIdentity = {
  agentPath: '/agents/scout',
  displayName: 'Scout',
  createdAt: new Date().toISOString(),
};

/** Every destructive action that still asks under Trusted, and why. */
const STILL_ASKS: Record<string, string> = {
  'operator.update_agent_boundaries': 'Safety limits is a floor',
  'operator.update_agent_execution': 'its card shows old and new (alwaysAsks)',
  'marketplace.link': 'no area: runs code from a folder',
  'connectors.execute_destructive': 'no area: an irreversible act in an outside account',
  'mcp.add': 'third-party code: a command every session runs',
  'mcp.update': 'third-party code: a changed command every session runs',
  'shapes.apply': 'no area: applies schedules, modes and extensions',
};

/** Every destructive action that runs, recorded, under Trusted. */
const RUNS = ['marketplace.uninstall', 'mcp.import', 'tasks_delete', 'mesh_unregister'];

/** Every destructive action DorkOS declares, as the gate receives it. */
function destructiveActions(): (GatedAction & PermissionGatedAction)[] {
  const capabilities = composeCapabilityRegistryForDocs().capabilities.filter(
    (cap) => cap.tier === 'destructive'
  );
  const tools = Object.entries(MCP_TOOL_TIERS)
    .filter(([, tool]) => tool.tier === 'destructive')
    .map(([name]) => gatedActionForMcpTool(name));
  return [...capabilities, ...tools, APPLY_SHAPE_ACTION];
}

describe('destructive actions under Trusted, with nothing set', () => {
  beforeEach(() => {
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    initCapabilityTierGate({ approvals: new ApprovalService(createTestDb()) });
    initPermissionGate({
      readConfig: () => ({ preset: 'trusted', defaults: { areas: {}, actions: {} } }),
      readAgentPermissions: async () => undefined,
    });
  });

  afterEach(() => {
    resetCapabilityTierGate();
    resetPermissionGate();
    vi.restoreAllMocks();
  });

  it('lists every destructive action on one side of the line', () => {
    expect(
      destructiveActions()
        .map((a) => a.id)
        .sort()
    ).toEqual([...Object.keys(STILL_ASKS), ...RUNS].sort());
  });

  for (const [id, why] of Object.entries(STILL_ASKS)) {
    it(`${id} still asks (${why})`, async () => {
      const action = destructiveActions().find((a) => a.id === id)!;
      const permission = await resolveCallPermission({ action, identity: AGENT, input: {} });
      const decision = enforceCapabilityTier({
        action,
        input: {},
        permission,
        identity: AGENT,
        retryChannel: 'mcp-argument',
      });
      expect(decision.outcome).toBe('approval_required');
    });
  }

  for (const id of RUNS) {
    it(`${id} runs, and the gate says no card was shown`, async () => {
      const action = destructiveActions().find((a) => a.id === id)!;
      const permission = await resolveCallPermission({ action, identity: AGENT, input: {} });
      const decision = enforceCapabilityTier({
        action,
        input: {},
        permission,
        identity: AGENT,
        retryChannel: 'mcp-argument',
      });
      expect(decision).toEqual({
        outcome: 'allowed',
        approval: { via: 'permission', source: 'preset' },
      });
    });
  }
});
