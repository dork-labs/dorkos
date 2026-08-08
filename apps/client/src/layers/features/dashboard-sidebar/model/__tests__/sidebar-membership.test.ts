import { describe, it, expect } from 'vitest';
import type { SidebarGroup, SidebarItemRef, SidebarPrefs } from '@dorkos/shared/config-schema';
import { SIDEBAR_PREFS_DEFAULTS } from '@dorkos/shared/config-schema';
import {
  agentPathsOf,
  effectiveMutedAgentPaths,
  evaluateSmartGroups,
  groupedAgentPaths,
  groupedRoomIds,
  groupMemberItems,
  individuallyMutedAgentPaths,
  roomIdsOf,
  storedAgentPaths,
} from '../sidebar-membership';
import type { SidebarItem, SidebarItemIndex } from '../sidebar-item';

const agent = (path: string): SidebarItemRef => ({ kind: 'agent', path });
const room = (roomId: string): SidebarItemRef => ({ kind: 'room', roomId });

function grp(overrides: Partial<SidebarGroup> = {}): SidebarGroup {
  return {
    id: 'g1',
    name: 'Clients',
    items: [],
    sortMode: 'manual',
    collapsed: false,
    displayFilter: 'all',
    muted: false,
    kind: 'manual',
    ...overrides,
  };
}

function prefs(overrides: Partial<SidebarPrefs> = {}): SidebarPrefs {
  return { ...structuredClone(SIDEBAR_PREFS_DEFAULTS), ...overrides };
}

/** A stand-in item; `groupMemberItems` only ever reads the reference. */
function item(ref: SidebarItemRef): SidebarItem {
  return {
    ref,
    name: ref.kind === 'agent' ? ref.path : ref.roomId,
    lastActiveAt: null,
    attention: 'active',
    muted: false,
    visual: { kind: 'sigil' },
  };
}

/** An index that answers for exactly the references given, and nothing else. */
function index(...refs: SidebarItemRef[]): SidebarItemIndex {
  const byAgentPath = new Map<string, SidebarItem>();
  const byRoomId = new Map<string, SidebarItem>();
  for (const ref of refs) {
    if (ref.kind === 'agent') byAgentPath.set(ref.path, item(ref));
    else byRoomId.set(ref.roomId, item(ref));
  }
  return { byAgentPath, byRoomId };
}

describe('agentPathsOf', () => {
  it('keeps agent paths in order and drops rooms', () => {
    expect(agentPathsOf([agent('/a'), room('r1'), agent('/b')])).toEqual(['/a', '/b']);
  });

  it('drops paths outside the roster when one is given', () => {
    expect(agentPathsOf([agent('/a'), agent('/gone')], new Set(['/a']))).toEqual(['/a']);
  });

  it('keeps every agent path when no roster is given', () => {
    expect(agentPathsOf([agent('/a'), agent('/gone')])).toEqual(['/a', '/gone']);
  });

  it('is empty for a list of only rooms', () => {
    expect(agentPathsOf([room('r1'), room('r2')])).toEqual([]);
  });
});

describe('individuallyMutedAgentPaths', () => {
  it('narrows ui.sidebar.muted to its agent members', () => {
    const set = individuallyMutedAgentPaths(prefs({ muted: [agent('/a'), room('r1')] }));
    expect([...set]).toEqual(['/a']);
  });
});

describe('effectiveMutedAgentPaths', () => {
  it('adds every member of a muted group to the individually-muted set', () => {
    const p = prefs({
      muted: [agent('/a')],
      groups: [grp({ id: 'g1', muted: true, items: [agent('/b'), room('r1')] })],
    });
    const set = effectiveMutedAgentPaths(p, individuallyMutedAgentPaths(p));
    expect([...set].sort()).toEqual(['/a', '/b']);
  });

  it('ignores an unmuted group', () => {
    const p = prefs({
      muted: [agent('/a')],
      groups: [grp({ id: 'g1', muted: false, items: [agent('/b')] })],
    });
    expect([...effectiveMutedAgentPaths(p, individuallyMutedAgentPaths(p))]).toEqual(['/a']);
  });

  it('does not mutate the set it was given (group mute stays a lens)', () => {
    const p = prefs({ groups: [grp({ muted: true, items: [agent('/b')] })] });
    const individual = individuallyMutedAgentPaths(p);
    effectiveMutedAgentPaths(p, individual);
    expect(individual.size).toBe(0);
  });
});

