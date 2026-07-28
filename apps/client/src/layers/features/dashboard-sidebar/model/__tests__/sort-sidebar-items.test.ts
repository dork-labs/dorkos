import { describe, it, expect } from 'vitest';
import type { SidebarItem } from '../sidebar-item';
import { sortSidebarItems } from '../sort-sidebar-items';

/** Epoch ms for an ISO instant, which is what the view model carries. */
const at = (iso: string) => Date.parse(iso);

function agent(name: string, lastActiveAt: number | null = null, path = `/p/${name}`): SidebarItem {
  return {
    ref: { kind: 'agent', path },
    name,
    lastActiveAt,
    attention: 'active',
    muted: false,
    visual: { kind: 'identity', visual: { color: '#000', emoji: 'x' } },
  };
}

function roomItem(name: string, lastActiveAt: number | null = null, roomId = name): SidebarItem {
  return {
    ref: { kind: 'room', roomId },
    name,
    lastActiveAt,
    attention: 'active',
    muted: false,
    visual: { kind: 'sigil' },
  };
}

const names = (items: SidebarItem[]) => items.map((i) => i.name);

const ZEBRA = agent('Zebra', at('2026-07-16T10:00:00.000Z'));
const ALPHA = agent('Alpha', at('2026-07-16T12:00:00.000Z'));
const MIDDLE = agent('Middle');

describe('sortSidebarItems', () => {
  it('manual returns input order unchanged', () => {
    const input = [ZEBRA, ALPHA, MIDDLE];
    expect(names(sortSidebarItems(input, 'manual'))).toEqual(['Zebra', 'Alpha', 'Middle']);
  });

  it('name sorts alphabetically by the item’s own name', () => {
    expect(names(sortSidebarItems([ZEBRA, ALPHA, MIDDLE], 'name'))).toEqual([
      'Alpha',
      'Middle',
      'Zebra',
    ]);
  });

  it('recent sorts by last activity, most recent first', () => {
    expect(names(sortSidebarItems([ZEBRA, ALPHA], 'recent'))).toEqual(['Alpha', 'Zebra']);
  });

  it('recent puts items that have never been active last', () => {
    expect(names(sortSidebarItems([MIDDLE, ZEBRA, ALPHA], 'recent'))).toEqual([
      'Alpha',
      'Zebra',
      'Middle',
    ]);
  });

  it('recent breaks equal timestamps by name', () => {
    const t = at('2026-07-16T10:00:00.000Z');
    expect(names(sortSidebarItems([agent('Zebra', t), agent('Alpha', t)], 'recent'))).toEqual([
      'Alpha',
      'Zebra',
    ]);
  });

  it('recent breaks both-missing timestamps by name', () => {
    expect(
      names(sortSidebarItems([agent('Zebra'), agent('Alpha'), agent('Middle')], 'recent'))
    ).toEqual(['Alpha', 'Middle', 'Zebra']);
  });

  it('never mutates its input and returns a new array', () => {
    const input = [ZEBRA, ALPHA, MIDDLE];
    const copy = [...input];
    const out = sortSidebarItems(input, 'name');
    expect(input).toEqual(copy);
    expect(out).not.toBe(input);
  });

  describe('a mixed group (sidebar-groups §6)', () => {
    it('orders agents and rooms together by name, not kind by kind', () => {
      const items = [agent('Zebra'), roomItem('#backend'), agent('Alpha'), roomItem('#ship')];
      expect(names(sortSidebarItems(items, 'name'))).toEqual([
        '#backend',
        '#ship',
        'Alpha',
        'Zebra',
      ]);
    });

    it('orders agents and rooms together by recency', () => {
      const items = [
        agent('Alpha', at('2026-07-16T09:00:00.000Z')),
        roomItem('#ship', at('2026-07-16T12:00:00.000Z')),
        agent('Zebra', at('2026-07-16T11:00:00.000Z')),
      ];
      expect(names(sortSidebarItems(items, 'recent'))).toEqual(['#ship', 'Zebra', 'Alpha']);
    });

    it('breaks an agent/room tie on lastActiveAt the same way every time, whatever order it is given', () => {
      // The tie the spec names: an agent and a room active at the same instant.
      // An unstable answer here reshuffles the group under the pointer, because
      // this array is rebuilt from prefs and two queries on every render.
      const t = at('2026-07-16T10:00:00.000Z');
      const forwards = sortSidebarItems(
        [agent('Ship', t, '/p/ship'), roomItem('Ship', t)],
        'recent'
      );
      const backwards = sortSidebarItems(
        [roomItem('Ship', t), agent('Ship', t, '/p/ship')],
        'recent'
      );
      expect(forwards.map((i) => i.ref)).toEqual(backwards.map((i) => i.ref));
      // And the tiebreak is the one the module documents: kind first.
      expect(forwards[0]!.ref.kind).toBe('agent');
    });

    it('breaks a same-kind tie on both name and activity by the reference itself', () => {
      const t = at('2026-07-16T10:00:00.000Z');
      const forwards = sortSidebarItems(
        [roomItem('Ship', t, 'r2'), roomItem('Ship', t, 'r1')],
        'recent'
      );
      const backwards = sortSidebarItems(
        [roomItem('Ship', t, 'r1'), roomItem('Ship', t, 'r2')],
        'recent'
      );
      expect(forwards.map((i) => i.ref)).toEqual(backwards.map((i) => i.ref));
      expect(forwards.map((i) => i.ref)).toEqual([
        { kind: 'room', roomId: 'r1' },
        { kind: 'room', roomId: 'r2' },
      ]);
    });
  });
});
