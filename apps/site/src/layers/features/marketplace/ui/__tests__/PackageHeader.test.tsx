/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { MarketplaceJsonEntry } from '@dorkos/marketplace';
import { PackageHeader } from '../PackageHeader';

function makePkg(
  overrides: Partial<MarketplaceJsonEntry> & { name: string }
): MarketplaceJsonEntry {
  return {
    name: overrides.name,
    source: overrides.source ?? `https://github.com/example/${overrides.name}`,
    ...overrides,
  };
}

describe('PackageHeader', () => {
  it('renders icon, name, type/category line, install count, and source link', () => {
    const pkg = makePkg({
      name: 'code-reviewer',
      type: 'agent',
      category: 'code-quality',
      icon: '🔍',
      description: 'Reviews your PRs every weekday morning.',
    });

    const { container } = render(<PackageHeader package={pkg} installCount={1234} />);

    expect(screen.getByText('🔍')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'code-reviewer' })).toBeTruthy();
    expect(screen.getByText('agent · code-quality')).toBeTruthy();
    expect(screen.getByText('Reviews your PRs every weekday morning.')).toBeTruthy();
    expect(screen.getByText('1,234 installs')).toBeTruthy();

    const link = container.querySelector('a');
    expect(link).toBeTruthy();
    expect(link?.getAttribute('href')).toBe('https://github.com/example/code-reviewer');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('hides the install count when zero', () => {
    const pkg = makePkg({ name: 'fresh-package' });

    const { container } = render(<PackageHeader package={pkg} installCount={0} />);

    expect(container.textContent).not.toContain('installs');
  });

  it('falls back to the package emoji and "plugin" type when not provided', () => {
    const pkg = makePkg({ name: 'minimal' });

    render(<PackageHeader package={pkg} installCount={5} />);

    expect(screen.getByText('📦')).toBeTruthy();
    expect(screen.getByText('plugin')).toBeTruthy();
  });

  it('shows just the type when no category is provided', () => {
    const pkg = makePkg({ name: 'typed-only', type: 'skill-pack' });

    render(<PackageHeader package={pkg} installCount={42} />);

    expect(screen.getByText('skill-pack')).toBeTruthy();
  });
});
