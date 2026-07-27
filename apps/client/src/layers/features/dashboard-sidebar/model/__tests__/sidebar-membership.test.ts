import { describe, it, expect } from 'vitest';
import type { SidebarGroup, SidebarItemRef, SidebarPrefs } from '@dorkos/shared/config-schema';
import { SIDEBAR_PREFS_DEFAULTS } from '@dorkos/shared/config-schema';
import {
  agentPathsOf,
  effectiveMutedAgentPaths,
  evaluateSmartGroups,
  groupedAgentPaths,
  groupMemberPaths,
  individuallyMutedAgentPaths,
  storedAgentPaths,
} from '../sidebar-membership';

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
});

describe('groupMemberPaths', () => {
  it('gives a manual group its stored agent members and a smart group its derived ones', () => {
    const p = prefs({
      groups: [
        grp({ id: 'manual1', items: [agent('/a'), room('r1'), agent('/gone')] }),
        grp({ id: 'smart1', kind: 'smart', sortMode: 'recent', rules: { statuses: ['active'] } }),
      ],
    });
    const map = groupMemberPaths(p, new Set(['/a']), new Map([['smart1', ['/b']]]));
    expect(map.get('manual1')).toEqual(['/a']);
    expect(map.get('smart1')).toEqual(['/b']);
  });

  it('gives a smart group with no derived entry an empty list, not undefined', () => {
    const p = prefs({
      groups: [grp({ id: 'smart1', kind: 'smart', sortMode: 'recent', rules: { statuses: [] } })],
    });
    expect(groupMemberPaths(p, new Set(), new Map()).get('smart1')).toEqual([]);
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