describe('groupedAgentPaths', () => {
  it('collects agent members across groups, filtered to the roster', () => {
    const p = prefs({
      groups: [
        grp({ id: 'g1', items: [agent('/a'), room('r1')] }),
        grp({ id: 'g2', items: [agent('/b'), agent('/gone')] }),
      ],
    });
    expect([...groupedAgentPaths(p, new Set(['/a', '/b']))].sort()).toEqual(['/a', '/b']);
  });

  it('is empty when a smart group has not been converted (its items stay empty)', () => {
    const p = prefs({
      groups: [grp({ kind: 'smart', sortMode: 'recent', rules: { statuses: ['active'] } })],
    });
    expect([...groupedAgentPaths(p, new Set(['/a']))]).toEqual([]);
  });

  it('ignores refs that leaked into a smart group, so the row keeps its home section', () => {
    // Residue of the pre-DOR-581 move-to menu: a ref filed into a smart group
    // was counted as grouped while nothing drew it — the row vanished. The
    // read now enforces the invariant the schema documents (smart items are
    // ignored), which also un-strands any config still carrying the residue.
    const leaked = prefs({
      groups: [
        grp({
          id: 'smart1',
          kind: 'smart',
          sortMode: 'recent',
          rules: { statuses: ['active'] },
          items: [agent('/a'), room('r1')],
        }),
      ],
    });
    expect([...groupedAgentPaths(leaked, new Set(['/a']))]).toEqual([]);
    expect([...groupedRoomIds(leaked)]).toEqual([]);
  });
});

describe('groupMemberItems', () => {
  it('gives a manual group its stored members — agents and rooms interleaved, in stored order', () => {
    const p = prefs({
      groups: [
        grp({ id: 'manual1', items: [agent('/a'), room('r1'), agent('/gone')] }),
        grp({ id: 'smart1', kind: 'smart', sortMode: 'recent', rules: { statuses: ['active'] } }),
      ],
    });
    const map = groupMemberItems(
      p,
      index(agent('/a'), room('r1'), agent('/b')),
      new Map([['smart1', ['/b']]])
    );
    // `/gone` is not in the index and drops out; the room keeps its place.
    expect(map.get('manual1')?.map((i) => i.ref)).toEqual([agent('/a'), room('r1')]);
    expect(map.get('smart1')?.map((i) => i.ref)).toEqual([agent('/b')]);
  });

  it('gives a smart group with no derived entry an empty list, not undefined', () => {
    const p = prefs({
      groups: [grp({ id: 'smart1', kind: 'smart', sortMode: 'recent', rules: { statuses: [] } })],
    });
    expect(groupMemberItems(p, index(), new Map()).get('smart1')).toEqual([]);
  });
});

describe('roomIdsOf', () => {
  it('keeps room ids in order and drops agents', () => {
    expect(roomIdsOf([room('r1'), agent('/a'), room('r2')])).toEqual(['r1', 'r2']);
  });
});

// The room half of the muted list moved to `entities/config` (`mutedRoomIds`),
// where the sidebar and the "Jump back in" popover both read it; its test lives
// with it, in `entities/config/__tests__/use-sidebar-prefs.test.tsx`.

describe('groupedRoomIds', () => {
  it('collects every room id across all groups', () => {
    const p = prefs({
      groups: [
        grp({ id: 'g1', items: [agent('/a'), room('r1')] }),
        grp({ id: 'g2', items: [room('r2')] }),
      ],
    });
    expect([...groupedRoomIds(p)].sort()).toEqual(['r1', 'r2']);
  });

  it('is empty when no group holds a room', () => {
    expect(groupedRoomIds(prefs({ groups: [grp({ items: [agent('/a')] })] })).size).toBe(0);
  });
});

describe('storedAgentPaths', () => {
  it('reads a group’s agent members without filtering by roster', () => {
    expect(storedAgentPaths(grp({ items: [agent('/a'), room('r1'), agent('/gone')] }))).toEqual([
      '/a',
      '/gone',
    ]);
  });
});

describe('evaluateSmartGroups', () => {
  const candidate = (projectPath: string, attention: 'active' | 'idle') => ({
    projectPath,
    runtime: 'claude-code',
    namespace: null,
    attention,
    lastActivityAt: null,
  });

  it('evaluates only smart groups, keyed by id', () => {
    const p = prefs({
      groups: [
        grp({ id: 'manual1', items: [agent('/a')] }),
        grp({ id: 'smart1', kind: 'smart', sortMode: 'recent', rules: { statuses: ['active'] } }),
      ],
    });
    const map = evaluateSmartGroups(p, [candidate('/a', 'active'), candidate('/b', 'idle')], 0);
    expect([...map.keys()]).toEqual(['smart1']);
    expect(map.get('smart1')).toEqual(['/a']);
  });

  it('skips a smart group with no rules rather than matching everything', () => {
    const p = prefs({ groups: [grp({ id: 'smart1', kind: 'smart', sortMode: 'recent' })] });
    expect(evaluateSmartGroups(p, [candidate('/a', 'active')], 0).size).toBe(0);
  });
});
