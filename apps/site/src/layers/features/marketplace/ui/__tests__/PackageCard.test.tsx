/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { MergedMarketplaceEntry } from '@dorkos/marketplace';
import { PackageCard } from '../PackageCard';

function pkg(
  overrides: Partial<MergedMarketplaceEntry> & { name: string }
): MergedMarketplaceEntry {
  return { source: `./${overrides.name}`, ...overrides } as MergedMarketplaceEntry;
}

describe('PackageCard', () => {
  it('links the whole card to the package detail page', () => {
    const { container } = render(<PackageCard package={pkg({ name: 'code-reviewer' })} />);
    expect(container.querySelector('a[href="/marketplace/code-reviewer"]')).toBeTruthy();
  });

  it('renders the primary category as a link to its landing page (sidecar categories[])', () => {
    const { container } = render(
      <PackageCard package={pkg({ name: 'p', dorkos: { categories: ['security'] } })} />
    );
    const chip = container.querySelector('a[href="/marketplace/category/security"]');
    expect(chip).toBeTruthy();
    expect(chip?.textContent).toBe('Security');
  });

  it('falls back to the singular category when there is no sidecar list', () => {
    const { container } = render(
      <PackageCard package={pkg({ name: 'p', category: 'security' })} />
    );
    expect(container.querySelector('a[href="/marketplace/category/security"]')).toBeTruthy();
  });

  it('renders a legacy off-list category as plain text, not a (broken) link', () => {
    // Pre-backfill packages carry free-string categories; linking them would 404.
    const { container } = render(
      <PackageCard package={pkg({ name: 'p', category: 'code-quality' })} />
    );
    expect(container.querySelector('a[href^="/marketplace/category/"]')).toBeNull();
    expect(screen.getByText('code-quality')).toBeTruthy();
  });

  it('renders no category chip for an uncategorized package', () => {
    const { container } = render(<PackageCard package={pkg({ name: 'p' })} />);
    expect(container.querySelector('a[href^="/marketplace/category/"]')).toBeNull();
  });
});
