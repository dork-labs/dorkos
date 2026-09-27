/**
 * The permission-area census (spec `agent-permissions` D2): every action an
 * agent can reach — every registry capability, every hand-registered MCP tool —
 * either declares the area a person switches it with, or says in writing why it
 * has none.
 *
 * Walks the WHOLE docs registry (every domain, composed unconditionally) and the
 * hand-registered tool table, so an action added anywhere is counted the day it
 * lands. Every area's membership is pinned by name: an action that silently
 * lost its area would move from "what the person set for that area" to
 * "reachable by every agent", and nothing else would notice.
 */
import { describe, it, expect } from 'vitest';
import { PERMISSION_AREA_IDS, isFloorArea } from '@dorkos/shared/permissions';

import { composeCapabilityRegistryForDocs } from '../../self-description/dorkos-registry.js';
import { MCP_TOOL_TIERS, type McpToolTier } from '../../mcp-tool-tiers.js';
import { serializeCapability } from '../registry.js';

/** One action as the census reads it, from either source. */
interface CensusEntry {
  id: string;
  tier: string;
  area: string | null;
  areaNote?: string;
  approvalDisplayFields?: readonly string[];
}

/** Every agent-reachable action, from both sources. */
function everyAction(): CensusEntry[] {
  const registry = composeCapabilityRegistryForDocs();
  const capabilities: CensusEntry[] = registry.capabilities.map((cap) => ({
    id: cap.id,
    tier: cap.tier,
    area: cap.area,
    ...(cap.areaNote !== undefined ? { areaNote: cap.areaNote } : {}),
    ...(cap.approvalDisplayFields ? { approvalDisplayFields: cap.approvalDisplayFields } : {}),
  }));
  const tools: CensusEntry[] = Object.entries(MCP_TOOL_TIERS as Record<string, McpToolTier>).map(
    ([id, tool]) => ({
      id,
      tier: tool.tier,
      area: tool.area,
      ...(tool.areaNote !== undefined ? { areaNote: tool.areaNote } : {}),
      ...(tool.approvalDisplayFields ? { approvalDisplayFields: tool.approvalDisplayFields } : {}),
    })
  );
  return [...capabilities, ...tools];
}

/**
 * Every area's members, by id, as spec `agent-permissions` D2 assigns them.
 * Reach & secrets has no static member on purpose: it is reached by input, when
 * a config patch touches a setting like the tunnel (asserted separately below).
 */
const EXPECTED_MEMBERS: Record<string, readonly string[]> = {
  rooms: [
    'rooms.add_members',
    'rooms.archive',
    'rooms.create',
    'rooms.leave',
    'rooms.merge',
    'rooms.remove_members',
    'rooms.update',
  ],
  tasks: ['tasks_create', 'tasks_delete', 'tasks_get_run_history', 'tasks_list', 'tasks_update'],
  agents: [
    'create_agent',
    'mesh_deny',
    'mesh_discover',
    'mesh_inspect',
    'mesh_list',
    'mesh_query_topology',
    'mesh_register',
    'mesh_status',
    'mesh_unregister',
    'operator.sidebar_add_to_group',
    'operator.sidebar_remove_from_group',
    'operator.update_agent',
    'operator.update_agent_execution',
  ],
  messages: [
    'relay_get_metrics',
    'relay_get_trace',
    'relay_inbox',
    'relay_list_endpoints',
    'relay_notify_user',
    'relay_register_endpoint',
    'relay_send',
    'relay_send_and_wait',
    'relay_send_async',
    'relay_unregister_endpoint',
  ],
  connections: [
    'binding_create',
    'binding_delete',
    'binding_list',
    'binding_list_sessions',
    'relay_disable_adapter',
    'relay_enable_adapter',
    'relay_list_adapters',
    'relay_reload_adapters',
  ],
  packages: [
    'create_extension',
    'marketplace.create_package',
    'marketplace.install',
    'marketplace.uninstall',
    'marketplace.update',
    'mcp.add',
    'mcp.disable',
    'mcp.enable',
    'mcp.import',
    'mcp.remove',
    'mcp.set_client',
    'mcp.signin',
    'mcp.test',
    'mcp.update',
    'reload_extensions',
    'test_extension',
  ],
  settings: ['operator.config_patch'],
  safety: ['operator.update_agent_boundaries'],
  permissions: ['permissions.change'],
  reach: [],
};

