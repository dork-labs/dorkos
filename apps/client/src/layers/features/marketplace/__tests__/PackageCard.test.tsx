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
    marketplace: 'dork-hub',
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

    expect(screen.getByText('@dorkos/code-reviewer')).toBeInTheDocument();
    expect(screen.getByText('AGENT')).toBeInTheDocument();
    expect(screen.getByText('Reviews pull requests every weekday.')).toBeInTheDocument();
    expect(screen.getByTestId('package-card-@dorkos/code-reviewer')).toBeInTheDocument();
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
    // The Install action is rendered as a nested <button> with the literal
    // text "Install →" — querying by exact text avoids matching the outer
    // card-level <button> whose accessible name is computed from descendants.
    expect(screen.queryByText('Install →')).not.toBeInTheDocument();
  });

  it('shows the Install button when not installed', () => {
    const pkg = makePackage();
    render(<PackageCard pkg={pkg} onClick={() => {}} />);

    expect(screen.getByText('Install →')).toBeInTheDocument();
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

    // Query the inner Install button by its exact text rather than role+name
    // to avoid matching the outer card-level <button>, which has the same
    // computed accessible name because its name comes from its descendants.
    await user.click(screen.getByText('Install →'));

    expect(onInstallClick).toHaveBeenCalledTimes(1);
    // Critical: stopPropagation must prevent the card-level onClick from also firing.
    expect(onClick).not.toHaveBeenCalled();
  });
});
