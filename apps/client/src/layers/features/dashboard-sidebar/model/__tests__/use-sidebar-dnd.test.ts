import { describe, it, expect } from 'vitest';
import type { SidebarPrefs, SidebarGroup } from '@dorkos/shared/config-schema';
import {
  classifySidebarDrop,
  resolveSidebarDrop,
  buildSidebarAnnouncements,
  readSidebarDndData,
  toDragDescriptor,
  toDropDescriptor,
  type AgentContainer,
  type SidebarDragDescriptor,
  type SidebarDropDescriptor,
  type SidebarDndData,
} from '../use-sidebar-dnd';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function grp(overrides: Partial<SidebarGroup> = {}): SidebarGroup {
  return {
    id: 'g1',
    name: 'Clients',
    agentPaths: [],
    sortMode: 'manual',
    collapsed: false,
    ...overrides,
  };
}

function prefs(overrides: Partial<SidebarPrefs> = {}): SidebarPrefs {
  return {
    pinned: [],
    groups: [],
    ungroupedSortMode: 'name',
    ungroupedCollapsed: false,
    recentsCollapsed: false,
    groupsHintDismissed: false,
    ...overrides,
  };
}

const PINNED: AgentContainer = { kind: 'pinned' };
const UNGROUPED: AgentContainer = { kind: 'ungrouped' };
const inGroup = (groupId: string): AgentContainer => ({ kind: 'group', groupId });

const dragAgent = (path: string, from: AgentContainer): SidebarDragDescriptor => ({
  type: 'agent',
  path,
  from,
});
const dragGroup = (groupId: string): SidebarDragDescriptor => ({ type: 'group', groupId });

const dropContainer = (container: AgentContainer): SidebarDropDescriptor => ({
  type: 'container',
  container,
});
const dropItem = (path: string, container: AgentContainer): SidebarDropDescriptor => ({
  type: 'agent-item',
  path,
  container,
});
const dropHeader = (groupId: string): SidebarDropDescriptor => ({ type: 'group-header', groupId });

// ---------------------------------------------------------------------------
// Semantics table — one describe per row
// ---------------------------------------------------------------------------