describe('permission-area census', () => {
  const actions = everyAction();

  it('counts a real population, so the rows below are not vacuous', () => {
    expect(actions.length).toBeGreaterThan(100);
  });

  it('gives every action an area, or a written reason it has none', () => {
    const unexplained = actions
      .filter((a) => a.area === null && (!a.areaNote || a.areaNote.trim() === ''))
      .map((a) => a.id);
    expect(unexplained).toEqual([]);
  });

  it('names only known areas', () => {
    const unknown = actions
      .filter(
        (a) => a.area !== null && !(PERMISSION_AREA_IDS as readonly string[]).includes(a.area)
      )
      .map((a) => `${a.id} -> ${a.area}`);
    expect(unknown).toEqual([]);
  });

  it('gives every action in a floor area card fields', () => {
    const bare = actions
      .filter((a) => a.area !== null && isFloorArea(a.area) && !a.approvalDisplayFields?.length)
      .map((a) => a.id);
    expect(bare).toEqual([]);
  });

  it('gives every non-read action with an area card fields, since Ask raises a card', () => {
    // Declared, and non-empty unless the action takes no arguments at all
    // (`relay_reload_adapters`): the tool table's own pin checks that side.
    const bare = actions
      .filter((a) => a.area !== null && a.tier !== 'observe' && !a.approvalDisplayFields)
      .map((a) => a.id);
    expect(bare).toEqual([]);
  });

  it('leaves no action on a placeholder note from an earlier phase', () => {
    const placeholders = actions
      .filter((a) => a.areaNote !== undefined && /phase/i.test(a.areaNote))
      .map((a) => `${a.id}: ${a.areaNote}`);
    expect(placeholders).toEqual([]);
  });

  it('never leaves an observe action as the only member of an area', () => {
    const byArea = new Map<string, CensusEntry[]>();
    for (const a of actions) {
      if (a.area === null) continue;
      byArea.set(a.area, [...(byArea.get(a.area) ?? []), a]);
    }
    const readOnlyAreas = [...byArea.entries()]
      .filter(([, members]) => members.every((m) => m.tier === 'observe'))
      .map(([area]) => area);
    expect(readOnlyAreas).toEqual([]);
  });

  it('puts the area on the serialized catalog entry', () => {
    const create = composeCapabilityRegistryForDocs().get('rooms.create');
    expect(create).toBeDefined();
    expect(serializeCapability(create!).area).toBe('rooms');
  });

  it('pins every area to exactly the actions the spec puts in it', () => {
    for (const area of PERMISSION_AREA_IDS) {
      const members = actions
        .filter((a) => a.area === area)
        .map((a) => a.id)
        .sort();
      expect(members, area).toEqual([...EXPECTED_MEMBERS[area]!].sort());
    }
  });

  it('gives all ten areas something to switch, Reach & secrets by input', () => {
    for (const area of PERMISSION_AREA_IDS) {
      if (area === 'reach') continue;
      expect(
        actions.some((a) => a.area === area),
        area
      ).toBe(true);
    }
    // Reach & secrets has no static member: a config patch touching the tunnel
    // is asked about there. Without this, its row would switch nothing at all.
    const configPatch = composeCapabilityRegistryForDocs().get('operator.config_patch');
    expect(configPatch?.areasForInput?.({ patch: { tunnel: { enabled: true } } })).toEqual([
      'reach',
    ]);
  });
});
