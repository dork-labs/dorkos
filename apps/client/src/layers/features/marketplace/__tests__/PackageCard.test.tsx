/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AggregatedPackage } from '@dorkos/shared/marketplace-schemas';
import { PackageCard } from '../ui/PackageCard';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePackage(overrides: Partial<AggregatedPackage> = {}): AggregatedPackage {
  return {
    name: '@dorkos/code-reviewer',
    source: 'github.com/dorkos/code-reviewer',
    description: 'Reviews pull requests every weekday.',
    version: '1.0.0',
    type: 'agent',
    featured: false,
    marketplace: 'marketplace',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PackageCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(cleanup);

  it('renders package name, type badge, and description', () => {
    const pkg = makePackage();
    render(<PackageCard pkg={pkg} onClick={() => {}} />);

    expect(screen.getByText('Code Reviewer')).toBeInTheDocument();
    expect(screen.getByText('AGENT')).toBeInTheDocument();
    expect(screen.getByText('Reviews pull requests every weekday.')).toBeInTheDocument();
    expect(screen.getByTestId('package-card-@dorkos/code-reviewer')).toBeInTheDocument();
  });

  it('prefers the author-supplied displayName over the slug', () => {
    const pkg = makePackage({ name: 'security-scanner', displayName: 'Security Scanner' });
    render(<PackageCard pkg={pkg} onClick={() => {}} />);

    expect(screen.getByText('Security Scanner')).toBeInTheDocument();
    expect(screen.queryByText('security-scanner')).not.toBeInTheDocument();
  });

  it('humanizes a bare slug when no displayName is supplied', () => {
    const pkg = makePackage({ name: 'security-scanner', displayName: undefined });
    render(<PackageCard pkg={pkg} onClick={() => {}} />);

    // The raw kebab slug never reaches the card title — it reads as a human name.
    expect(screen.getByText('Security Scanner')).toBeInTheDocument();
    expect(screen.queryByText('security-scanner')).not.toBeInTheDocument();
  });

  it('falls back to PLUGIN badge when type is missing', () => {
    const pkg = makePackage({ type: undefined });
    render(<PackageCard pkg={pkg} onClick={() => {}} />);

    expect(screen.getByText('PLUGIN')).toBeInTheDocument();
  });

  it('renders the featured star when pkg.featured is true', () => {
    const pkg = makePackage({ featured: true });
    render(<PackageCard pkg={pkg} onClick={() => {}} />);

    expect(screen.getByLabelText('Featured package')).toBeInTheDocument();
  });

  it('omits the featured star when pkg.featured is false', () => {
    const pkg = makePackage({ featured: false });
    render(<PackageCard pkg={pkg} onClick={() => {}} />);

    expect(screen.queryByLabelText('Featured package')).not.toBeInTheDocument();
  });

  it('omits the description block when pkg.description is missing', () => {
    const pkg = makePackage({ description: undefined });
    render(<PackageCard pkg={pkg} onClick={() => {}} />);

    expect(screen.queryByText('Reviews pull requests every weekday.')).not.toBeInTheDocument();
  });

  it('shows the Installed indicator when installed=true and hides the Install button', () => {
    const pkg = makePackage();
    render(<PackageCard pkg={pkg} installed onClick={() => {}} />);

    expect(screen.getByText('Installed')).toBeInTheDocument();
    // Install button text is split across elements ("Install" + <span>→</span>),
    // so query for just the "Install" text node.
    expect(screen.queryByText('Install')).not.toBeInTheDocument();
  });

  it('shows the Install button when not installed', () => {
    const pkg = makePackage();
    render(<PackageCard pkg={pkg} onClick={() => {}} />);

    expect(screen.getByText('Install')).toBeInTheDocument();
    expect(screen.queryByText('Installed')).not.toBeInTheDocument();
  });

  it('fires onClick when the card body is clicked', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const pkg = makePackage();
    render(<PackageCard pkg={pkg} onClick={onClick} />);

    await user.click(screen.getByTestId('package-card-@dorkos/code-reviewer'));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('fires onInstallClick when the Install button is clicked WITHOUT bubbling to onClick', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const onInstallClick = vi.fn();
    const pkg = makePackage();
    render(<PackageCard pkg={pkg} onClick={onClick} onInstallClick={onInstallClick} />);

    // The Install button text is split across elements ("Install" + <span>→</span>).
    // Use the "Install" text node to find the inner button.
    await user.click(screen.getByText('Install'));

    expect(onInstallClick).toHaveBeenCalledTimes(1);
    // Critical: stopPropagation must prevent the card-level onClick from also firing.
    expect(onClick).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Source label — which marketplace this package came from
  // -------------------------------------------------------------------------

  describe('source label', () => {
    it('names the marketplace the package came from', () => {
      const pkg = makePackage({ marketplace: 'claude-plugins-official' });
      render(<PackageCard pkg={pkg} onClick={() => {}} />);

      expect(screen.getByText('claude-plugins-official')).toBeInTheDocument();
    });

    it('shows the author and the source side by side, not one instead of the other', () => {
      const pkg = makePackage({ author: 'Test Author', marketplace: 'dorkos-community' });
      render(<PackageCard pkg={pkg} onClick={() => {}} />);

      expect(screen.getByText('Test Author')).toBeInTheDocument();
      expect(screen.getByText('dorkos-community')).toBeInTheDocument();
    });

    it('tells a screen reader which name is the source', () => {
      const pkg = makePackage({ author: 'Test Author', marketplace: 'dorkos-community' });
      render(<PackageCard pkg={pkg} onClick={() => {}} />);

      // The store and person icons are aria-hidden, so without this the two
      // names read as one undifferentiated run.
      const card = screen.getByTestId('package-card-@dorkos/code-reviewer');
      expect(card.textContent).toContain('from dorkos-community');
    });

    it('hides the source on the compact variant', () => {
      const pkg = makePackage({ marketplace: 'claude-plugins-official' });
      render(<PackageCard pkg={pkg} onClick={() => {}} variant="compact" />);

      expect(screen.queryByText('claude-plugins-official')).not.toBeInTheDocument();
    });

    it('gives the author and the source a floor each, and wraps rather than crushing both', () => {
      // Sized from their own content, the two shared the row in proportion to
      // how long each string happened to be, and on a card in the four-column
      // grid both crushed together — `C… · d` (DOR-1747). A floor plus a
      // wrapping row is what stops either string's length from deciding
      // anything: when both cannot fit, the source takes the next line.
      const pkg = makePackage({ author: 'Test Author', marketplace: 'dorkos-community' });
      render(<PackageCard pkg={pkg} onClick={() => {}} />);

      for (const label of ['Test Author', 'dorkos-community']) {
        const text = screen.getByText(label, { selector: 'span.truncate' });
        // The text truncates inside its own share…
        expect(text).toHaveClass('truncate');
        // …with the full value on hover, since a long name can still outrun it.
        expect(text).toHaveAttribute('title', label);
        // …and that share has a width it cannot be squeezed below — capped at
        // 100% so the floor itself can never ask for more than the card has
        // (DOR-1747 review: a bare floor painted past the card at a width
        // narrower than 6.5rem).
        expect(text.parentElement).toHaveClass('min-w-[min(6.5rem,100%)]');
        // The row it sits in is the one that yields, with its own overflow
        // clipped as a backstop in case a floor here is ever widened again.
        expect(text.parentElement?.parentElement).toHaveClass('flex-wrap');
        expect(text.parentElement?.parentElement).toHaveClass('overflow-hidden');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Compact variant
  // -------------------------------------------------------------------------

  describe('variant="compact"', () => {
    it('uses p-4 padding instead of p-6', () => {
      const pkg = makePackage();
      render(<PackageCard pkg={pkg} onClick={() => {}} variant="compact" />);

      const card = screen.getByTestId('package-card-@dorkos/code-reviewer');
      expect(card.className).toContain('p-4');
      expect(card.className).not.toContain('p-6');
    });

    it('hides the author row', () => {
      const pkg = makePackage({ author: 'Test Author' });
      render(<PackageCard pkg={pkg} onClick={() => {}} variant="compact" />);

      expect(screen.queryByText('Test Author')).not.toBeInTheDocument();
    });

    it('hides the Install button', () => {
      const pkg = makePackage();
      render(<PackageCard pkg={pkg} onClick={() => {}} variant="compact" />);

      expect(screen.queryByText('Install')).not.toBeInTheDocument();
    });

    it('hides the Installed indicator', () => {
      const pkg = makePackage();
      render(<PackageCard pkg={pkg} installed onClick={() => {}} variant="compact" />);

      expect(screen.queryByText('Installed')).not.toBeInTheDocument();
    });

    it('hides the featured star', () => {
      const pkg = makePackage({ featured: true });
      render(<PackageCard pkg={pkg} onClick={() => {}} variant="compact" />);

      expect(screen.queryByLabelText('Featured package')).not.toBeInTheDocument();
    });

    it('still renders name, badge, description, and icon', () => {
      const pkg = makePackage({ icon: '🤖' });
      render(<PackageCard pkg={pkg} onClick={() => {}} variant="compact" />);

      expect(screen.getByText('Code Reviewer')).toBeInTheDocument();
      expect(screen.getByText('AGENT')).toBeInTheDocument();
      expect(screen.getByText('Reviews pull requests every weekday.')).toBeInTheDocument();
      expect(screen.getByText('🤖')).toBeInTheDocument();
    });

    it('fires onClick when the card is clicked', async () => {
      const user = userEvent.setup();
      const onClick = vi.fn();
      const pkg = makePackage();
      render(<PackageCard pkg={pkg} onClick={onClick} variant="compact" />);

      await user.click(screen.getByTestId('package-card-@dorkos/code-reviewer'));

      expect(onClick).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Default variant regression
  // -------------------------------------------------------------------------

  it('default variant uses p-6 padding', () => {
    const pkg = makePackage();
    render(<PackageCard pkg={pkg} onClick={() => {}} />);

    const card = screen.getByTestId('package-card-@dorkos/code-reviewer');
    expect(card.className).toContain('p-6');
    expect(card.className).not.toContain('p-4');
  });
});
