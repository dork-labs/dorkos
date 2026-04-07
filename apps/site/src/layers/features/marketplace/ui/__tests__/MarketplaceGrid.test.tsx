/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { RankedPackage } from '../../lib/ranking';
import { MarketplaceGrid } from '../MarketplaceGrid';

function makeRanked(overrides: Partial<RankedPackage> & { name: string }): RankedPackage {
  return {
    name: overrides.name,
    source: overrides.source ?? `https://github.com/example/${overrides.name}`,
    score: overrides.score ?? 0,
    ...overrides,
  };
}

describe('MarketplaceGrid', () => {
  it('renders the empty state when packages is empty', () => {
    render(<MarketplaceGrid packages={[]} installCounts={{}} initialFilters={{}} />);

    expect(screen.getByText('No packages match these filters.')).toBeTruthy();
  });

  it('renders package cards when packages are present', () => {
    const packages = [
      makeRanked({ name: 'one', type: 'agent' }),
      makeRanked({ name: 'two', type: 'plugin' }),
    ];

    render(
      <MarketplaceGrid
        packages={packages}
        installCounts={{ one: 10, two: 20 }}
        initialFilters={{}}
      />
    );

    expect(screen.getByText('one')).toBeTruthy();
    expect(screen.getByText('two')).toBeTruthy();
  });

  it('renders all four type filter tabs plus "All"', () => {
    render(<MarketplaceGrid packages={[]} installCounts={{}} initialFilters={{}} />);

    expect(screen.getByText('All')).toBeTruthy();
    expect(screen.getByText('agent')).toBeTruthy();
    expect(screen.getByText('plugin')).toBeTruthy();
    expect(screen.getByText('skill-pack')).toBeTruthy();
    expect(screen.getByText('adapter')).toBeTruthy();
  });

  it('marks the "All" tab active when no type filter is set', () => {
    const { container } = render(
      <MarketplaceGrid packages={[]} installCounts={{}} initialFilters={{}} />
    );

    const allLink = Array.from(container.querySelectorAll('a')).find(
      (a) => a.textContent === 'All'
    );
    expect(allLink).toBeTruthy();
    expect(allLink?.className).toContain('bg-charcoal');
    expect(allLink?.className).toContain('text-cream-primary');
  });

  it('marks the active type tab when a type filter is set', () => {
    const { container } = render(
      <MarketplaceGrid packages={[]} installCounts={{}} initialFilters={{ type: 'agent' }} />
    );

    const links = Array.from(container.querySelectorAll('a'));
    const allLink = links.find((a) => a.textContent === 'All');
    const agentLink = links.find((a) => a.textContent === 'agent');

    expect(agentLink?.className).toContain('bg-charcoal');
    expect(agentLink?.className).toContain('text-cream-primary');
    expect(allLink?.className).not.toContain('bg-charcoal');
  });

  it('points filter tabs at /marketplace?type=...', () => {
    const { container } = render(
      <MarketplaceGrid packages={[]} installCounts={{}} initialFilters={{}} />
    );

    const links = Array.from(container.querySelectorAll('a'));
    const allLink = links.find((a) => a.textContent === 'All');
    const adapterLink = links.find((a) => a.textContent === 'adapter');

    expect(allLink?.getAttribute('href')).toBe('/marketplace');
    expect(adapterLink?.getAttribute('href')).toBe('/marketplace?type=adapter');
  });
});
