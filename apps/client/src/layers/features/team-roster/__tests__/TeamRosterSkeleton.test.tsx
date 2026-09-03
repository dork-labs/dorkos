/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TeamRosterSkeleton } from '../ui/TeamRosterSkeleton';
import { TEAM_ROSTER_GRID } from '../ui/TeamRosterGrid';

describe('TeamRosterSkeleton', () => {
  it('lays its cards out in the same grid TeamRosterGrid uses', () => {
    // The whole point of a skeleton: mirror the real layout's geometry so
    // nothing jumps when the real roster replaces it (batch 06, finding 6.5).
    const { container } = render(<TeamRosterSkeleton />);
    const grid = container.firstElementChild;
    expect(grid).not.toBeNull();
    for (const cls of TEAM_ROSTER_GRID.split(' ')) {
      expect(grid!.className).toContain(cls);
    }
  });

  it('announces itself as loading the team, matching the state it replaces', () => {
    render(<TeamRosterSkeleton />);
    expect(screen.getByLabelText('Loading the team')).toBeInTheDocument();
  });

  it('draws one card-shaped bone per placeholder row', () => {
    const { container } = render(<TeamRosterSkeleton count={1} />);
    // Each card is an avatar bone plus a name bone plus a handle-line bone
    // plus a secondary-line bone — pinned exactly, at a count of one, so a
    // silent change to the per-card bone count fails here rather than passing
    // under a modulo that 3, 6, or 300 would all satisfy.
    const skeletons = container.querySelectorAll('[data-slot="skeleton"]');
    expect(skeletons.length).toBe(4);
  });

  it('draws exactly `count` cards', () => {
    const { container } = render(<TeamRosterSkeleton count={2} />);
    const cards = container.querySelectorAll('[data-slot="skeleton"]').length / 4;
    expect(cards).toBe(2);
  });

  it('defaults to six cards when `count` is omitted', () => {
    const { container } = render(<TeamRosterSkeleton />);
    const cards = container.querySelectorAll('[data-slot="skeleton"]').length / 4;
    expect(cards).toBe(6);
  });
});