describe('classifySidebarDrop / resolveSidebarDrop', () => {
  it('reorders the groups array when a group header drops between other headers', () => {
    const p = prefs({ groups: [grp({ id: 'a' }), grp({ id: 'b' }), grp({ id: 'c' })] });
    const op = classifySidebarDrop(p, dragGroup('c'), dropHeader('a'));
    expect(op).toEqual({ kind: 'reorder-group', groupId: 'c', from: 2, to: 0 });
    const next = resolveSidebarDrop(p, dragGroup('c'), dropHeader('a'));
    expect(next.groups.map((g) => g.id)).toEqual(['c', 'a', 'b']);
  });

  it('moves an agent into a group (appended) when dropped on the group body', () => {
    const p = prefs({ groups: [grp({ id: 'g1', agentPaths: ['/x'] })] });
    const op = classifySidebarDrop(p, dragAgent('/new', UNGROUPED), dropContainer(inGroup('g1')));
    expect(op).toEqual({ kind: 'move-to-group', path: '/new', groupId: 'g1', toIndex: null });
    const next = resolveSidebarDrop(p, dragAgent('/new', UNGROUPED), dropContainer(inGroup('g1')));
    expect(next.groups[0]!.agentPaths).toEqual(['/x', '/new']);
  });

  it('moves an agent into a group when dropped on its collapsed header', () => {
    const p = prefs({ groups: [grp({ id: 'g1', collapsed: true, agentPaths: ['/x'] })] });
    const next = resolveSidebarDrop(p, dragAgent('/new', UNGROUPED), dropHeader('g1'));
    expect(next.groups[0]!.agentPaths).toEqual(['/x', '/new']);
  });

  it('uses the drop index when moving into a manual group over a specific row', () => {
    const p = prefs({
      groups: [grp({ id: 'g1', sortMode: 'manual', agentPaths: ['/a', '/b', '/c'] })],
    });
    const op = classifySidebarDrop(p, dragAgent('/new', UNGROUPED), dropItem('/b', inGroup('g1')));
    expect(op).toEqual({ kind: 'move-to-group', path: '/new', groupId: 'g1', toIndex: 1 });
    const next = resolveSidebarDrop(p, dragAgent('/new', UNGROUPED), dropItem('/b', inGroup('g1')));
    expect(next.groups[0]!.agentPaths).toEqual(['/a', '/new', '/b', '/c']);
  });

  it('appends (ignores drop index) when moving into a non-manual group', () => {
    const p = prefs({ groups: [grp({ id: 'g1', sortMode: 'name', agentPaths: ['/a', '/b'] })] });
    const op = classifySidebarDrop(p, dragAgent('/new', UNGROUPED), dropItem('/a', inGroup('g1')));
    expect(op).toEqual({ kind: 'move-to-group', path: '/new', groupId: 'g1', toIndex: null });
    const next = resolveSidebarDrop(p, dragAgent('/new', UNGROUPED), dropItem('/a', inGroup('g1')));
    expect(next.groups[0]!.agentPaths).toEqual(['/a', '/b', '/new']);
  });

  it('pins an agent (reference; home membership unchanged) when dropped on Pinned', () => {
    const p = prefs({ groups: [grp({ id: 'g1', agentPaths: ['/x'] })] });
    const op = classifySidebarDrop(p, dragAgent('/x', inGroup('g1')), dropContainer(PINNED));
    expect(op).toEqual({ kind: 'pin', path: '/x' });
    const next = resolveSidebarDrop(p, dragAgent('/x', inGroup('g1')), dropContainer(PINNED));
    expect(next.pinned).toEqual(['/x']);
    expect(next.groups[0]!.agentPaths).toEqual(['/x']); // still in its home group
  });

  it('reorders within a manual group when a member drops over a sibling', () => {
    const p = prefs({
      groups: [grp({ id: 'g1', sortMode: 'manual', agentPaths: ['/a', '/b', '/c'] })],
    });
    const op = classifySidebarDrop(
      p,
      dragAgent('/a', inGroup('g1')),
      dropItem('/c', inGroup('g1'))
    );
    expect(op).toEqual({ kind: 'reorder-within-group', groupId: 'g1', path: '/a', from: 0, to: 2 });
    const next = resolveSidebarDrop(
      p,
      dragAgent('/a', inGroup('g1')),
      dropItem('/c', inGroup('g1'))
    );
    expect(next.groups[0]!.agentPaths).toEqual(['/b', '/c', '/a']);
  });

  it('does NOT reorder within a name/recent group (sort mode owns order)', () => {
    const p = prefs({ groups: [grp({ id: 'g1', sortMode: 'name', agentPaths: ['/a', '/b'] })] });
    const op = classifySidebarDrop(
      p,
      dragAgent('/a', inGroup('g1')),
      dropItem('/b', inGroup('g1'))
    );
    expect(op).toEqual({ kind: 'none' });
    expect(
      resolveSidebarDrop(p, dragAgent('/a', inGroup('g1')), dropItem('/b', inGroup('g1')))
    ).toBe(p);
  });

  it('reorders the pinned array when a pinned row drops over another pinned row', () => {
    const p = prefs({ pinned: ['/a', '/b', '/c'] });
    const op = classifySidebarDrop(p, dragAgent('/c', PINNED), dropItem('/a', PINNED));
    expect(op).toEqual({ kind: 'reorder-pinned', path: '/c', from: 2, to: 0 });
    const next = resolveSidebarDrop(p, dragAgent('/c', PINNED), dropItem('/a', PINNED));
    expect(next.pinned).toEqual(['/c', '/a', '/b']);
  });

  it('unpins when a pinned row is dropped anywhere outside Pinned (home untouched)', () => {
    const p = prefs({ pinned: ['/a'], groups: [grp({ id: 'g1', agentPaths: ['/a'] })] });
    const op = classifySidebarDrop(p, dragAgent('/a', PINNED), dropContainer(UNGROUPED));
    expect(op).toEqual({ kind: 'unpin', path: '/a' });
    const next = resolveSidebarDrop(p, dragAgent('/a', PINNED), dropContainer(UNGROUPED));
    expect(next.pinned).toEqual([]);
    expect(next.groups[0]!.agentPaths).toEqual(['/a']); // membership untouched
  });

  it('removes an agent from its group when dropped on the Agents (ungrouped) section', () => {
    const p = prefs({ groups: [grp({ id: 'g1', agentPaths: ['/a', '/b'] })] });
    const op = classifySidebarDrop(p, dragAgent('/a', inGroup('g1')), dropContainer(UNGROUPED));
    expect(op).toEqual({ kind: 'remove-from-group', path: '/a' });
    const next = resolveSidebarDrop(p, dragAgent('/a', inGroup('g1')), dropContainer(UNGROUPED));
    expect(next.groups[0]!.agentPaths).toEqual(['/b']);
  });

  it('moves an agent between two groups (disjointness preserved)', () => {
    const p = prefs({
      groups: [grp({ id: 'g1', agentPaths: ['/a'] }), grp({ id: 'g2', agentPaths: ['/b'] })],
    });
    const next = resolveSidebarDrop(
      p,
      dragAgent('/a', inGroup('g1')),
      dropContainer(inGroup('g2'))
    );
    expect(next.groups[0]!.agentPaths).toEqual([]);
    expect(next.groups[1]!.agentPaths).toEqual(['/b', '/a']);
  });

  // ── No-op and unknown-target cases ──

  it('is a no-op when a member drops onto its own position in a manual group', () => {
    const p = prefs({ groups: [grp({ id: 'g1', sortMode: 'manual', agentPaths: ['/a', '/b'] })] });
    expect(
      classifySidebarDrop(p, dragAgent('/a', inGroup('g1')), dropItem('/a', inGroup('g1')))
    ).toEqual({
      kind: 'none',
    });
  });

  it('is a no-op when a group header drops onto itself', () => {
    const p = prefs({ groups: [grp({ id: 'a' }), grp({ id: 'b' })] });
    expect(classifySidebarDrop(p, dragGroup('a'), dropHeader('a'))).toEqual({ kind: 'none' });
  });

  it('is a no-op for a null (no valid target) drop', () => {
    const p = prefs({ pinned: ['/a'] });
    expect(classifySidebarDrop(p, dragAgent('/a', PINNED), null)).toEqual({ kind: 'none' });
    expect(resolveSidebarDrop(p, dragAgent('/a', PINNED), null)).toBe(p);
  });

  it('is a no-op when an ungrouped row is dropped back on the Agents section', () => {
    const p = prefs();
    expect(classifySidebarDrop(p, dragAgent('/a', UNGROUPED), dropContainer(UNGROUPED))).toEqual({
      kind: 'none',
    });
  });

  it('is a no-op when moving to an unknown group id', () => {
    const p = prefs({ groups: [grp({ id: 'g1' })] });
    expect(
      classifySidebarDrop(p, dragAgent('/a', UNGROUPED), dropContainer(inGroup('missing')))
    ).toEqual({ kind: 'none' });
  });
});

