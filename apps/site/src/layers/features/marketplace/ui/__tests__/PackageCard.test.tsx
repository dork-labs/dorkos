/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { MarketplaceJsonEntry } from '@dorkos/marketplace';
import { PackageCard } from '../PackageCard';

function makePkg(
  overrides: Partial<MarketplaceJsonEntry> & { name: string }
): MarketplaceJsonEntry {
  return {
    name: overrides.name,
    source: overrides.source ?? `https://github.com/example/${overrides.name}`,
    ...overrides,
  };
}

describe('PackageCard', () => {
  it('renders name, type, description, and install count', () => {
    const pkg = makePkg({
      name: 'code-reviewer',
      type: 'agent',
      description: 'Reviews your PRs every weekday morning.',
      icon: '🔍',
      category: 'code-quality',
    });

    render(<PackageCard package={pkg} installCount={1234} />);

    expect(screen.getByText('code-reviewer')).toBeTruthy();
    expect(screen.getByText('agent')).toBeTruthy();
    expect(screen.getByText('Reviews your PRs every weekday morning.')).toBeTruthy();
    expect(screen.getByText('1,234 installs')).toBeTruthy();
    expect(screen.getByText('code-quality')).toBeTruthy();
    expect(screen.getByText('🔍')).toBeTruthy();
  });

  it('falls back to the package emoji when no icon is provided', () => {
    const pkg = makePkg({ name: 'no-icon' });

    render(<PackageCard package={pkg} />);

    expect(screen.getByText('📦')).toBeTruthy();
  });

  it('falls back to "plugin" when no type is provided', () => {
    const pkg = makePkg({ name: 'untyped' });

    render(<PackageCard package={pkg} />);

    expect(screen.getByText('plugin')).toBeTruthy();
  });

  it('omits the install count when undefined', () => {
    const pkg = makePkg({ name: 'silent' });

    const { container } = render(<PackageCard package={pkg} />);

    expect(container.textContent).not.toContain(' installs');
  });

  it('omits the install count text when count is zero', () => {
    const pkg = makePkg({ name: 'silent' });

    const { container } = render(<PackageCard package={pkg} installCount={0} />);

    expect(container.textContent).not.toContain(' installs');
  });

  it('links to the package detail page', () => {
    const pkg = makePkg({ name: 'linked' });

    const { container } = render(<PackageCard package={pkg} />);

    const link = container.querySelector('a');
    expect(link).toBeTruthy();
    expect(link?.getAttribute('href')).toBe('/marketplace/linked');
  });
});
