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
  useInstalledPackage,
} from '@/layers/entities/marketplace';
import { useMarketplaceStore } from '../model/marketplace-store';
import { useUninstallWithToast } from '../model/use-uninstall-with-toast';
import { PackageDetailSheet } from '../ui/PackageDetailSheet';

// ---------------------------------------------------------------------------
// Mock the marketplace entity hooks. Each test sets the return value
// explicitly so the test owns the data layer with no Transport involved.
// Uninstall is wrapped by `useUninstallWithToast` (which fires sonner toasts),
// so the component reads that feature-layer wrapper, not the entity hook.
// ---------------------------------------------------------------------------

vi.mock('@/layers/entities/marketplace', () => ({
  useMarketplacePackage: vi.fn(),
  usePermissionPreview: vi.fn(),
  useInstalledPackages: vi.fn(),
  useInstalledPackage: vi.fn(),
}));

vi.mock('../model/use-uninstall-with-toast', () => ({
  useUninstallWithToast: vi.fn(),
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
    marketplace: 'marketplace',
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
  scope: 'global',
  installedFrom: 'github.com/dorkos/code-reviewer',
};

// The enriched single-package record returned by `useInstalledPackage`, adding
// the capability `provides` counts the list endpoint omits. Backs the
// InstalledPanel's "Provides …" line.
const INSTALLED_DETAIL_FIXTURE: InstalledPackage = {
  ...INSTALLED_FIXTURE,
  installedAt: '2026-01-15T00:00:00.000Z',
  provides: { commands: 3, skills: 2, hooks: true },
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

function setInstalledState(installed: InstalledPackage[] = [], { isLoading = false } = {}) {
  vi.mocked(useInstalledPackages).mockReturnValue({
    data: isLoading ? undefined : installed,
    isLoading,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useInstalledPackages>);
}

// The enriched single-package query (`useInstalledPackage`) is only consulted
// once the list marks the package installed; it fills in the `provides` counts.
function setInstalledPackageState(installedPkg?: InstalledPackage) {
  vi.mocked(useInstalledPackage).mockReturnValue({
    data: installedPkg,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useInstalledPackage>);
}

const uninstallMutate = vi.fn();
function setUninstallState({ isPending = false }: { isPending?: boolean } = {}) {
  vi.mocked(useUninstallWithToast).mockReturnValue({
    mutate: uninstallMutate,
    mutateAsync: vi.fn(),
    isPending,
    isSuccess: false,
    isError: false,
    error: null,
    reset: vi.fn(),
  } as unknown as ReturnType<typeof useUninstallWithToast>);
}

// ---------------------------------------------------------------------------
// Store reset helper — snapshot the initial store and restore it before each
// test so detailPackage / installConfirmPackage state never leaks across tests.
// ---------------------------------------------------------------------------

const INITIAL_STORE_STATE = useMarketplaceStore.getState();

function resetStore() {
  useMarketplaceStore.setState(INITIAL_STORE_STATE, true);
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
    setInstalledPackageState();
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
    useMarketplaceStore.getState().openDetail(pkg);
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
    useMarketplaceStore.getState().openDetail(makePackage());
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
    useMarketplaceStore.getState().openDetail(pkg);
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
    const state = useMarketplaceStore.getState();
    expect(state.installConfirmPackage).not.toBeNull();
    expect(state.installConfirmPackage?.name).toBe('@dorkos/code-reviewer');
  });

  it('shows the installed panel + Reinstall/Uninstall when the package is installed and calls uninstall.mutate on click', async () => {
    const user = userEvent.setup();
    const pkg = makePackage();
    useMarketplaceStore.getState().openDetail(pkg);
    setDetailState({ data: makeDetail() });
    setPreviewState({ data: makeDetail() });
    setInstalledState([INSTALLED_FIXTURE]);
    setInstalledPackageState(INSTALLED_DETAIL_FIXTURE);

    render(<PackageDetailSheet />);

    // Installed branch renders the InstalledPanel (scope + provides), not the
    // install permission preview.
    expect(screen.getByText('Installed globally')).toBeInTheDocument();
    expect(screen.getByText('Provides 3 commands · 2 skills · hooks')).toBeInTheDocument();
    expect(screen.queryByText('Permissions & Effects')).not.toBeInTheDocument();
    expect(screen.queryByText('No special permissions required.')).not.toBeInTheDocument();

    // Both installed-state actions render; the plain Install button does not.
    expect(screen.getByRole('button', { name: /^reinstall$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^install$/i })).not.toBeInTheDocument();

    const uninstallButton = screen.getByRole('button', { name: /^uninstall$/i });
    expect(uninstallButton).toBeInTheDocument();

    await user.click(uninstallButton);

    expect(uninstallMutate).toHaveBeenCalledTimes(1);
    expect(uninstallMutate).toHaveBeenCalledWith({ name: '@dorkos/code-reviewer' });
  });

  it('falls back to the installed list entry for the panel while the enriched fetch is pending', () => {
    // The enriched single-package query hasn't resolved (data undefined), so the
    // panel falls back to the list entry, which already carries scope/source —
    // it should render the scope label without waiting (and without a wrong
    // label). The provides line is simply absent until the enriched fetch lands.
    useMarketplaceStore.getState().openDetail(makePackage());
    setDetailState({ data: makeDetail() });
    setInstalledState([INSTALLED_FIXTURE]);
    setInstalledPackageState(undefined);

    render(<PackageDetailSheet />);

    expect(screen.getByText('Installed globally')).toBeInTheDocument();
    expect(screen.getByText('from github.com/dorkos/code-reviewer')).toBeInTheDocument();
    expect(screen.queryByText(/^Provides /)).not.toBeInTheDocument();
  });

  it('Reinstall delegates to the install confirmation dialog via the store', async () => {
    const user = userEvent.setup();
    const pkg = makePackage();
    useMarketplaceStore.getState().openDetail(pkg);
    setDetailState({ data: makeDetail() });
    setInstalledState([INSTALLED_FIXTURE]);
    setInstalledPackageState(INSTALLED_DETAIL_FIXTURE);

    render(<PackageDetailSheet />);

    await user.click(screen.getByRole('button', { name: /^reinstall$/i }));

    const state = useMarketplaceStore.getState();
    expect(state.installConfirmPackage).not.toBeNull();
    expect(state.installConfirmPackage?.name).toBe('@dorkos/code-reviewer');
  });

  it('clicking Close clears detailPackage in the store', async () => {
    const user = userEvent.setup();
    useMarketplaceStore.getState().openDetail(makePackage());
    setDetailState({ data: makeDetail() });
    setPreviewState({ data: makeDetail() });

    render(<PackageDetailSheet />);

    expect(useMarketplaceStore.getState().detailPackage).not.toBeNull();

    // Two buttons in the DOM expose the accessible name "Close": Radix's
    // built-in icon X (top-right) and the explicit footer Close button. We
    // want the footer one — pick the <button> whose visible text is exactly
    // "Close" (the icon X uses an sr-only span and contains an SVG sibling).
    const closeButtons = screen.getAllByRole('button', { name: /^close$/i });
    const footerClose = closeButtons.find((btn) => btn.textContent?.trim() === 'Close');
    expect(footerClose).toBeDefined();
    await user.click(footerClose!);

    expect(useMarketplaceStore.getState().detailPackage).toBeNull();
  });

  it('shows loading skeletons while the detail or preview query is pending', () => {
    useMarketplaceStore.getState().openDetail(makePackage());
    setDetailState({ isLoading: true });
    setPreviewState({ isLoading: true });

    render(<PackageDetailSheet />);

    // DetailSkeleton renders Skeleton placeholders with aria-busy implied.
    // The permissions section should not render until preview resolves.
    expect(screen.queryByText('Permissions & Effects')).not.toBeInTheDocument();
  });

  it('holds the skeleton (no install preview) while the installed list is still loading', () => {
    // The manifest detail resolves first with a `preview`, but the installed
    // list is still loading — so install-state is unknown. The body must hold
    // the skeleton rather than flash the install preview / "No special
    // permissions required", which would flip to the InstalledPanel once the
    // list lands and reveal the package as installed.
    useMarketplaceStore.getState().openDetail(makePackage());
    setDetailState({ data: makeDetail() });
    setPreviewState({ data: makeDetail() });
    setInstalledState([], { isLoading: true });

    render(<PackageDetailSheet />);

    expect(screen.queryByText('Permissions & Effects')).not.toBeInTheDocument();
    expect(screen.queryByText('No special permissions required.')).not.toBeInTheDocument();
    expect(screen.queryByText('Installed globally')).not.toBeInTheDocument();
  });

  it('disables both Uninstall and Reinstall while the uninstall mutation is in flight', () => {
    useMarketplaceStore.getState().openDetail(makePackage());
    setDetailState({ data: makeDetail() });
    setInstalledState([INSTALLED_FIXTURE]);
    setInstalledPackageState(INSTALLED_DETAIL_FIXTURE);
    setUninstallState({ isPending: true });

    render(<PackageDetailSheet />);

    // Uninstall shows its in-flight label and is disabled…
    expect(screen.getByRole('button', { name: /uninstalling/i })).toBeDisabled();
    // …and Reinstall is disabled too, so a click can't fire an install mutation
    // while the uninstall transaction is still moving/removing the target dir.
    expect(screen.getByRole('button', { name: /^reinstall$/i })).toBeDisabled();
  });
});
