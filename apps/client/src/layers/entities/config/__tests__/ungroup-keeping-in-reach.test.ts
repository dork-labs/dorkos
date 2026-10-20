/**
 * Taking something out of a section never takes an agent off the sidebar
 * (DOR-3092): an agent with no direct message is pinned on the way out, and
 * nothing else changes.
 */
import { describe, expect, it } from 'vitest';
import {
  SIDEBAR_PREFS_DEFAULTS,
  type SidebarGroup,
  type SidebarItemRef,
  type SidebarPrefs,
} from '@dorkos/shared/config-schema';
import { ungroupKeepingInReach } from '../model/ungroup-keeping-in-reach';

const ANA: SidebarItemRef = { kind: 'agent', path: '/agents/ana' };
const BO: SidebarItemRef = { kind: 'agent', path: '/agents/bo' };
const DESIGN: SidebarItemRef = { kind: 'room', roomId: 'room-design' };

/** A section holding `items`. */
function group(id: string, items: SidebarItemRef[], kind: 'manual' | 'smart' = 'manual') {
  return {
    id,
    name: id,
    kind,
    items,
    collapsed: false,
    sortMode: 'manual',
    displayFilter: 'all',
    muted: false,
  } as SidebarGroup;
}

/** Prefs with these sections and pins. */
function prefs(groups: SidebarGroup[], pinned: SidebarItemRef[] = []): SidebarPrefs {
  return { ...SIDEBAR_PREFS_DEFAULTS, groups, pinned };
}

/** Bo has a direct message; Ana does not. */
const boHasOne = (path: string) => path === BO.path;

describe('ungroupKeepingInReach', () => {
  it('pins an agent removed from its section that has no direct message', () => {
    const next = ungroupKeepingInReach(
      prefs([group('g', [ANA])]),
      { kind: 'item', ref: ANA },
      boHasOne
    );
    expect(next.groups[0]!.items).toEqual([]);
    expect(next.pinned).toEqual([ANA]);
  });

  it('leaves an agent its direct message keeps in reach unpinned', () => {
    const next = ungroupKeepingInReach(
      prefs([group('g', [BO])]),
      { kind: 'item', ref: BO },
      boHasOne
    );
    expect(next.pinned).toEqual([]);
  });

  it('never pins a room', () => {
    const next = ungroupKeepingInReach(
      prefs([group('g', [DESIGN])]),
      { kind: 'item', ref: DESIGN },
      boHasOne
    );
    expect(next.pinned).toEqual([]);
  });

  it('pins once, however often it runs', () => {
    const next = ungroupKeepingInReach(
      prefs([group('g', [ANA])], [ANA]),
      { kind: 'item', ref: ANA },
      boHasOne
    );
    expect(next.pinned).toEqual([ANA]);
  });

  it('deletes a section and pins only the agents that would vanish', () => {
    const next = ungroupKeepingInReach(
      prefs([group('g', [ANA, BO, DESIGN]), group('other', [])]),
      { kind: 'section', groupId: 'g' },
      boHasOne
    );
    expect(next.groups.map((entry) => entry.id)).toEqual(['other']);
    expect(next.pinned).toEqual([ANA]);
  });

  it('pins nothing for a smart section, whose members are rules, not items', () => {
    const next = ungroupKeepingInReach(
      prefs([group('s', [ANA], 'smart')]),
      { kind: 'section', groupId: 's' },
      boHasOne
    );
    expect(next.groups).toEqual([]);
    expect(next.pinned).toEqual([]);
  });
});
