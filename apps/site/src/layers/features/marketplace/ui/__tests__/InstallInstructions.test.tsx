/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { MarketplaceJsonEntry } from '@dorkos/marketplace';
import { InstallInstructions } from '../InstallInstructions';

function makePkg(
  overrides: Partial<MarketplaceJsonEntry> & { name: string }
): MarketplaceJsonEntry {
  return {
    name: overrides.name,
    source: overrides.source ?? `https://github.com/example/${overrides.name}`,
    ...overrides,
  };
}

describe('InstallInstructions', () => {
  it('renders the dorkos install command for the package name', () => {
    const pkg = makePkg({ name: 'code-reviewer' });

    const { container } = render(<InstallInstructions package={pkg} />);

    const code = container.querySelector('pre code');
    expect(code).toBeTruthy();
    expect(code?.textContent).toBe('dorkos install code-reviewer');
  });

  it('renders the install heading and the in-app catalog pointer', () => {
    const pkg = makePkg({ name: 'tasks-runner' });

    render(<InstallInstructions package={pkg} />);

    expect(screen.getByRole('heading', { level: 2, name: 'Install' })).toBeTruthy();
    expect(screen.getByText(/browse the catalog inside DorkOS/i)).toBeTruthy();
  });

  it('uses the package name verbatim in the command', () => {
    const pkg = makePkg({ name: '@scoped/weird-name' });

    const { container } = render(<InstallInstructions package={pkg} />);

    const code = container.querySelector('pre code');
    expect(code?.textContent).toBe('dorkos install @scoped/weird-name');
  });
});
