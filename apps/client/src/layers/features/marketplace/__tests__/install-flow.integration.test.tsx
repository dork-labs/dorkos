/**
 * @vitest-environment jsdom
 *
 * Integration test for the Marketplace browse → detail → confirm → install flow.
 *
 * Drives `<Marketplace />` end-to-end at the UI-wiring level by mocking the
 * marketplace entity hooks (and the `useInstallWithToast` wrapper) instead
 * of the underlying Transport. Browse/drawer state rides the URL, so the
 * subtree is rendered inside a real in-memory TanStack router at
 * `/marketplace` — this exercises the actual `useMarketplaceParams` deep-link
 * wiring rather than a mocked hook.
 *
 * This test intercepts the install at the `useInstallWithToast` hook level and
 * never reaches the server-side transaction code. The server transaction engine
 * is file-scoped and git-free (ADR-0304): it writes only to the install target
 * and a temp staging dir, never to `process.cwd()`, so there is no worktree
 * hazard even for a future variant that swaps in a real transport. Point any
 * such variant at a temp `dorkHome` so it does not mutate the real one. See
 * `contributing/marketplace-installs.md` §5.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import type {
  AggregatedPackage,
  InstalledPackage,
  MarketplacePackageDetail,
  PermissionPreview,
} from '@dorkos/shared/marketplace-schemas';
import {
  useMarketplacePackages,
  useMarketplacePackage,
  usePermissionPreview,
  useInstalledPackages,
  useInstalledPackage,
  useUninstallPackage,
} from '@/layers/entities/marketplace';
import { useConfig, useUpdateConfig } from '@/layers/entities/config';
import { mergeDialogSearch } from '@/layers/shared/model/dialog-search-schema';
import { useInstallWithToast } from '../model/use-install-with-toast';
import { useMarketplaceStore } from '../model/marketplace-store';
import { marketplaceSearchSchema } from '../model/marketplace-search';
import { Marketplace } from '../ui/Marketplace';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock every marketplace entity hook Marketplace's subtree consumes. Each test
// drives the data layer through the typed `set*` helpers below.
vi.mock('@/layers/entities/marketplace', () => ({
  useMarketplacePackages: vi.fn(),
  useMarketplacePackage: vi.fn(),
  usePermissionPreview: vi.fn(),
  useInstalledPackages: vi.fn(),
  useInstalledPackage: vi.fn(),
  useUninstallPackage: vi.fn(),
}));

vi.mock('@/layers/entities/mesh', () => ({
  useMeshAgentPaths: vi.fn().mockReturnValue({ data: { agents: [] } }),
}));

// Mock the config entity. The TelemetryConsentBanner rendered at the top of
// Marketplace depends on `useConfig` + `useUpdateConfig`. Default to a config
// where the user has already decided so the banner is hidden and the existing
// flow assertions are unaffected.
vi.mock('@/layers/entities/config', () => ({
  useConfig: vi.fn(),
  useUpdateConfig: vi.fn(),
}));

// Mock the install-with-toast wrapper directly so we can spy on `mutate`
// without depending on TanStack Query lifecycle or sonner side effects.
vi.mock('../model/use-install-with-toast', () => ({
  useInstallWithToast: vi.fn(),
}));

// Defensive sonner mock — `useInstallWithToast` is mocked above so sonner is
// not actually called, but `model/use-install-with-toast.ts` still imports
// `toast` at module load. Stubbing here keeps the import graph happy if
// any future direct usage appears.
vi.mock('sonner', () => ({
  toast: {
    loading: vi.fn(() => 'toast-id'),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Real in-memory router — the marketplace subtree reads browse/drawer state
// from the URL (`useMarketplaceParams`), so it must render inside a router
// whose route id matches `/_shell/marketplace`.
// ---------------------------------------------------------------------------

function renderMarketplace() {
  const rootRoute = createRootRoute();
  const shellRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: '_shell',
    component: () => <Outlet />,
  });
  const marketplaceRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: '/marketplace',
    validateSearch: zodValidator(mergeDialogSearch(marketplaceSearchSchema)),
    component: () => <Marketplace />,
  });
  const routeTree = rootRoute.addChildren([shellRoute.addChildren([marketplaceRoute])]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/marketplace'] }),
  });
  return render(<RouterProvider router={router} />);
}

// ---------------------------------------------------------------------------
// Hook state helpers — typed wrappers around the mock setters
// ---------------------------------------------------------------------------

function setMarketplacePackagesState(data: AggregatedPackage[]) {
  vi.mocked(useMarketplacePackages).mockReturnValue({
    data,
    error: null,
    isLoading: false,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useMarketplacePackages>);
}

function setMarketplacePackageDetailState(detail: MarketplacePackageDetail) {
  vi.mocked(useMarketplacePackage).mockReturnValue({
    data: detail,
    error: null,
    isLoading: false,
  } as unknown as ReturnType<typeof useMarketplacePackage>);
}

function setPermissionPreviewState(detail: MarketplacePackageDetail) {
  vi.mocked(usePermissionPreview).mockReturnValue({
    data: detail,
    error: null,
    isLoading: false,
  } as unknown as ReturnType<typeof usePermissionPreview>);
}

function setInstalledPackagesState(installed: InstalledPackage[]) {
  vi.mocked(useInstalledPackages).mockReturnValue({
    data: installed,
    error: null,
    isLoading: false,
  } as unknown as ReturnType<typeof useInstalledPackages>);
}

// The drawer fetches the enriched single-package record only when installed;
// this flow installs a not-yet-installed package, so `data` stays undefined.
function setInstalledPackageState(detail?: InstalledPackage) {
  vi.mocked(useInstalledPackage).mockReturnValue({
    data: detail,
    error: null,
    isLoading: false,
  } as unknown as ReturnType<typeof useInstalledPackage>);
}

function setUninstallMutationState() {
  vi.mocked(useUninstallPackage).mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    reset: vi.fn(),
  } as unknown as ReturnType<typeof useUninstallPackage>);
}

interface InstallMutationHandle {
  mutate: ReturnType<typeof vi.fn>;
  mutateAsync: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
}

function setConfigState() {
  vi.mocked(useConfig).mockReturnValue({
    data: {
      telemetry: { enabled: false, userHasDecided: true },
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useConfig>);

  vi.mocked(useUpdateConfig).mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
    reset: vi.fn(),
  } as unknown as ReturnType<typeof useUpdateConfig>);
}

function setInstallWithToastState(): InstallMutationHandle {
  const mutate = vi.fn();
  const mutateAsync = vi.fn().mockResolvedValue({ success: true });
  const reset = vi.fn();
  vi.mocked(useInstallWithToast).mockReturnValue({
    mutate,
    mutateAsync,
    reset,
    isPending: false,
    isSuccess: false,
    isError: false,
    variables: undefined,
  } as unknown as ReturnType<typeof useInstallWithToast>);
  return { mutate, mutateAsync, reset };
}

// ---------------------------------------------------------------------------
// Browser API mocks (Radix Sheet + AlertDialog need matchMedia)
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
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PKG: AggregatedPackage = {
  name: '@dorkos/code-reviewer',
  source: 'https://github.com/dorkos/code-reviewer.git',
  description: 'Automated PR code review agent',
  type: 'agent',
  marketplace: 'dorkos-official',
};

const EMPTY_PREVIEW: PermissionPreview = {
  fileChanges: [{ path: 'agents/code-reviewer/agent.json', action: 'create' }],
  extensions: [],
  tasks: [],
  secrets: [],
  externalHosts: [],
  requires: [],
  conflicts: [],
};

const PKG_DETAIL: MarketplacePackageDetail = {
  manifest: {
    name: '@dorkos/code-reviewer',
    version: '1.0.0',
    type: 'agent',
    description: 'Automated PR code review agent',
    author: 'DorkOS',
    license: 'MIT',
  },
  packagePath: '/tmp/.dork/staging/code-reviewer',
  preview: EMPTY_PREVIEW,
};

// ---------------------------------------------------------------------------
// Store reset — keep ephemeral install state out of the next test.
// ---------------------------------------------------------------------------

function resetMarketplaceStore() {
  useMarketplaceStore.setState({ installConfirmPackage: null, installContext: null }, false);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Marketplace install flow integration', () => {
  let installHandle: InstallMutationHandle;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMarketplaceStore();

    setMarketplacePackagesState([PKG]);
    setMarketplacePackageDetailState(PKG_DETAIL);
    setPermissionPreviewState(PKG_DETAIL);
    setInstalledPackagesState([]);
    setInstalledPackageState(undefined);
    setUninstallMutationState();
    setConfigState();
    installHandle = setInstallWithToastState();
  });

  afterEach(() => {
    cleanup();
    resetMarketplaceStore();
  });

  it('drives the full browse → detail → confirm → install flow end-to-end', async () => {
    const user = userEvent.setup();
    renderMarketplace();

    // 1. Grid has rendered the seeded package card. The package may appear in
    //    both the Popular Packages rail and the grid — pick the first.
    const cards = await screen.findAllByTestId(`package-card-${PKG.name}`);
    const card = cards[0];
    expect(card).toBeInTheDocument();
    expect(within(card).getByText(PKG.name)).toBeInTheDocument();

    // 2. Click the card body → detail sheet opens via the URL (?pkg=<name>).
    await user.click(card);

    // Detail sheet portal mounts the package title inside a Radix dialog.
    const sheetTitle = await screen.findByRole('heading', { name: PKG.name });
    expect(sheetTitle).toBeInTheDocument();

    // 3. Click "Install" inside the detail sheet → install confirmation
    //    dialog opens via openInstallConfirm.
    const sheetInstallButton = screen.getByRole('button', { name: /^install$/i });
    await user.click(sheetInstallButton);

    expect(useMarketplaceStore.getState().installConfirmPackage?.name).toBe(PKG.name);

    // 4. Confirmation dialog renders with the "Install <name>?" title.
    const confirmHeading = await screen.findByRole('heading', {
      name: new RegExp(`install ${PKG.name}\\?`, 'i'),
    });
    expect(confirmHeading).toBeInTheDocument();

    // 5. Click the dialog's Install button → install mutation fires with the
    //    package name. The dialog uses `mutateAsync` + try/catch to await
    //    success before closing, so the spy to assert on is `mutateAsync`
    //    (not the bare `mutate`). The dialog's button is the only "Install"
    //    (not "Installing…" / not "Cancel") inside the dialog scope.
    const dialog = screen.getByRole('dialog');
    const dialogInstallButton = within(dialog).getByRole('button', { name: /^install$/i });
    await user.click(dialogInstallButton);

    expect(installHandle.mutateAsync).toHaveBeenCalledTimes(1);
    expect(installHandle.mutateAsync).toHaveBeenCalledWith({ name: PKG.name });
  });

  it('clicking Install on the card opens the confirmation dialog directly without the detail sheet', async () => {
    const user = userEvent.setup();
    renderMarketplace();

    // The package may appear in both the Popular Packages rail and the grid.
    // Scope the click to the first matching Install button.
    const installButtons = await screen.findAllByText('Install');
    await user.click(installButtons[0]);

    expect(useMarketplaceStore.getState().installConfirmPackage?.name).toBe(PKG.name);
    // The detail drawer must NOT have opened — its title heading is absent.
    expect(screen.queryByRole('heading', { name: PKG.name })).not.toBeInTheDocument();

    // Confirm the install mutation still wires through from the dialog.
    const dialog = await screen.findByRole('dialog');
    const dialogInstallButton = within(dialog).getByRole('button', { name: /^install$/i });
    await user.click(dialogInstallButton);

    expect(installHandle.mutateAsync).toHaveBeenCalledWith({ name: PKG.name });
  });
});
