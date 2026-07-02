/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Marketplace } from '../ui/Marketplace';

// ---------------------------------------------------------------------------
// URL params mock — Marketplace reads `view`/`setView` from useMarketplaceParams.
// ---------------------------------------------------------------------------

const mockParams = vi.hoisted(() => ({
  view: 'browse' as 'browse' | 'installed',
  type: 'all' as string,
  sort: 'featured' as string,
  search: '' as string,
  category: null as string | null,
  selectedPackageName: null as string | null,
  setView: vi.fn(),
  setType: vi.fn(),
  setSort: vi.fn(),
  setSearch: vi.fn(),
  setCategory: vi.fn(),
  resetFilters: vi.fn(),
  openDetail: vi.fn(),
  closeDetail: vi.fn(),
}));

vi.mock('../model/use-marketplace-params', () => ({
  useMarketplaceParams: () => mockParams,
}));

// Stub the heavy children so the test isolates the view-switch logic.
vi.mock('../ui/MarketplaceHeader', () => ({
  MarketplaceHeader: () => <div data-testid="browse-header" />,
}));
vi.mock('../ui/FeaturedAgentsRail', () => ({
  FeaturedAgentsRail: () => <div data-testid="featured-rail" />,
}));
vi.mock('../ui/PackageGrid', () => ({ PackageGrid: () => <div data-testid="package-grid" /> }));
vi.mock('../ui/InstalledPackagesView', () => ({
  InstalledPackagesView: () => <div data-testid="installed-view" />,
}));
vi.mock('../ui/PackageDetailSheet', () => ({
  PackageDetailSheet: () => <div data-testid="detail-sheet" />,
}));
vi.mock('../ui/InstallConfirmationDialog', () => ({
  InstallConfirmationDialog: () => <div data-testid="install-dialog" />,
}));
vi.mock('../ui/TelemetryConsentBanner', () => ({ TelemetryConsentBanner: () => null }));

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

describe('Marketplace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockParams.view = 'browse';
  });

  afterEach(() => cleanup());

  it('renders the browse grid (not the installed view) by default', () => {
    render(<Marketplace />);
    expect(screen.getByTestId('package-grid')).toBeInTheDocument();
    expect(screen.getByTestId('featured-rail')).toBeInTheDocument();
    expect(screen.queryByTestId('installed-view')).not.toBeInTheDocument();
  });

  it('renders the installed view (not the browse grid) when view is installed', () => {
    mockParams.view = 'installed';
    render(<Marketplace />);
    expect(screen.getByTestId('installed-view')).toBeInTheDocument();
    expect(screen.queryByTestId('package-grid')).not.toBeInTheDocument();
    expect(screen.queryByTestId('featured-rail')).not.toBeInTheDocument();
  });

  it('keeps the detail sheet mounted in both views for deep-link parity', () => {
    render(<Marketplace />);
    expect(screen.getByTestId('detail-sheet')).toBeInTheDocument();

    cleanup();
    mockParams.view = 'installed';
    render(<Marketplace />);
    expect(screen.getByTestId('detail-sheet')).toBeInTheDocument();
  });

  it('switches to the installed view when the Installed tab is clicked', async () => {
    const user = userEvent.setup();
    render(<Marketplace />);
    await user.click(screen.getByRole('tab', { name: 'Installed' }));
    expect(mockParams.setView).toHaveBeenCalledWith('installed');
  });

  it('renders both view tabs', () => {
    render(<Marketplace />);
    expect(screen.getByRole('tab', { name: 'Browse' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Installed' })).toBeInTheDocument();
  });
});
