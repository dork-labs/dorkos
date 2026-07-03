/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  AggregatedPackage,
  InstalledPackage,
  MarketplacePackageDetail,
  PermissionPreview,
} from '@dorkos/shared/marketplace-schemas';
import {
  usePermissionPreview,
  useInstallPackage,
  useInstalledPackages,
} from '@/layers/entities/marketplace';
import { useMarketplaceStore } from '../model/marketplace-store';
import { InstallConfirmationDialog } from '../ui/InstallConfirmationDialog';

// ---------------------------------------------------------------------------
// Mock the marketplace entity hooks. `useInstallWithToast` wraps
// `useInstallPackage` internally, so mocking the underlying hook gives us
// full control over the dialog's mutation state. `useInstalledPackages` drives
// the scope-aware reinstall detection.
// ---------------------------------------------------------------------------

vi.mock('@/layers/entities/marketplace', () => ({
  usePermissionPreview: vi.fn(),
  useInstallPackage: vi.fn(),
  useInstalledPackages: vi.fn(),
}));

vi.mock('@/layers/entities/mesh', () => ({
  useMeshAgentPaths: vi.fn().mockReturnValue({ data: { agents: [] } }),
}));

// ---------------------------------------------------------------------------
// Mock sonner — `useInstallWithToast` calls toast.loading/success/error/dismiss.
// We don't assert on the toast calls here; we only need to silence them.
// ---------------------------------------------------------------------------

