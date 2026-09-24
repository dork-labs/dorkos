/**
 * The permission-area census (spec `agent-permissions` D2): every action an
 * agent can reach — every registry capability, every hand-registered MCP tool —
 * either declares the area a person switches it with, or says in writing why it
 * has none.
 *
 * Walks the WHOLE docs registry (every domain, composed unconditionally) and the
 * hand-registered tool table, so an action added anywhere is counted the day it
 * lands. The phase-1 membership of the Rooms area is pinned by name: an action
 * that silently lost its area would move from "what the person set for Rooms" to
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
 * The areas that have members in this phase. Phase 3 assigns every other action
 * its final area and widens this to all ten.
 */
const AREAS_WITH_MEMBERS_THIS_PHASE = ['rooms'] as const;

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
    const bare = actions
      .filter((a) => a.area !== null && a.tier !== 'observe' && !a.approvalDisplayFields?.length)
      .map((a) => a.id);
    expect(bare).toEqual([]);
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

  it('pins the Rooms area to exactly the room-arranging verbs', () => {
    const rooms = actions
      .filter((a) => a.area === 'rooms')
      .map((a) => a.id)
      .sort();
    expect(rooms).toEqual(
      [
        'rooms.add_members',
        'rooms.archive',
        'rooms.create',
        'rooms.leave',
        'rooms.merge',
        'rooms.remove_members',
        'rooms.update',
      ].sort()
    );
  });

  it('gives every area with members this phase at least one member', () => {
    // Scoped to the areas phase 1 populates; phase 3 widens this to all ten,
    // once every other action has its final area.
    for (const area of AREAS_WITH_MEMBERS_THIS_PHASE) {
      expect(
        actions.some((a) => a.area === area),
        area
      ).toBe(true);
    }
  });
});
