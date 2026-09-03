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
    const { container } = render(<TeamRosterSkeleton />);
    // Each card is an avatar bone plus a name bone plus a secondary-line bone.
    const skeletons = container.querySelectorAll('[data-slot="skeleton"]');
    expect(skeletons.length % 3).toBe(0);
    expect(skeletons.length).toBeGreaterThan(0);
  });
});
