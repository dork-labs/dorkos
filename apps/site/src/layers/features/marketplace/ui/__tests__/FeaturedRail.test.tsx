/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { RankedPackage } from '../../lib/ranking';
import { FeaturedRail } from '../FeaturedRail';

/** Build a ranked fixture; DorkOS fields (type, featured) ride the sidecar. */
function makeRanked(overrides: Partial<RankedPackage> & { name: string }): RankedPackage {
  return {
    name: overrides.name,
    source: overrides.source ?? `https://github.com/example/${overrides.name}`,
    score: overrides.score ?? 0,
    ...overrides,
  };
}

describe('FeaturedRail', () => {
  it('returns null when packages is empty', () => {
    const { container } = render(<FeaturedRail packages={[]} installCounts={{}} />);

    expect(container.firstChild).toBeNull();
  });

  it('renders the "Featured" heading and all packages when populated', () => {
    const packages = [
      makeRanked({ name: 'first', dorkos: { type: 'agent', featured: true } }),
      makeRanked({ name: 'second', dorkos: { type: 'agent', featured: true } }),
      makeRanked({ name: 'third', dorkos: { type: 'agent', featured: true } }),
    ];

    render(
      <FeaturedRail packages={packages} installCounts={{ first: 5, second: 10, third: 15 }} />
    );

    expect(screen.getByText('Featured')).toBeTruthy();
    expect(screen.getByText('first')).toBeTruthy();
    expect(screen.getByText('second')).toBeTruthy();
    expect(screen.getByText('third')).toBeTruthy();
  });

  it('renders featured packages of any type, not just agents', () => {
    const packages = [
      makeRanked({ name: 'a-shape', dorkos: { type: 'shape', featured: true } }),
      makeRanked({ name: 'a-plugin', dorkos: { type: 'plugin', featured: true } }),
    ];

    render(<FeaturedRail packages={packages} installCounts={{}} />);

    expect(screen.getByText('a-shape')).toBeTruthy();
    expect(screen.getByText('a-plugin')).toBeTruthy();
  });

  it('passes install counts through to each card', () => {
    const packages = [makeRanked({ name: 'counted', dorkos: { featured: true } })];

    render(<FeaturedRail packages={packages} installCounts={{ counted: 4242 }} />);

    expect(screen.getByText('4,242 installs')).toBeTruthy();
  });
});
