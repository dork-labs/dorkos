/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  AggregatedPackage,
  MarketplacePackageDetail,
  PermissionPreview,
} from '@dorkos/shared/marketplace-schemas';
import { usePermissionPreview, useInstallPackage } from '@/layers/entities/marketplace';
import { useDorkHubStore } from '../model/dork-hub-store';
import { InstallConfirmationDialog } from '../ui/InstallConfirmationDialog';

// ---------------------------------------------------------------------------
// Mock the marketplace entity hooks. `useInstallWithToast` wraps
// `useInstallPackage` internally, so mocking the underlying hook gives us
// full control over the dialog's mutation state.
// ---------------------------------------------------------------------------

vi.mock('@/layers/entities/marketplace', () => ({
  usePermissionPreview: vi.fn(),
  useInstallPackage: vi.fn(),
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

interface InstallMutationState {
  isPending?: boolean;
  isSuccess?: boolean;
  isError?: boolean;
  error?: Error | null;
  variables?: { name: string };
}

const installMutate = vi.fn();
const installReset = vi.fn();

function setInstallState(state: InstallMutationState = {}) {
  vi.mocked(useInstallPackage).mockReturnValue({
    mutate: installMutate,
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

const INITIAL_STORE_STATE = useDorkHubStore.getState();

function resetStore() {
  useDorkHubStore.setState(INITIAL_STORE_STATE, true);
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
  });

  afterEach(cleanup);

  it('renders nothing visible when installConfirmPackage is null', () => {
    render(<InstallConfirmationDialog />);

    expect(screen.queryByText(/install @dorkos\/code-reviewer/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^install$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^cancel$/i })).not.toBeInTheDocument();
  });

  it('opens with the package name in the title when installConfirmPackage is set', () => {
    useDorkHubStore.getState().openInstallConfirm(makePackage());
    setPreviewState({ data: makeDetail() });

    render(<InstallConfirmationDialog />);

    expect(screen.getByText('Install @dorkos/code-reviewer?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^install$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeInTheDocument();
  });

  it('shows the loading message while the preview query is pending', () => {
    useDorkHubStore.getState().openInstallConfirm(makePackage());
    setPreviewState({ isLoading: true });

    render(<InstallConfirmationDialog />);

    expect(screen.getByText(/loading preview/i)).toBeInTheDocument();
    // Permission section should not be rendered yet.
    expect(screen.queryByText('Secrets required')).not.toBeInTheDocument();
  });

  it('renders the PermissionPreviewSection once the preview resolves', () => {
    useDorkHubStore.getState().openInstallConfirm(makePackage());
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

  it('clicking Install fires the mutation with the package name', async () => {
    const user = userEvent.setup();
    useDorkHubStore.getState().openInstallConfirm(makePackage());
    setPreviewState({ data: makeDetail() });

    render(<InstallConfirmationDialog />);

    await user.click(screen.getByRole('button', { name: /^install$/i }));

    expect(installMutate).toHaveBeenCalledTimes(1);
    expect(installMutate).toHaveBeenCalledWith({ name: '@dorkos/code-reviewer' });
  });

  it('disables the Install button when the preview has error-level conflicts', () => {
    useDorkHubStore.getState().openInstallConfirm(makePackage());
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
    useDorkHubStore.getState().openInstallConfirm(makePackage());
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
    useDorkHubStore.getState().openInstallConfirm(makePackage());
    setPreviewState({ data: makeDetail() });

    render(<InstallConfirmationDialog />);

    expect(useDorkHubStore.getState().installConfirmPackage).not.toBeNull();

    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(useDorkHubStore.getState().installConfirmPackage).toBeNull();
  });

  it('closes the dialog automatically once the install mutation reports success', async () => {
    useDorkHubStore.getState().openInstallConfirm(makePackage());
    setPreviewState({ data: makeDetail() });
    // Simulate a successful install: the dialog's useEffect should call
    // closeInstallConfirm() in response.
    setInstallState({ isSuccess: true, variables: { name: '@dorkos/code-reviewer' } });

    render(<InstallConfirmationDialog />);

    await waitFor(() => {
      expect(useDorkHubStore.getState().installConfirmPackage).toBeNull();
    });
  });
});
