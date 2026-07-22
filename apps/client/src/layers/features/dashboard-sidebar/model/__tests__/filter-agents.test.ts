import { describe, it, expect } from 'vitest';
import type { AttentionState } from '@/layers/entities/session';
import { filterSectionAgents, type FilterSectionAgentsOptions } from '../filter-agents';

const A = '/a'; // needs-attention
const B = '/b'; // active
const C = '/c'; // idle
const D = '/d'; // inactive

const ATTENTION: Record<string, AttentionState> = {
  [A]: 'needs-attention',
  [B]: 'active',
  [C]: 'idle',
  [D]: 'inactive',
};

const AGENTS = [A, B, C, D];

function opts(overrides: Partial<FilterSectionAgentsOptions> = {}): FilterSectionAgentsOptions {
  return {
    filter: 'all',
    attention: ATTENTION,
    mutedPaths: new Set(),
    groupMuted: false,
    ...overrides,
  };
}

describe('filterSectionAgents', () => {
  describe("filter: 'all'", () => {
    it('shows everything except inactive-state members, collapsing them into the inactive row', () => {
      const result = filterSectionAgents(AGENTS, opts({ filter: 'all' }));
      expect(result.visible).toEqual([A, B, C]);
      expect(result.filteredOut).toEqual([]);
      expect(result.inactive).toEqual([D]);
    });

    it('keeps a fresh (never-active) agent visible, not collapsed under the inactive row', () => {
      const F = '/f'; // fresh — a brand-new agent
      const result = filterSectionAgents([F, D], {
        ...opts({ filter: 'all' }),
        attention: { [F]: 'fresh', [D]: 'inactive' },
      });
      expect(result.visible).toEqual([F]);
      expect(result.inactive).toEqual([D]);
    });

    it('the inactive row is empty when nothing is inactive', () => {
      const result = filterSectionAgents([A, B, C], opts({ filter: 'all' }));
      expect(result.inactive).toEqual([]);
    });
  });

  describe("filter: 'active'", () => {
    it('keeps needs-attention + active, hides idle + inactive as filteredOut', () => {
      const result = filterSectionAgents(AGENTS, opts({ filter: 'active' }));
      expect(result.visible).toEqual([A, B]);
      expect(result.filteredOut).toEqual([C, D]);
      expect(result.inactive).toEqual([]); // subsumed by filteredOut, never populated
    });
  });

  describe("filter: 'attention'", () => {
    it('keeps only unmuted needs-attention members', () => {
      const result = filterSectionAgents(AGENTS, opts({ filter: 'attention' }));
      expect(result.visible).toEqual([A]);
      expect(result.filteredOut).toEqual([B, C, D]);
      expect(result.inactive).toEqual([]);
    });
  });

  describe('mute downgrade — the ONE place mute semantics live', () => {
    it("a muted agent's needs-attention is capped at active under filter 'all' (still visible, never inactive)", () => {
      const result = filterSectionAgents([A], opts({ filter: 'all', mutedPaths: new Set([A]) }));
      expect(result.visible).toEqual([A]);
      expect(result.inactive).toEqual([]);
    });

    it("a muted agent's needs-attention downgrades to active, so it still qualifies under filter 'active'", () => {
      const result = filterSectionAgents([A], opts({ filter: 'active', mutedPaths: new Set([A]) }));
      expect(result.visible).toEqual([A]);
      expect(result.filteredOut).toEqual([]);
    });

    it("a muted agent's needs-attention never surfaces under filter 'attention' (mute suppresses the signal)", () => {
      const result = filterSectionAgents(
        [A],
        opts({ filter: 'attention', mutedPaths: new Set([A]) })
      );
      expect(result.visible).toEqual([]);
      expect(result.filteredOut).toEqual([A]);
    });

    it('groupMuted downgrades every member the same way individual mute does', () => {
      const result = filterSectionAgents([A], opts({ filter: 'attention', groupMuted: true }));
      expect(result.visible).toEqual([]);
      expect(result.filteredOut).toEqual([A]);
    });

    it('mute does not affect an already-active or already-idle agent (nothing to downgrade)', () => {
      const result = filterSectionAgents(
        [B, C],
        opts({ filter: 'all', mutedPaths: new Set([B, C]) })
      );
      expect(result.visible).toEqual([B, C]);
      expect(result.inactive).toEqual([]);
    });
  });

  describe('edge cases', () => {
    it('empty input yields empty everything', () => {
      const result = filterSectionAgents([], opts());
      expect(result).toEqual({ visible: [], filteredOut: [], inactive: [] });
    });

    it('a path missing from the attention map defaults to inactive', () => {
      const result = filterSectionAgents(['/unknown'], opts({ filter: 'all' }));
      expect(result.inactive).toEqual(['/unknown']);
    });

    it('preserves input order within each bucket', () => {
      const result = filterSectionAgents([D, B, A, C], opts({ filter: 'all' }));
      expect(result.visible).toEqual([B, A, C]);
      expect(result.inactive).toEqual([D]);
    });

    it('never mutates the input array', () => {
      const input = [...AGENTS];
      filterSectionAgents(input, opts({ filter: 'active' }));
      expect(input).toEqual(AGENTS);
    });
  });
});