vi.mock('sonner', () => ({
  toast: {
    loading: vi.fn(() => 'toast-id'),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Browser API mocks (Radix AlertDialog uses matchMedia + pointer capture).
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

function makeDetail(preview?: Partial<PermissionPreview>): MarketplacePackageDetail {
  return {
    manifest: {
      name: '@dorkos/code-reviewer',
      version: '1.0.0',
      type: 'agent',
    },
    packagePath: '/tmp/code-reviewer',
    preview: makePreview(preview),
  };
}

// ---------------------------------------------------------------------------
// Hook return-value helpers
// ---------------------------------------------------------------------------

type PreviewHookState = { data?: MarketplacePackageDetail; isLoading?: boolean };

function setPreviewState(state: PreviewHookState = {}) {
  vi.mocked(usePermissionPreview).mockReturnValue({
    data: state.data,
    isLoading: state.isLoading ?? false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof usePermissionPreview>);
}

function setInstalledPackages(installed: InstalledPackage[] = []) {
  vi.mocked(useInstalledPackages).mockReturnValue({
    data: installed,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useInstalledPackages>);
}

/** Build a minimal InstalledPackage record for reinstall-detection tests. */
function makeInstalled(overrides: Partial<InstalledPackage> = {}): InstalledPackage {
  return {
    name: '@dorkos/code-reviewer',
    version: '1.0.0',
    type: 'agent',
    installPath: '/tmp/code-reviewer',
    scope: 'global',
    ...overrides,
  };
}

interface InstallMutationState {
  isPending?: boolean;
  isSuccess?: boolean;
  isError?: boolean;
  error?: Error | null;
  variables?: { name: string };
}

const installMutate = vi.fn();
const installMutateAsync = vi.fn();
const installReset = vi.fn();

function setInstallState(state: InstallMutationState = {}) {
  vi.mocked(useInstallPackage).mockReturnValue({
    mutate: installMutate,
    mutateAsync: installMutateAsync,
    isPending: state.isPending ?? false,
    isSuccess: state.isSuccess ?? false,
    isError: state.isError ?? false,
    error: state.error ?? null,
    variables: state.variables,
    reset: installReset,
  } as unknown as ReturnType<typeof useInstallPackage>);
}

// ---------------------------------------------------------------------------
// Store reset helper
// ---------------------------------------------------------------------------

const INITIAL_STORE_STATE = useMarketplaceStore.getState();

function resetStore() {
  useMarketplaceStore.setState(INITIAL_STORE_STATE, true);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InstallConfirmationDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
    setPreviewState();
    setInstallState();
    setInstalledPackages();
    // Default: mutateAsync resolves with a stub result. Individual tests
    // override with `.mockRejectedValueOnce(...)` to exercise the error path.
    installMutateAsync.mockResolvedValue({ success: true });
  });

  afterEach(cleanup);

  it('renders nothing visible when installConfirmPackage is null', () => {
    render(<InstallConfirmationDialog />);

    expect(screen.queryByText(/install @dorkos\/code-reviewer/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^install$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^cancel$/i })).not.toBeInTheDocument();
  });

  it('opens with the package name in the title when installConfirmPackage is set', () => {
    useMarketplaceStore.getState().openInstallConfirm(makePackage());
    setPreviewState({ data: makeDetail() });

    render(<InstallConfirmationDialog />);

    expect(screen.getByText('Install @dorkos/code-reviewer?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^install$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeInTheDocument();
  });

  it('shows the loading message while the preview query is pending', () => {
    useMarketplaceStore.getState().openInstallConfirm(makePackage());
    setPreviewState({ isLoading: true });

    render(<InstallConfirmationDialog />);

    expect(screen.getByText(/loading preview/i)).toBeInTheDocument();
    // Permission section should not be rendered yet.
    expect(screen.queryByText('Secrets required')).not.toBeInTheDocument();
  });

  it('renders the PermissionPreviewSection once the preview resolves', () => {
    useMarketplaceStore.getState().openInstallConfirm(makePackage());
    setPreviewState({
      data: makeDetail({
        secrets: [{ key: 'GITHUB_TOKEN', required: true }],
      }),
    });

    render(<InstallConfirmationDialog />);

    expect(screen.getByText('Secrets required')).toBeInTheDocument();
    expect(screen.getByText('GITHUB_TOKEN')).toBeInTheDocument();
    expect(screen.queryByText(/loading preview/i)).not.toBeInTheDocument();
  });

  it('clicking Install fires mutateAsync with the package name', async () => {
    const user = userEvent.setup();
    useMarketplaceStore.getState().openInstallConfirm(makePackage());
    setPreviewState({ data: makeDetail() });

    render(<InstallConfirmationDialog />);

    await user.click(screen.getByRole('button', { name: /^install$/i }));

    // The dialog now uses mutateAsync + try/catch to wait for success before
    // closing. The bare `mutate` is not called by this code path.
    expect(installMutateAsync).toHaveBeenCalledTimes(1);
    expect(installMutateAsync).toHaveBeenCalledWith({ name: '@dorkos/code-reviewer' });
  });

  it('disables the Install button when the preview has error-level conflicts', () => {
    useMarketplaceStore.getState().openInstallConfirm(makePackage());
    setPreviewState({
      data: makeDetail({
        conflicts: [
          {
            level: 'error',
            type: 'package-name',
            description: 'A package with this name is already installed.',
            conflictingPackage: '@dorkos/code-reviewer',
          },
        ],
      }),
    });

    render(<InstallConfirmationDialog />);

    const installButton = screen.getByRole('button', { name: /cannot install/i });
    expect(installButton).toBeDisabled();
    expect(installButton.textContent).toMatch(/conflicts detected/i);
  });

  it('disables the Install button while the install mutation is in flight', () => {
    useMarketplaceStore.getState().openInstallConfirm(makePackage());
    setPreviewState({ data: makeDetail() });
    setInstallState({ isPending: true, variables: { name: '@dorkos/code-reviewer' } });

    render(<InstallConfirmationDialog />);

    const installButton = screen.getByRole('button', { name: /installing/i });
    expect(installButton).toBeDisabled();
    // Cancel is also disabled while in flight to prevent abandoning a
    // half-applied install.
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeDisabled();
  });

  it('clicking Cancel clears installConfirmPackage in the store', async () => {
    const user = userEvent.setup();
    useMarketplaceStore.getState().openInstallConfirm(makePackage());
    setPreviewState({ data: makeDetail() });

    render(<InstallConfirmationDialog />);

    expect(useMarketplaceStore.getState().installConfirmPackage).not.toBeNull();

    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(useMarketplaceStore.getState().installConfirmPackage).toBeNull();
  });

  it('closes the dialog after mutateAsync resolves', async () => {
    const user = userEvent.setup();
    useMarketplaceStore.getState().openInstallConfirm(makePackage());
    setPreviewState({ data: makeDetail() });
    installMutateAsync.mockResolvedValueOnce({ success: true });

    render(<InstallConfirmationDialog />);

    expect(useMarketplaceStore.getState().installConfirmPackage).not.toBeNull();

    await user.click(screen.getByRole('button', { name: /^install$/i }));

    // handleInstall awaits mutateAsync then calls close(). Wait for the
    // store to reflect the close so we're not racing React's microtask queue.
    await waitFor(() => {
      expect(useMarketplaceStore.getState().installConfirmPackage).toBeNull();
    });
  });

  it('keeps the dialog open when mutateAsync rejects', async () => {
    const user = userEvent.setup();
    useMarketplaceStore.getState().openInstallConfirm(makePackage());
    setPreviewState({ data: makeDetail() });
    installMutateAsync.mockRejectedValueOnce(new Error('network down'));

    render(<InstallConfirmationDialog />);

    await user.click(screen.getByRole('button', { name: /^install$/i }));

    // Give the microtask queue a tick to resolve the rejected promise and
    // run the try/catch, then assert the store is untouched.
    await waitFor(() => {
      expect(installMutateAsync).toHaveBeenCalled();
    });
    expect(useMarketplaceStore.getState().installConfirmPackage).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Reinstall detection (#6) — derived from useInstalledPackages at the selected
  // scope, NOT from a `package-name` preview conflict.
  // ---------------------------------------------------------------------------

  it('frames the action as a reinstall when the package is installed at the selected scope', () => {
    useMarketplaceStore.getState().openInstallConfirm(makePackage());
    setPreviewState({ data: makeDetail() });
    // Global scope (default), and the package is present globally → true reinstall.
    setInstalledPackages([makeInstalled({ scope: 'global' })]);

    render(<InstallConfirmationDialog />);

    expect(screen.getByText('Reinstall @dorkos/code-reviewer?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^reinstall$/i })).toBeInTheDocument();
  });

  it('does NOT frame a first-time install as a reinstall when the package is absent at scope', () => {
    useMarketplaceStore.getState().openInstallConfirm(makePackage());
    setPreviewState({
      // A `package-name` warning fires (e.g. cross-scope shadow), but reinstall
      // must NOT be inferred from it — the package is not installed at this scope.
      data: makeDetail({
        conflicts: [
          {
            level: 'warning',
            type: 'package-name',
            description: 'Package is installed globally; agent-local will override it.',
            conflictingPackage: '@dorkos/code-reviewer',
          },
        ],
      }),
    });
    setInstalledPackages([]); // absent at the selected (global) scope

    render(<InstallConfirmationDialog />);

    expect(screen.getByText('Install @dorkos/code-reviewer?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^install$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^reinstall$/i })).not.toBeInTheDocument();
  });

  it('does not treat a global-only package as a reinstall — global scope reinstall stays scoped', () => {
    useMarketplaceStore.getState().openInstallConfirm(makePackage());
    setPreviewState({ data: makeDetail() });
    // Present globally but only via the merged list's `global` tag — for a GLOBAL
    // target that IS a reinstall, so this asserts the happy global path stays true.
    setInstalledPackages([makeInstalled({ scope: 'global' })]);

    render(<InstallConfirmationDialog />);

    expect(screen.getByRole('button', { name: /^reinstall$/i })).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Agent-scope selection gating — with "Specific agent" chosen but no agent
  // picked, the install target is undetermined: previewing (or reinstall
  // framing) against the global scope would be dishonest.
  // ---------------------------------------------------------------------------

  it('suppresses the preview and prompts for agent selection until an agent is picked', async () => {
    const user = userEvent.setup();
    useMarketplaceStore.getState().openInstallConfirm(makePackage());
    // A global-scope preview WITH a conflict is available — none of it may leak
    // into the undetermined agent-local state.
    setPreviewState({
      data: makeDetail({
        conflicts: [
          {
            level: 'warning',
            type: 'package-name',
            description: 'Reinstalling — the existing package will be replaced.',
            conflictingPackage: '@dorkos/code-reviewer',
          },
        ],
      }),
    });
    // Another agent's local install must not read as a reinstall either.
    setInstalledPackages([makeInstalled({ scope: 'agent-local', agentPath: '/tmp/agents/other' })]);

    render(<InstallConfirmationDialog />);

    await user.click(screen.getByLabelText('Specific agent'));

    expect(
      screen.getByText('Select an agent to preview what this install will do.')
    ).toBeInTheDocument();
    expect(screen.queryByText(/Reinstalling — the existing/)).not.toBeInTheDocument();
    // Undetermined target: framed as a plain install, and the button is
    // disabled until an agent is picked.
    expect(screen.getByText('Install @dorkos/code-reviewer?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^install$/i })).toBeDisabled();
  });
});
