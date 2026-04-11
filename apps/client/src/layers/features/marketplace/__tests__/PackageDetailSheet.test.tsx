/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  AggregatedPackage,
  InstalledPackage,
  MarketplacePackageDetail,
  PermissionPreview,
} from '@dorkos/shared/marketplace-schemas';
import {
  useMarketplacePackage,
  usePermissionPreview,
  useInstalledPackages,
  useUninstallPackage,
} from '@/layers/entities/marketplace';
import { useDorkHubStore } from '../model/dork-hub-store';
import { PackageDetailSheet } from '../ui/PackageDetailSheet';

// ---------------------------------------------------------------------------
// Mock the marketplace entity hooks. Each test sets the return value
// explicitly so the test owns the data layer with no Transport involved.
// ---------------------------------------------------------------------------

vi.mock('@/layers/entities/marketplace', () => ({
  useMarketplacePackage: vi.fn(),
  usePermissionPreview: vi.fn(),
  useInstalledPackages: vi.fn(),
  useUninstallPackage: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Browser API mocks (Radix Sheet uses matchMedia + pointer capture under the
// hood — both must be polyfilled in jsdom or Radix throws on render).
// ---------------------------------------------------------------------------

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

  // Radix Dialog/Sheet calls these on its content element. jsdom doesn't
  // implement them, so stub them out as no-ops.
  const proto = Element.prototype as unknown as Record<string, unknown>;
  if (!proto.hasPointerCapture) proto.hasPointerCapture = vi.fn();
  if (!proto.releasePointerCapture) proto.releasePointerCapture = vi.fn();
  if (!proto.scrollIntoView) proto.scrollIntoView = vi.fn();
});

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

function makePreview(overrides: Partial<PermissionPreview> = {}): PermissionPreview {
  return {
    fileChanges: [{ path: 'agents/code-reviewer.json', action: 'create' }],
    extensions: [],
    tasks: [],
    secrets: [],
    externalHosts: [],
    requires: [],
    conflicts: [],
    ...overrides,
  };
}

function makeDetail(overrides: Partial<MarketplacePackageDetail> = {}): MarketplacePackageDetail {
  return {
    manifest: {
      name: '@dorkos/code-reviewer',
      version: '1.0.0',
      type: 'agent',
      author: 'Dork Team',
      license: 'MIT',
    },
    packagePath: '/tmp/code-reviewer',
    preview: makePreview(),
    ...overrides,
  };
}

const INSTALLED_FIXTURE: InstalledPackage = {
  name: '@dorkos/code-reviewer',
  version: '1.0.0',
  type: 'agent',
  installPath: '/tmp/installed/code-reviewer',
};

// ---------------------------------------------------------------------------
// Hook return-value helpers (cast to the hook's return type so each test only
// has to set the fields it cares about).
// ---------------------------------------------------------------------------

type DetailHookState = { data?: MarketplacePackageDetail; isLoading?: boolean };

function setDetailState(state: DetailHookState = {}) {
  vi.mocked(useMarketplacePackage).mockReturnValue({
    data: state.data,
    isLoading: state.isLoading ?? false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useMarketplacePackage>);
}

function setPreviewState(state: DetailHookState = {}) {
  vi.mocked(usePermissionPreview).mockReturnValue({
    data: state.data,
    isLoading: state.isLoading ?? false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof usePermissionPreview>);
}

function setInstalledState(installed: InstalledPackage[] = []) {
  vi.mocked(useInstalledPackages).mockReturnValue({
    data: installed,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useInstalledPackages>);
}

const uninstallMutate = vi.fn();
function setUninstallState({ isPending = false }: { isPending?: boolean } = {}) {
  vi.mocked(useUninstallPackage).mockReturnValue({
    mutate: uninstallMutate,
    isPending,
    isSuccess: false,
    isError: false,
    error: null,
    reset: vi.fn(),
  } as unknown as ReturnType<typeof useUninstallPackage>);
}

// ---------------------------------------------------------------------------
// Store reset helper — snapshot the initial store and restore it before each
// test so detailPackage / installConfirmPackage state never leaks across tests.
// ---------------------------------------------------------------------------

const INITIAL_STORE_STATE = useDorkHubStore.getState();

function resetStore() {
  useDorkHubStore.setState(INITIAL_STORE_STATE, true);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PackageDetailSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
    setDetailState();
    setPreviewState();
    setInstalledState([]);
    setUninstallState();
  });

  afterEach(cleanup);

  it('renders nothing visible when detailPackage is null', () => {
    render(<PackageDetailSheet />);

    // Sheet is closed → its title should not appear in the document.
    expect(screen.queryByText('@dorkos/code-reviewer')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^install$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^close$/i })).not.toBeInTheDocument();
  });

  it('opens with package name and description when detailPackage is set', () => {
    const pkg = makePackage();
    useDorkHubStore.getState().openDetail(pkg);
    setDetailState({ data: makeDetail() });
    setPreviewState({ data: makeDetail() });

    render(<PackageDetailSheet />);

    expect(screen.getByText('@dorkos/code-reviewer')).toBeInTheDocument();
    expect(screen.getByText('Reviews pull requests every weekday.')).toBeInTheDocument();
    // Version meta badge from detail.manifest.version.
    expect(screen.getByText('v1.0.0')).toBeInTheDocument();
    // Author renders inside a MetaChip without the "by" prefix.
    expect(screen.getByText('Dork Team')).toBeInTheDocument();
  });

  it('renders the PermissionPreviewSection when the preview resolves', () => {
    useDorkHubStore.getState().openDetail(makePackage());
    setDetailState({ data: makeDetail() });
    setPreviewState({
      data: makeDetail({
        preview: makePreview({
          fileChanges: [{ path: 'agents/code-reviewer.json', action: 'create' }],
          secrets: [{ key: 'GITHUB_TOKEN', required: true }],
        }),
      }),
    });

    render(<PackageDetailSheet />);

    // The "Permissions & Effects" heading is the section wrapper rendered by
    // the sheet around PermissionPreviewSection.
    expect(screen.getByText('Permissions & Effects')).toBeInTheDocument();
    // formatPermissionPreview emits a single aggregate label per file group
    // ("1 file will be created, modified, or deleted") rather than each path.
    expect(screen.getByText('1 file will be created, modified, or deleted')).toBeInTheDocument();
    // Secret rows render their key as the label.
    expect(screen.getByText('GITHUB_TOKEN')).toBeInTheDocument();
    // The "Secrets required" section heading is also rendered.
    expect(screen.getByText('Secrets required')).toBeInTheDocument();
  });

  it('shows the Install button when the package is not installed and uses the store action on click', async () => {
    const user = userEvent.setup();
    const pkg = makePackage();
    useDorkHubStore.getState().openDetail(pkg);
    setDetailState({ data: makeDetail() });
    setPreviewState({ data: makeDetail() });
    setInstalledState([]); // not installed

    render(<PackageDetailSheet />);

    const installButton = screen.getByRole('button', { name: /^install$/i });
    expect(installButton).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^uninstall$/i })).not.toBeInTheDocument();

    await user.click(installButton);

    // Install action delegates to the store, which should now have the
    // package queued for the install confirmation dialog.
    const state = useDorkHubStore.getState();
    expect(state.installConfirmPackage).not.toBeNull();
    expect(state.installConfirmPackage?.name).toBe('@dorkos/code-reviewer');
  });

  it('shows the Uninstall button when the package is installed and calls uninstall.mutate on click', async () => {
    const user = userEvent.setup();
    const pkg = makePackage();
    useDorkHubStore.getState().openDetail(pkg);
    setDetailState({ data: makeDetail() });
    setPreviewState({ data: makeDetail() });
    setInstalledState([INSTALLED_FIXTURE]);

    render(<PackageDetailSheet />);

    const uninstallButton = screen.getByRole('button', { name: /^uninstall$/i });
    expect(uninstallButton).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^install$/i })).not.toBeInTheDocument();

    await user.click(uninstallButton);

    expect(uninstallMutate).toHaveBeenCalledTimes(1);
    expect(uninstallMutate).toHaveBeenCalledWith({ name: '@dorkos/code-reviewer' });
  });

  it('clicking Close clears detailPackage in the store', async () => {
    const user = userEvent.setup();
    useDorkHubStore.getState().openDetail(makePackage());
    setDetailState({ data: makeDetail() });
    setPreviewState({ data: makeDetail() });

    render(<PackageDetailSheet />);

    expect(useDorkHubStore.getState().detailPackage).not.toBeNull();

    // Two buttons in the DOM expose the accessible name "Close": Radix's
    // built-in icon X (top-right) and the explicit footer Close button. We
    // want the footer one — pick the <button> whose visible text is exactly
    // "Close" (the icon X uses an sr-only span and contains an SVG sibling).
    const closeButtons = screen.getAllByRole('button', { name: /^close$/i });
    const footerClose = closeButtons.find((btn) => btn.textContent?.trim() === 'Close');
    expect(footerClose).toBeDefined();
    await user.click(footerClose!);

    expect(useDorkHubStore.getState().detailPackage).toBeNull();
  });

  it('shows loading skeletons while the detail or preview query is pending', () => {
    useDorkHubStore.getState().openDetail(makePackage());
    setDetailState({ isLoading: true });
    setPreviewState({ isLoading: true });

    render(<PackageDetailSheet />);

    // DetailSkeleton renders Skeleton placeholders with aria-busy implied.
    // The permissions section should not render until preview resolves.
    expect(screen.queryByText('Permissions & Effects')).not.toBeInTheDocument();
  });

  it('disables the Uninstall button while the uninstall mutation is in flight', () => {
    useDorkHubStore.getState().openDetail(makePackage());
    setDetailState({ data: makeDetail() });
    setPreviewState({ data: makeDetail() });
    setInstalledState([INSTALLED_FIXTURE]);
    setUninstallState({ isPending: true });

    render(<PackageDetailSheet />);

    const uninstallButton = screen.getByRole('button', { name: /uninstalling/i });
    expect(uninstallButton).toBeDisabled();
  });
});
