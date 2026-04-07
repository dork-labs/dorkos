/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { RankedPackage } from '../../lib/ranking';
import { FeaturedAgentsRail } from '../FeaturedAgentsRail';

function makeRanked(overrides: Partial<RankedPackage> & { name: string }): RankedPackage {
  return {
    name: overrides.name,
    source: overrides.source ?? `https://github.com/example/${overrides.name}`,
    score: overrides.score ?? 0,
    ...overrides,
  };
}

describe('FeaturedAgentsRail', () => {
  it('returns null when packages is empty', () => {
    const { container } = render(<FeaturedAgentsRail packages={[]} installCounts={{}} />);

    expect(container.firstChild).toBeNull();
  });

  it('renders the heading and all packages when populated', () => {
    const packages = [
      makeRanked({ name: 'first', type: 'agent', featured: true }),
      makeRanked({ name: 'second', type: 'agent', featured: true }),
      makeRanked({ name: 'third', type: 'agent', featured: true }),
    ];

    render(
      <FeaturedAgentsRail packages={packages} installCounts={{ first: 5, second: 10, third: 15 }} />
    );

    expect(screen.getByText('Featured agents')).toBeTruthy();
    expect(screen.getByText('first')).toBeTruthy();
    expect(screen.getByText('second')).toBeTruthy();
    expect(screen.getByText('third')).toBeTruthy();
  });

  it('passes install counts through to each card', () => {
    const packages = [makeRanked({ name: 'counted', featured: true })];

    render(<FeaturedAgentsRail packages={packages} installCounts={{ counted: 4242 }} />);

    expect(screen.getByText('4,242 installs')).toBeTruthy();
  });
});
