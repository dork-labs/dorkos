import { describe, it, expect } from 'vitest';
import type { SidebarPrefs, SidebarGroup, SidebarItemRef } from '@dorkos/shared/config-schema';
import {
  classifySidebarDrop,
  COMPUTED_ZONE_REJECTION,
  resolveSidebarDrop,
  buildSidebarAnnouncements,
  readSidebarDndData,
  toDragDescriptor,
  toDropDescriptor,
  type SidebarContainer,
  type SidebarDragDescriptor,
  type SidebarDropDescriptor,
  type SidebarDndData,
} from '../use-sidebar-dnd';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** An agent member reference. */
const agent = (path: string): SidebarItemRef => ({ kind: 'agent', path });
/** A room member reference — the reducer treats it exactly like an agent. */
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
  return {
    pinned: [],
    groups: [],
    sections: {},
    muted: [],
    gettingStarted: { retired: [] },
    digest: {},
    ...overrides,
  };
}

const PINNED: SidebarContainer = { kind: 'pinned' };
const UNGROUPED: SidebarContainer = { kind: 'ungrouped' };
const inGroup = (groupId: string): SidebarContainer => ({ kind: 'group', groupId });
const TODAY: SidebarContainer = { kind: 'computed', zone: 'today' };
const NOW: SidebarContainer = { kind: 'computed', zone: 'now' };

const dragItem = (ref: SidebarItemRef, from: SidebarContainer): SidebarDragDescriptor => ({
  type: 'item',
  ref,
  from,
});
const dragAgent = (path: string, from: SidebarContainer): SidebarDragDescriptor =>
  dragItem(agent(path), from);
const dragGroup = (groupId: string): SidebarDragDescriptor => ({ type: 'group', groupId });

