/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { MarketplaceJsonEntry } from '@dorkos/marketplace';
import { PermissionPreviewServer } from '../PermissionPreviewServer';

function makePkg(
  overrides: Partial<MarketplaceJsonEntry> & { name: string }
): MarketplaceJsonEntry {
  return {
    name: overrides.name,
    source: overrides.source ?? `https://github.com/example/${overrides.name}`,
    ...overrides,
  };
}

describe('PermissionPreviewServer', () => {
  it('renders one <li> per claim', () => {
    const pkg = makePkg({
      name: 'multi',
      layers: ['skills', 'tasks', 'commands'],
    });

    const { container } = render(<PermissionPreviewServer package={pkg} />);

    const items = container.querySelectorAll('li');
    expect(items).toHaveLength(3);
    expect(screen.getByText('Adds skill files')).toBeTruthy();
    expect(screen.getByText('Schedules background tasks')).toBeTruthy();
    expect(screen.getByText('Adds slash commands')).toBeTruthy();
  });

  it('renders the warning glyph for warn-level claims', () => {
    const pkg = makePkg({
      name: 'risky',
      layers: ['hooks', 'mcp-servers'],
    });

    const { container } = render(<PermissionPreviewServer package={pkg} />);

    const warnIcons = container.querySelectorAll('.text-amber-600');
    expect(warnIcons).toHaveLength(2);
    for (const icon of warnIcons) {
      expect(icon.textContent).toBe('⚠');
    }
  });

  it('renders the disclaimer footer', () => {
    const pkg = makePkg({ name: 'anything' });

    render(<PermissionPreviewServer package={pkg} />);

    expect(
      screen.getByText(
        /full permission preview, including external network hosts, is shown when you confirm install in DorkOS/i
      )
    ).toBeTruthy();
  });
});
