/**
 * Which calls could raise what agents may do (DOR-3037): the ones that reach
 * the Permissions, Safety limits or Reach & secrets areas, by their own area or
 * by what their input touches. Their approval cards cannot be granted from
 * Wi-Fi.
 */
import { describe, expect, it } from 'vitest';
import { callRaisesPermissions } from '../permission-enforcement.js';
import { operatorOnlyAreasForPatch } from '../../operator/config-write-policy.js';

const configPatch = {
  id: 'operator.config_patch',
  tier: 'act' as const,
  area: 'settings' as const,
  areasForInput: (input: unknown) =>
    operatorOnlyAreasForPatch((input as { patch?: unknown }).patch),
};

describe('callRaisesPermissions', () => {
  it('marks a call in the Permissions, Safety or Reach area', () => {
    for (const area of ['permissions', 'safety', 'reach'] as const) {
      expect(callRaisesPermissions({ id: `x.${area}`, tier: 'act', area }, {})).toBe(true);
    }
  });

  it('marks a settings patch that reaches a trust stop or a limit, and not a theme', () => {
    expect(
      callRaisesPermissions(configPatch, { patch: { runtimes: { defaultTrustStop: 'autonomy' } } })
    ).toBe(true);
    expect(callRaisesPermissions(configPatch, { patch: { rooms: { maxAgentDepth: 50 } } })).toBe(
      true
    );
    expect(callRaisesPermissions(configPatch, { patch: { ui: { theme: 'dark' } } })).toBe(false);
  });

  it('marks installing a package, creating an agent and switching on an MCP server', () => {
    for (const id of ['marketplace.install', 'create_agent', 'mcp.enable']) {
      expect(callRaisesPermissions({ id, tier: 'act', area: 'packages' }, {})).toBe(true);
    }
  });

  it('leaves a call in an ordinary area unmarked', () => {
    expect(callRaisesPermissions({ id: 'rooms.create', tier: 'act', area: 'rooms' }, {})).toBe(
      false
    );
  });
});