const dropContainer = (container: SidebarContainer): SidebarDropDescriptor => ({
  type: 'container',
  container,
});
const dropRef = (ref: SidebarItemRef, container: SidebarContainer): SidebarDropDescriptor => ({
  type: 'item',
  ref,
  container,
});
const dropItem = (path: string, container: SidebarContainer): SidebarDropDescriptor =>
  dropRef(agent(path), container);
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
    const p = prefs({ groups: [grp({ id: 'g1', items: [agent('/x')] })] });
    const op = classifySidebarDrop(p, dragAgent('/new', UNGROUPED), dropContainer(inGroup('g1')));
    expect(op).toEqual({
      kind: 'move-to-group',
      ref: agent('/new'),
      groupId: 'g1',
      toIndex: null,
    });
    const next = resolveSidebarDrop(p, dragAgent('/new', UNGROUPED), dropContainer(inGroup('g1')));
    expect(next.groups[0]!.items).toEqual([agent('/x'), agent('/new')]);
  });

  it('moves an agent into a group when dropped on its collapsed header', () => {
    const p = prefs({ groups: [grp({ id: 'g1', collapsed: true, items: [agent('/x')] })] });
    const next = resolveSidebarDrop(p, dragAgent('/new', UNGROUPED), dropHeader('g1'));
    expect(next.groups[0]!.items).toEqual([agent('/x'), agent('/new')]);
  });

  it('uses the drop index when moving into a manual group over a specific row', () => {
    const p = prefs({
      groups: [
        grp({ id: 'g1', sortMode: 'manual', items: [agent('/a'), agent('/b'), agent('/c')] }),
      ],
    });
    const op = classifySidebarDrop(p, dragAgent('/new', UNGROUPED), dropItem('/b', inGroup('g1')));
    expect(op).toEqual({ kind: 'move-to-group', ref: agent('/new'), groupId: 'g1', toIndex: 1 });
    const next = resolveSidebarDrop(p, dragAgent('/new', UNGROUPED), dropItem('/b', inGroup('g1')));
    expect(next.groups[0]!.items).toEqual([agent('/a'), agent('/new'), agent('/b'), agent('/c')]);
  });

  it('appends (ignores drop index) when moving into a non-manual group', () => {
    const p = prefs({
      groups: [grp({ id: 'g1', sortMode: 'name', items: [agent('/a'), agent('/b')] })],
    });
    const op = classifySidebarDrop(p, dragAgent('/new', UNGROUPED), dropItem('/a', inGroup('g1')));
    expect(op).toEqual({
      kind: 'move-to-group',
      ref: agent('/new'),
      groupId: 'g1',
      toIndex: null,
    });
    const next = resolveSidebarDrop(p, dragAgent('/new', UNGROUPED), dropItem('/a', inGroup('g1')));
    expect(next.groups[0]!.items).toEqual([agent('/a'), agent('/b'), agent('/new')]);
  });

  it('pins an agent (reference; home membership unchanged) when dropped on Pinned', () => {
    const p = prefs({ groups: [grp({ id: 'g1', items: [agent('/x')] })] });
    const op = classifySidebarDrop(p, dragAgent('/x', inGroup('g1')), dropContainer(PINNED));
    expect(op).toEqual({ kind: 'pin', ref: agent('/x') });
    const next = resolveSidebarDrop(p, dragAgent('/x', inGroup('g1')), dropContainer(PINNED));
    expect(next.pinned).toEqual([agent('/x')]);
    expect(next.groups[0]!.items).toEqual([agent('/x')]); // still in its home group
  });

  it('reorders within a manual group when a member drops over a sibling', () => {
    const p = prefs({
      groups: [
        grp({ id: 'g1', sortMode: 'manual', items: [agent('/a'), agent('/b'), agent('/c')] }),
      ],
    });
    const op = classifySidebarDrop(
      p,
      dragAgent('/a', inGroup('g1')),
      dropItem('/c', inGroup('g1'))
    );
    expect(op).toEqual({
      kind: 'reorder-within-group',
      groupId: 'g1',
      ref: agent('/a'),
      from: 0,
      to: 2,
    });
    const next = resolveSidebarDrop(
      p,
      dragAgent('/a', inGroup('g1')),
      dropItem('/c', inGroup('g1'))
    );
    expect(next.groups[0]!.items).toEqual([agent('/b'), agent('/c'), agent('/a')]);
  });

  it('does NOT reorder within a name/recent group (sort mode owns order)', () => {
    const p = prefs({
      groups: [grp({ id: 'g1', sortMode: 'name', items: [agent('/a'), agent('/b')] })],
    });
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
    const p = prefs({ pinned: [agent('/a'), agent('/b'), agent('/c')] });
    const op = classifySidebarDrop(p, dragAgent('/c', PINNED), dropItem('/a', PINNED));
    expect(op).toEqual({ kind: 'reorder-pinned', ref: agent('/c'), from: 2, to: 0 });
    const next = resolveSidebarDrop(p, dragAgent('/c', PINNED), dropItem('/a', PINNED));
    expect(next.pinned).toEqual([agent('/c'), agent('/a'), agent('/b')]);
  });

  it('unpins when a pinned row is dropped anywhere outside Pinned (home untouched)', () => {
    const p = prefs({ pinned: [agent('/a')], groups: [grp({ id: 'g1', items: [agent('/a')] })] });
    const op = classifySidebarDrop(p, dragAgent('/a', PINNED), dropContainer(UNGROUPED));
    expect(op).toEqual({ kind: 'unpin', ref: agent('/a') });
    const next = resolveSidebarDrop(p, dragAgent('/a', PINNED), dropContainer(UNGROUPED));
    expect(next.pinned).toEqual([]);
    expect(next.groups[0]!.items).toEqual([agent('/a')]); // membership untouched
  });

  it('removes an agent from its group when dropped on the Agents (ungrouped) section', () => {
    const p = prefs({ groups: [grp({ id: 'g1', items: [agent('/a'), agent('/b')] })] });
    const op = classifySidebarDrop(p, dragAgent('/a', inGroup('g1')), dropContainer(UNGROUPED));
    expect(op).toEqual({ kind: 'remove-from-group', ref: agent('/a') });
    const next = resolveSidebarDrop(p, dragAgent('/a', inGroup('g1')), dropContainer(UNGROUPED));
    expect(next.groups[0]!.items).toEqual([agent('/b')]);
  });

  it('moves an agent between two groups (disjointness preserved)', () => {
    const p = prefs({
      groups: [grp({ id: 'g1', items: [agent('/a')] }), grp({ id: 'g2', items: [agent('/b')] })],
    });
    const next = resolveSidebarDrop(
      p,
      dragAgent('/a', inGroup('g1')),
      dropContainer(inGroup('g2'))
    );
    expect(next.groups[0]!.items).toEqual([]);
    expect(next.groups[1]!.items).toEqual([agent('/b'), agent('/a')]);
  });

  // ── The union: a room moves through the same table, on the same rules ──

  it('moves a room into a manual group at the hovered index, beside an agent', () => {
    const p = prefs({
      groups: [grp({ id: 'g1', sortMode: 'manual', items: [agent('/a'), agent('/b')] })],
    });
    const op = classifySidebarDrop(
      p,
      dragItem(room('room-1'), UNGROUPED),
      dropItem('/b', inGroup('g1'))
    );
    expect(op).toEqual({ kind: 'move-to-group', ref: room('room-1'), groupId: 'g1', toIndex: 1 });
    const next = resolveSidebarDrop(
      p,
      dragItem(room('room-1'), UNGROUPED),
      dropItem('/b', inGroup('g1'))
    );
    expect(next.groups[0]!.items).toEqual([agent('/a'), room('room-1'), agent('/b')]);
  });

  it('reorders a room within a manual group when dropped over an agent sibling', () => {
    const p = prefs({
      groups: [grp({ id: 'g1', sortMode: 'manual', items: [room('room-1'), agent('/b')] })],
    });
    const op = classifySidebarDrop(
      p,
      dragItem(room('room-1'), inGroup('g1')),
      dropRef(agent('/b'), inGroup('g1'))
    );
    expect(op).toEqual({
      kind: 'reorder-within-group',
      groupId: 'g1',
      ref: room('room-1'),
      from: 0,
      to: 1,
    });
    const next = resolveSidebarDrop(
      p,
      dragItem(room('room-1'), inGroup('g1')),
      dropRef(agent('/b'), inGroup('g1'))
    );
    expect(next.groups[0]!.items).toEqual([agent('/b'), room('room-1')]);
  });

  // ── No-op and unknown-target cases ──

  it('is a no-op when a member drops onto its own position in a manual group', () => {
    const p = prefs({
      groups: [grp({ id: 'g1', sortMode: 'manual', items: [agent('/a'), agent('/b')] })],
    });
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
    const p = prefs({ pinned: [agent('/a')] });
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

  // ── Smart groups reject drops (smart-agent-groups, DOR-338) ──

  const smartGrp = (overrides: Partial<SidebarGroup> = {}): SidebarGroup =>
    grp({ kind: 'smart', sortMode: 'recent', rules: { statuses: ['active'] }, ...overrides });

  it('rejects (does not mutate) an agent dropped on a smart group body from Agents', () => {
    const p = prefs({ groups: [smartGrp({ id: 'g1' })] });
    const op = classifySidebarDrop(p, dragAgent('/new', UNGROUPED), dropContainer(inGroup('g1')));
    expect(op).toEqual({ kind: 'reject-smart-group', groupId: 'g1', ref: agent('/new') });
    expect(resolveSidebarDrop(p, dragAgent('/new', UNGROUPED), dropContainer(inGroup('g1')))).toBe(
      p
    );
  });

  it('rejects an agent dropped on a smart group’s (collapsed) header', () => {
    const p = prefs({ groups: [smartGrp({ id: 'g1', collapsed: true })] });
    const op = classifySidebarDrop(p, dragAgent('/new', UNGROUPED), dropHeader('g1'));
    expect(op).toEqual({ kind: 'reject-smart-group', groupId: 'g1', ref: agent('/new') });
  });

  it('rejects a ROOM dropped on a smart group through the same no-op path', () => {
    const p = prefs({ groups: [smartGrp({ id: 'g1' })] });
    const op = classifySidebarDrop(
      p,
      dragItem(room('room-1'), UNGROUPED),
      dropContainer(inGroup('g1'))
    );
    expect(op).toEqual({ kind: 'reject-smart-group', groupId: 'g1', ref: room('room-1') });
    expect(
      resolveSidebarDrop(p, dragItem(room('room-1'), UNGROUPED), dropContainer(inGroup('g1')))
    ).toBe(p);
  });

  it('rejects an agent dragged from a manual group onto a smart group', () => {
    const p = prefs({
      groups: [grp({ id: 'manual1', items: [agent('/a')] }), smartGrp({ id: 'smart1' })],
    });
    const op = classifySidebarDrop(
      p,
      dragAgent('/a', inGroup('manual1')),
      dropContainer(inGroup('smart1'))
    );
    expect(op).toEqual({ kind: 'reject-smart-group', groupId: 'smart1', ref: agent('/a') });
    const next = resolveSidebarDrop(
      p,
      dragAgent('/a', inGroup('manual1')),
      dropContainer(inGroup('smart1'))
    );
    expect(next.groups[0]!.items).toEqual([agent('/a')]); // untouched — the drop was rejected
  });

  it('still allows reordering a smart group’s own header among other sections', () => {
    const p = prefs({ groups: [smartGrp({ id: 'a' }), grp({ id: 'b' }), grp({ id: 'c' })] });
    const op = classifySidebarDrop(p, dragGroup('a'), dropHeader('c'));
    expect(op).toEqual({ kind: 'reorder-group', groupId: 'a', from: 0, to: 2 });
  });
});

