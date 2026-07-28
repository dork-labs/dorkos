import { describe, it, expect } from 'vitest';
import type { AttentionState } from '@/layers/entities/session';
import type { SidebarItem } from '../sidebar-item';
import { filterSidebarItems, type FilterSidebarItemsOptions } from '../filter-sidebar-items';

function agent(name: string, attention: AttentionState, muted = false): SidebarItem {
  return {
    ref: { kind: 'agent', path: `/${name}` },
    name,
    lastActiveAt: null,
    attention,
    muted,
    visual: { kind: 'identity', visual: { color: '#000', emoji: 'x' } },
  };
}

function roomItem(name: string, attention: AttentionState, muted = false): SidebarItem {
  return {
    ref: { kind: 'room', roomId: name },
    name,
    lastActiveAt: null,
    attention,
    muted,
    visual: { kind: 'sigil' },
  };
}

const A = agent('a', 'needs-attention');
const B = agent('b', 'active');
const C = agent('c', 'idle');
const D = agent('d', 'inactive');
const ITEMS = [A, B, C, D];

const names = (items: SidebarItem[]) => items.map((i) => i.name);

function opts(overrides: Partial<FilterSidebarItemsOptions> = {}): FilterSidebarItemsOptions {
  return { filter: 'all', groupMuted: false, ...overrides };
}

describe('filterSidebarItems', () => {
  describe("filter: 'all'", () => {
    it('shows everything except inactive members, collapsing them into the inactive row', () => {
      const result = filterSidebarItems(ITEMS, opts({ filter: 'all' }));
      expect(names(result.visible)).toEqual(['a', 'b', 'c']);
      expect(result.filteredOut).toEqual([]);
      expect(names(result.inactive)).toEqual(['d']);
    });

    it('keeps a fresh (never-active) agent visible, not collapsed under the inactive row', () => {
      const result = filterSidebarItems([agent('f', 'fresh'), D], opts({ filter: 'all' }));
      expect(names(result.visible)).toEqual(['f']);
      expect(names(result.inactive)).toEqual(['d']);
    });

    it('the inactive row is empty when nothing is inactive', () => {
      expect(filterSidebarItems([A, B, C], opts({ filter: 'all' })).inactive).toEqual([]);
    });
  });

  describe("filter: 'active'", () => {
    it('keeps needs-attention + active, hides idle + inactive as filteredOut', () => {
      const result = filterSidebarItems(ITEMS, opts({ filter: 'active' }));
      expect(names(result.visible)).toEqual(['a', 'b']);
      expect(names(result.filteredOut)).toEqual(['c', 'd']);
      expect(result.inactive).toEqual([]); // subsumed by filteredOut, never populated
    });
  });

  describe("filter: 'attention'", () => {
    it('keeps only unmuted needs-attention members', () => {
      const result = filterSidebarItems(ITEMS, opts({ filter: 'attention' }));
      expect(names(result.visible)).toEqual(['a']);
      expect(names(result.filteredOut)).toEqual(['b', 'c', 'd']);
      expect(result.inactive).toEqual([]);
    });
  });

  describe('mute downgrade — the ONE place mute semantics live', () => {
    const mutedA = agent('a', 'needs-attention', true);

    it("a muted item's needs-attention is capped at active under 'all' (still visible, never inactive)", () => {
      const result = filterSidebarItems([mutedA], opts({ filter: 'all' }));
      expect(names(result.visible)).toEqual(['a']);
      expect(result.inactive).toEqual([]);
    });

    it("a muted item's needs-attention downgrades to active, so it still qualifies under 'active'", () => {
      const result = filterSidebarItems([mutedA], opts({ filter: 'active' }));
      expect(names(result.visible)).toEqual(['a']);
      expect(result.filteredOut).toEqual([]);
    });

    it("a muted item's needs-attention never surfaces under 'attention'", () => {
      const result = filterSidebarItems([mutedA], opts({ filter: 'attention' }));
      expect(result.visible).toEqual([]);
      expect(names(result.filteredOut)).toEqual(['a']);
    });

    it('groupMuted downgrades every member the same way an item’s own mute does', () => {
      const result = filterSidebarItems([A], opts({ filter: 'attention', groupMuted: true }));
      expect(result.visible).toEqual([]);
      expect(names(result.filteredOut)).toEqual(['a']);
    });

    it('mute does not affect an already-active or already-idle item (nothing to downgrade)', () => {
      const result = filterSidebarItems(
        [agent('b', 'active', true), agent('c', 'idle', true)],
        opts({ filter: 'all' })
      );
      expect(names(result.visible)).toEqual(['b', 'c']);
      expect(result.inactive).toEqual([]);
    });
  });

  describe('rooms filter with no rule of their own', () => {
    it('an unread room survives the attention filter and a read one does not', () => {
      const result = filterSidebarItems(
        [roomItem('#loud', 'needs-attention'), roomItem('#quiet', 'active')],
        opts({ filter: 'attention' })
      );
      expect(names(result.visible)).toEqual(['#loud']);
      expect(names(result.filteredOut)).toEqual(['#quiet']);
    });

    it('a muted room’s unread never surfaces under the attention filter', () => {
      const result = filterSidebarItems(
        [roomItem('#loud', 'needs-attention', true)],
        opts({ filter: 'attention' })
      );
      expect(result.visible).toEqual([]);
    });

    it('no room can reach the "N inactive agents" bucket, whatever the filter', () => {
      // The invariant `RevealRow`'s wording rests on: `roomSidebarItem` never
      // produces `inactive`, so that bucket is agents by construction.
      for (const filter of ['all', 'active', 'attention'] as const) {
        const result = filterSidebarItems(
          [roomItem('#quiet', 'active'), roomItem('#loud', 'needs-attention'), D],
          opts({ filter })
        );
        expect(names(result.inactive).filter((n) => n.startsWith('#'))).toEqual([]);
      }
    });
  });

  describe('edge cases', () => {
    it('empty input yields empty everything', () => {
      expect(filterSidebarItems([], opts())).toEqual({
        visible: [],
        filteredOut: [],
        inactive: [],
      });
    });

    it('preserves input order within each bucket', () => {
      const result = filterSidebarItems([D, B, A, C], opts({ filter: 'all' }));
      expect(names(result.visible)).toEqual(['b', 'a', 'c']);
      expect(names(result.inactive)).toEqual(['d']);
    });

    it('never mutates the input array', () => {
      const input = [...ITEMS];
      filterSidebarItems(input, opts({ filter: 'active' }));
      expect(input).toEqual(ITEMS);
    });
  });
});
