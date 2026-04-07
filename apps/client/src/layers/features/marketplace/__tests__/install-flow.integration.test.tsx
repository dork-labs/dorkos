/**
 * @vitest-environment jsdom
 *
 * Integration test for the Dork Hub browse → detail → confirm → install flow.
 *
 * Drives `<DorkHub />` end-to-end at the UI-wiring level by mocking the
 * marketplace entity hooks (and the `useInstallWithToast` wrapper) instead
 * of the underlying Transport. This keeps the test focused on Zustand store
 * transitions, modal portal mounting, and prop plumbing between
 * `PackageGrid` → `PackageDetailSheet` → `InstallConfirmationDialog`.
 *
 * MARKETPLACE TRANSACTION TESTING RULE (from CLAUDE.md):
 * `services/marketplace/transaction.ts` runs `git reset --hard <backup-branch>`
 * against `process.cwd()` on failure paths. Any test exercising a marketplace
 * flow that passes `rollbackBranch: true` MUST mock `_internal.isGitRepo` in
 * `beforeEach` to return `false`, or the rollback will silently destroy
 * uncommitted tracked-file work. See `contributing/marketplace-installs.md`
 * §5 and ADR-0231.
 *
 * This test does NOT need that mock — it intercepts the install at the
 * `useInstallWithToast` hook level and never reaches the server-side
 * transaction code. Future variants that swap in a real transport must add
 * the `_internal.isGitRepo` mock before exercising any rollback path.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  useUninstallPackage,
} from '@/layers/entities/marketplace';
import { useInstallWithToast } from '../model/use-install-with-toast';
import { useDorkHubStore } from '../model/dork-hub-store';
import { DorkHub } from '../ui/DorkHub';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock every marketplace entity hook DorkHub's subtree consumes. Each test
// drives the data layer through the typed `set*` helpers below.
vi.mock('@/layers/entities/marketplace', () => ({
  useMarketplacePackages: vi.fn(),
  useMarketplacePackage: vi.fn(),
  usePermissionPreview: vi.fn(),
  useInstalledPackages: vi.fn(),
  useUninstallPackage: vi.fn(),
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
  reset: ReturnType<typeof vi.fn>;
}

function setInstallWithToastState(): InstallMutationHandle {
  const mutate = vi.fn();
  const reset = vi.fn();
  vi.mocked(useInstallWithToast).mockReturnValue({
    mutate,
    reset,
    isPending: false,
    isSuccess: false,
    isError: false,
    variables: undefined,
  } as unknown as ReturnType<typeof useInstallWithToast>);
  return { mutate, reset };
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
// Store reset — keep ephemeral UI state out of the next test.
// ---------------------------------------------------------------------------

function resetDorkHubStore() {
  useDorkHubStore.setState(
    {
      detailPackage: null,
      installConfirmPackage: null,
    },
    false
  );
  // Reset the filter slice through the store's own action so we don't have to
  // duplicate the INITIAL_FILTERS shape here.
  useDorkHubStore.getState().resetFilters();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DorkHub install flow integration', () => {
  let installHandle: InstallMutationHandle;

  beforeEach(() => {
    vi.clearAllMocks();
    resetDorkHubStore();

    setMarketplacePackagesState([PKG]);
    setMarketplacePackageDetailState(PKG_DETAIL);
    setPermissionPreviewState(PKG_DETAIL);
    setInstalledPackagesState([]);
    setUninstallMutationState();
    installHandle = setInstallWithToastState();
  });

  afterEach(() => {
    cleanup();
    resetDorkHubStore();
  });

  it('drives the full browse → detail → confirm → install flow end-to-end', async () => {
    const user = userEvent.setup();
    render(<DorkHub />);

    // 1. Grid has rendered the seeded package card.
    const card = screen.getByTestId(`package-card-${PKG.name}`);
    expect(card).toBeInTheDocument();
    expect(within(card).getByText(PKG.name)).toBeInTheDocument();

    // 2. Click the card body → detail sheet opens via the store.
    await user.click(card);

    expect(useDorkHubStore.getState().detailPackage?.name).toBe(PKG.name);
    // Detail sheet portal mounts the package title inside a Radix dialog.
    const sheetTitle = await screen.findByRole('heading', { name: PKG.name });
    expect(sheetTitle).toBeInTheDocument();

    // 3. Click "Install" inside the detail sheet → install confirmation
    //    dialog opens via openInstallConfirm.
    const sheetInstallButton = screen.getByRole('button', { name: /^install$/i });
    await user.click(sheetInstallButton);

    expect(useDorkHubStore.getState().installConfirmPackage?.name).toBe(PKG.name);

    // 4. Confirmation dialog renders with the "Install <name>?" title.
    const confirmHeading = await screen.findByRole('heading', {
      name: new RegExp(`install ${PKG.name}\\?`, 'i'),
    });
    expect(confirmHeading).toBeInTheDocument();

    // 5. Click the dialog's Install button → install mutation fires with the
    //    package name. The dialog's button is the only "Install" (not
    //    "Installing…" / not "Cancel") inside the alertdialog scope.
    const dialog = screen.getByRole('alertdialog');
    const dialogInstallButton = within(dialog).getByRole('button', { name: /^install$/i });
    await user.click(dialogInstallButton);

    expect(installHandle.mutate).toHaveBeenCalledTimes(1);
    expect(installHandle.mutate).toHaveBeenCalledWith({ name: PKG.name });
  });

  it('clicking Install on the card opens the confirmation dialog directly without the detail sheet', async () => {
    const user = userEvent.setup();
    render(<DorkHub />);

    // The inner "Install →" button on the card opens confirm directly.
    await user.click(screen.getByText('Install →'));

    const state = useDorkHubStore.getState();
    expect(state.installConfirmPackage?.name).toBe(PKG.name);
    expect(state.detailPackage).toBeNull();

    // Confirm the install mutation still wires through from the dialog.
    const dialog = await screen.findByRole('alertdialog');
    const dialogInstallButton = within(dialog).getByRole('button', { name: /^install$/i });
    await user.click(dialogInstallButton);

    expect(installHandle.mutate).toHaveBeenCalledWith({ name: PKG.name });
  });
});