// ---------------------------------------------------------------------------
// Node-data conversion
// ---------------------------------------------------------------------------

describe('node-data conversion', () => {
  it('reads and converts an item node into drag/drop descriptors', () => {
    const data: SidebarDndData = { type: 'item', ref: agent('/x'), container: inGroup('g1') };
    expect(readSidebarDndData({ ...data, sortable: { index: 0 } })).toEqual(data);
    expect(toDragDescriptor(data)).toEqual({
      type: 'item',
      ref: agent('/x'),
      from: inGroup('g1'),
    });
    expect(toDropDescriptor(data)).toEqual({
      type: 'item',
      ref: agent('/x'),
      container: inGroup('g1'),
    });
  });

  it('reads a room item node the same way', () => {
    const data: SidebarDndData = { type: 'item', ref: room('room-1'), container: PINNED };
    expect(readSidebarDndData({ ...data, sortable: { index: 2 } })).toEqual(data);
    expect(toDragDescriptor(data)).toEqual({ type: 'item', ref: room('room-1'), from: PINNED });
  });

  it('treats a container node as a drop target only (never a drag source)', () => {
    const data: SidebarDndData = { type: 'container', container: PINNED };
    expect(toDragDescriptor(data)).toBeNull();
    expect(toDropDescriptor(data)).toEqual({ type: 'container', container: PINNED });
  });

  it('returns null for unrecognized payloads', () => {
    expect(readSidebarDndData(undefined)).toBeNull();
    expect(readSidebarDndData({ type: 'nope' })).toBeNull();
    // A malformed ref (wrong payload field for its kind) is not a ref.
    expect(
      readSidebarDndData({ type: 'item', ref: { kind: 'agent', path: 5 }, container: PINNED })
    ).toBeNull();
    expect(
      readSidebarDndData({ type: 'item', ref: { kind: 'room', path: '/x' }, container: PINNED })
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Announcements — one string per operation type
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// R3 — Library is the only place a row can be put
// ---------------------------------------------------------------------------

describe('R3 — a drop into a computed zone', () => {
  it('is rejected wherever the row came from', () => {
    const p = prefs({
      pinned: [agent('/api')],
      groups: [grp({ id: 'g1', items: [agent('/web')] })],
    });
    for (const drag of [
      dragAgent('/api', PINNED),
      dragAgent('/web', inGroup('g1')),
      dragAgent('/other', UNGROUPED),
    ]) {
      expect(classifySidebarDrop(p, drag, dropContainer(TODAY)).kind).toBe('reject-computed-zone');
      expect(classifySidebarDrop(p, drag, dropContainer(NOW)).kind).toBe('reject-computed-zone');
    }
  });

  it('is rejected when the drop lands on a ROW in the zone, not only its body', () => {
    const p = prefs({ pinned: [agent('/api')] });
    const op = classifySidebarDrop(p, dragAgent('/api', PINNED), dropItem('/other', TODAY));
    expect(op).toEqual({ kind: 'reject-computed-zone', ref: agent('/api') });
  });

  it('changes nothing — a pinned row dropped in Today stays pinned', () => {
    // The unpin branch is one line away in the same function: a pinned row
    // dropped on any NON-pinned container unpins. If the rejection were placed
    // after it, this drop would silently unpin the row instead of saying no.
    const p = prefs({ pinned: [agent('/api')] });
    const next = resolveSidebarDrop(p, dragAgent('/api', PINNED), dropContainer(TODAY));
    expect(next).toBe(p);
    expect(next.pinned).toEqual([agent('/api')]);
  });

  it('says how to keep the row in place, rather than only refusing', () => {
    expect(COMPUTED_ZONE_REJECTION).toBe(
      'Heads up and Today are computed. Pin it to Library to keep it in place.'
    );
  });

  it('reads a computed container back off a node payload, and rejects a malformed one', () => {
    expect(readSidebarDndData({ type: 'container', container: TODAY })).toEqual({
      type: 'container',
      container: TODAY,
    });
    expect(readSidebarDndData({ type: 'container', container: { kind: 'computed' } })).toBeNull();
    expect(
      readSidebarDndData({ type: 'container', container: { kind: 'computed', zone: 'library' } })
    ).toBeNull();
  });

  it('leaves every Library drop the table already covered untouched', () => {
    // The whole point of putting the check where it is: the existing semantics
    // gain a case and lose none.
    const p = prefs({ pinned: [agent('/api')], groups: [grp({ id: 'g1' })] });
    expect(classifySidebarDrop(p, dragAgent('/x', UNGROUPED), dropContainer(PINNED)).kind).toBe(
      'pin'
    );
    expect(classifySidebarDrop(p, dragAgent('/api', PINNED), dropContainer(UNGROUPED)).kind).toBe(
      'unpin'
    );
    expect(
      classifySidebarDrop(p, dragAgent('/x', UNGROUPED), dropContainer(inGroup('g1'))).kind
    ).toBe('move-to-group');
  });
});

describe('buildSidebarAnnouncements', () => {
  const names: Record<string, string> = { '/api': 'api-server', '/web': 'web-app' };
  function announcements(p: SidebarPrefs) {
    return buildSidebarAnnouncements(() => ({
      prefs: p,
      itemName: (ref) => (ref.kind === 'agent' ? (names[ref.path] ?? ref.path) : `#${ref.roomId}`),
      groupName: (id) => p.groups.find((g) => g.id === id)?.name ?? id,
    }));
  }
  const active = (data: SidebarDndData) => ({ active: { data: { current: data } } });
  const over = (data: SidebarDndData) => ({ data: { current: data } });
  const agentNode = (path: string, container: SidebarContainer): SidebarDndData => ({
    type: 'item',
    ref: agent(path),
    container,
  });

  it('announces picking up an agent and a group', () => {
    const a = announcements(prefs({ groups: [grp({ id: 'g1', name: 'Clients' })] }));
    expect(a.onDragStart(active(agentNode('/api', UNGROUPED)))).toBe('Picked up api-server.');
    expect(a.onDragStart(active({ type: 'group', groupId: 'g1' }))).toBe(
      'Picked up section Clients.'
    );
  });

  it('announces move-to-group with real agent and group names', () => {
    const p = prefs({ groups: [grp({ id: 'g1', name: 'Clients' })] });
    const a = announcements(p);
    const msg = a.onDragEnd({
      ...active(agentNode('/api', UNGROUPED)),
      over: over({ type: 'container', container: inGroup('g1') }),
    });
    expect(msg).toBe('Moved api-server to Clients.');
  });

  it('announces the ungrouped section actually under the cursor, not always Agents', () => {
    // Rooms drag out of a group into Channels or Direct messages (DOR-581), and
    // all three are the same `ungrouped` container to the reducer — only the
    // announcement can tell them apart, so it carries the name.
    const a = announcements(prefs());
    const node: SidebarDndData = { type: 'item', ref: room('room-1'), container: UNGROUPED };
    expect(
      a.onDragOver({
        active: active(node).active,
        over: over({ type: 'container', container: { kind: 'ungrouped', section: 'channels' } }),
      })
    ).toBe('Over Channels.');
    // No name stored: the Agents section, which is what `ungrouped` used to be.
    expect(
      a.onDragOver({
        active: active(node).active,
        over: over({ type: 'container', container: UNGROUPED }),
      })
    ).toBe('Over Agents.');
  });

  it('names a ROOM as the subject when a room is what moved', () => {
    const p = prefs({ groups: [grp({ id: 'g1', name: 'Clients' })] });
    const a = announcements(p);
    const node: SidebarDndData = { type: 'item', ref: room('room-1'), container: UNGROUPED };
    expect(a.onDragStart(active(node))).toBe('Picked up #room-1.');
    expect(
      a.onDragEnd({
        ...active(node),
        over: over({ type: 'container', container: inGroup('g1') }),
      })
    ).toBe('Moved #room-1 to Clients.');
  });

  it('announces pin, unpin, remove-from-group, and reorder operations distinctly', () => {
    const p = prefs({
      pinned: [agent('/api'), agent('/web')],
      groups: [
        grp({
          id: 'g1',
          name: 'Clients',
          sortMode: 'manual',
          items: [agent('/api'), agent('/web')],
        }),
      ],
    });
    const a = announcements(p);

    // pin
    expect(
      a.onDragEnd({
        ...active(agentNode('/web', inGroup('g1'))),
        over: over({ type: 'container', container: PINNED }),
      })
    ).toBe('Pinned web-app.');

    // unpin
    expect(
      a.onDragEnd({
        ...active(agentNode('/api', PINNED)),
        over: over({ type: 'container', container: UNGROUPED }),
      })
    ).toBe('Unpinned api-server.');

    // remove-from-group
    expect(
      a.onDragEnd({
        ...active(agentNode('/api', inGroup('g1'))),
        over: over({ type: 'container', container: UNGROUPED }),
      })
    ).toBe('Moved api-server out of its section.');

    // reorder within group
    expect(
      a.onDragEnd({
        ...active(agentNode('/api', inGroup('g1'))),
        over: over(agentNode('/web', inGroup('g1'))),
      })
    ).toBe('Reordered api-server in Clients.');

    // reorder pinned
    expect(
      a.onDragEnd({
        ...active(agentNode('/web', PINNED)),
        over: over(agentNode('/api', PINNED)),
      })
    ).toBe('Reordered web-app in Pinned.');
  });

  it('announces a cancelled / no-op drop as returned to place', () => {
    const a = announcements(prefs({ pinned: [agent('/api')] }));
    expect(a.onDragEnd(active(agentNode('/api', PINNED)))).toBe(
      'Movement cancelled. Item returned to its place.'
    );
    expect(a.onDragCancel(active(agentNode('/api', PINNED)))).toBe(
      'Movement cancelled. api-server returned to its place.'
    );
  });

  it('announces a rejected drop onto a smart group distinctly', () => {
    const p = prefs({
      groups: [
        grp({ id: 'g1', kind: 'smart', sortMode: 'recent', rules: { statuses: ['active'] } }),
      ],
    });
    const a = announcements(p);
    const msg = a.onDragEnd({
      ...active(agentNode('/api', UNGROUPED)),
      over: over({ type: 'container', container: inGroup('g1') }),
    });
    expect(msg).toBe(
      "Can't move api-server into Clients. Membership is rule-based. Edit rules instead."
    );
  });

  it('announces a rejected drop into a computed zone with the same sentence as the toast', () => {
    const a = announcements(prefs({ pinned: [agent('/api')] }));
    expect(
      a.onDragEnd({
        ...active(agentNode('/api', PINNED)),
        over: over({ type: 'container', container: { kind: 'computed', zone: 'today' } }),
      })
    ).toBe(`Can't move api-server there. ${COMPUTED_ZONE_REJECTION}`);
  });

  it('names Heads up and Today on drag-over', () => {
    const a = announcements(prefs());
    const hover = (zone: 'now' | 'today') =>
      a.onDragOver({
        ...active(agentNode('/api', UNGROUPED)),
        over: over({ type: 'container', container: { kind: 'computed', zone } }),
      });
    expect(hover('today')).toBe('Over Today.');
    expect(hover('now')).toBe('Over Heads up.');
  });

  it('announces the hovered container on drag-over', () => {
    const p = prefs({ groups: [grp({ id: 'g1', name: 'Clients' })] });
    const a = announcements(p);
    expect(
      a.onDragOver({
        ...active(agentNode('/api', UNGROUPED)),
        over: over({ type: 'group', groupId: 'g1' }),
      })
    ).toBe('Over Clients.');
  });
});
