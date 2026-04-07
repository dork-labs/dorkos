/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { MarketplaceJsonEntry } from '@dorkos/marketplace';
import { RelatedPackages } from '../RelatedPackages';

function makePkg(
  overrides: Partial<MarketplaceJsonEntry> & { name: string }
): MarketplaceJsonEntry {
  return {
    name: overrides.name,
    source: overrides.source ?? `https://github.com/example/${overrides.name}`,
    ...overrides,
  };
}

describe('RelatedPackages', () => {
  it('returns null when no related packages of the same type exist', () => {
    const all: MarketplaceJsonEntry[] = [
      makePkg({ name: 'current', type: 'agent' }),
      makePkg({ name: 'unrelated-1', type: 'skill-pack' }),
      makePkg({ name: 'unrelated-2', type: 'plugin' }),
    ];

    const { container } = render(
      <RelatedPackages currentName="current" allPackages={all} installCounts={{}} />
    );

    expect(container.firstChild).toBeNull();
  });

  it('returns null when the current package is missing from the list', () => {
    const all: MarketplaceJsonEntry[] = [
      makePkg({ name: 'a', type: 'agent' }),
      makePkg({ name: 'b', type: 'agent' }),
    ];

    const { container } = render(
      <RelatedPackages currentName="missing" allPackages={all} installCounts={{}} />
    );

    expect(container.firstChild).toBeNull();
  });

  it('excludes the current package and renders only same-type peers', () => {
    const all: MarketplaceJsonEntry[] = [
      makePkg({ name: 'current', type: 'agent' }),
      makePkg({ name: 'peer-1', type: 'agent' }),
      makePkg({ name: 'peer-2', type: 'agent' }),
      makePkg({ name: 'unrelated', type: 'skill-pack' }),
    ];

    render(
      <RelatedPackages
        currentName="current"
        allPackages={all}
        installCounts={{ 'peer-1': 12, 'peer-2': 7 }}
      />
    );

    expect(screen.queryByText('current')).toBeNull();
    expect(screen.getByText('peer-1')).toBeTruthy();
    expect(screen.getByText('peer-2')).toBeTruthy();
    expect(screen.queryByText('unrelated')).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'More like this' })).toBeTruthy();
  });

  it('caps the related list at 3 entries', () => {
    const all: MarketplaceJsonEntry[] = [
      makePkg({ name: 'current', type: 'agent' }),
      makePkg({ name: 'peer-1', type: 'agent' }),
      makePkg({ name: 'peer-2', type: 'agent' }),
      makePkg({ name: 'peer-3', type: 'agent' }),
      makePkg({ name: 'peer-4', type: 'agent' }),
      makePkg({ name: 'peer-5', type: 'agent' }),
    ];

    const { container } = render(
      <RelatedPackages currentName="current" allPackages={all} installCounts={{}} />
    );

    const cards = container.querySelectorAll('a[href^="/marketplace/"]');
    expect(cards).toHaveLength(3);
  });
});