// ---------------------------------------------------------------------------
// Node-data conversion
// ---------------------------------------------------------------------------

describe('node-data conversion', () => {
  it('reads and converts an agent node into drag/drop descriptors', () => {
    const data: SidebarDndData = { type: 'agent', path: '/x', container: inGroup('g1') };
    expect(readSidebarDndData({ ...data, sortable: { index: 0 } })).toEqual(data);
    expect(toDragDescriptor(data)).toEqual({ type: 'agent', path: '/x', from: inGroup('g1') });
    expect(toDropDescriptor(data)).toEqual({
      type: 'agent-item',
      path: '/x',
      container: inGroup('g1'),
    });
  });

  it('treats a container node as a drop target only (never a drag source)', () => {
    const data: SidebarDndData = { type: 'container', container: PINNED };
    expect(toDragDescriptor(data)).toBeNull();
    expect(toDropDescriptor(data)).toEqual({ type: 'container', container: PINNED });
  });

  it('returns null for unrecognized payloads', () => {
    expect(readSidebarDndData(undefined)).toBeNull();
    expect(readSidebarDndData({ type: 'nope' })).toBeNull();
    expect(readSidebarDndData({ type: 'agent', path: 5 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Announcements — one string per operation type
// ---------------------------------------------------------------------------

describe('buildSidebarAnnouncements', () => {
  const names: Record<string, string> = { '/api': 'api-server', '/web': 'web-app' };
  function announcements(p: SidebarPrefs) {
    return buildSidebarAnnouncements(() => ({
      prefs: p,
      agentName: (path) => names[path] ?? path,
      groupName: (id) => p.groups.find((g) => g.id === id)?.name ?? id,
    }));
  }
  const active = (data: SidebarDndData) => ({ active: { data: { current: data } } });
  const over = (data: SidebarDndData) => ({ data: { current: data } });

  it('announces picking up an agent and a group', () => {
    const a = announcements(prefs({ groups: [grp({ id: 'g1', name: 'Clients' })] }));
    expect(a.onDragStart(active({ type: 'agent', path: '/api', container: UNGROUPED }))).toBe(
      'Picked up api-server.'
    );
    expect(a.onDragStart(active({ type: 'group', groupId: 'g1' }))).toBe(
      'Picked up group Clients.'
    );
  });

  it('announces move-to-group with real agent and group names', () => {
    const p = prefs({ groups: [grp({ id: 'g1', name: 'Clients' })] });
    const a = announcements(p);
    const msg = a.onDragEnd({
      ...active({ type: 'agent', path: '/api', container: UNGROUPED }),
      over: over({ type: 'container', container: inGroup('g1') }),
    });
    expect(msg).toBe('Moved api-server to group Clients.');
  });

  it('announces pin, unpin, remove-from-group, and reorder operations distinctly', () => {
    const p = prefs({
      pinned: ['/api', '/web'],
      groups: [
        grp({ id: 'g1', name: 'Clients', sortMode: 'manual', agentPaths: ['/api', '/web'] }),
      ],
    });
    const a = announcements(p);

    // pin
    expect(
      a.onDragEnd({
        ...active({ type: 'agent', path: '/web', container: inGroup('g1') }),
        over: over({ type: 'container', container: PINNED }),
      })
    ).toBe('Pinned web-app.');

    // unpin
    expect(
      a.onDragEnd({
        ...active({ type: 'agent', path: '/api', container: PINNED }),
        over: over({ type: 'container', container: UNGROUPED }),
      })
    ).toBe('Unpinned api-server.');

    // remove-from-group
    expect(
      a.onDragEnd({
        ...active({ type: 'agent', path: '/api', container: inGroup('g1') }),
        over: over({ type: 'container', container: UNGROUPED }),
      })
    ).toBe('Moved api-server to Agents.');

    // reorder within group
    expect(
      a.onDragEnd({
        ...active({ type: 'agent', path: '/api', container: inGroup('g1') }),
        over: over({ type: 'agent', path: '/web', container: inGroup('g1') }),
      })
    ).toBe('Reordered api-server in group Clients.');

    // reorder pinned
    expect(
      a.onDragEnd({
        ...active({ type: 'agent', path: '/web', container: PINNED }),
        over: over({ type: 'agent', path: '/api', container: PINNED }),
      })
    ).toBe('Reordered web-app in Pinned.');
  });

  it('announces a cancelled / no-op drop as returned to place', () => {
    const a = announcements(prefs({ pinned: ['/api'] }));
    expect(a.onDragEnd(active({ type: 'agent', path: '/api', container: PINNED }))).toBe(
      'Movement cancelled. Item returned to its place.'
    );
    expect(a.onDragCancel(active({ type: 'agent', path: '/api', container: PINNED }))).toBe(
      'Movement cancelled. api-server returned to its place.'
    );
  });

  it('announces the hovered container on drag-over', () => {
    const p = prefs({ groups: [grp({ id: 'g1', name: 'Clients' })] });
    const a = announcements(p);
    expect(
      a.onDragOver({
        ...active({ type: 'agent', path: '/api', container: UNGROUPED }),
        over: over({ type: 'group', groupId: 'g1' }),
      })
    ).toBe('Over group Clients.');
  });
});
