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
  useMarketplacePackages,
  usePermissionPreview,
  useInstalledPackages,
  usePackageInstallations,
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
  useMarketplacePackages: vi.fn(),
  usePermissionPreview: vi.fn(),
  useInstalledPackages: vi.fn(),
  usePackageInstallations: vi.fn(),
}));

vi.mock('../model/use-uninstall-with-toast', () => ({
  useUninstallWithToast: vi.fn(),
}));

// The sheet reads which package is open from the URL (`useMarketplaceParams`)
// and resolves it against the catalog (`useMarketplacePackages`). Install-flow
// actions stay on the store.
const mockParams = vi.hoisted(() => ({
  type: 'all' as string,
  sort: 'featured' as string,
  search: '' as string,
  categories: [] as string[],
  selectedPackageName: null as string | null,
  setType: vi.fn(),
  setSort: vi.fn(),
  setSearch: vi.fn(),
  toggleCategory: vi.fn(),
  setCategories: vi.fn(),
  clearCategories: vi.fn(),
  resetFilters: vi.fn(),
  openDetail: vi.fn(),
  closeDetail: vi.fn(),
}));

vi.mock('../model/use-marketplace-params', () => ({
  useMarketplaceParams: () => mockParams,
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

// One installation per scope: the cross-scope installed list and the enriched
// installations endpoint both return entries of this shape.
const GLOBAL_INSTALLATION: InstalledPackage = {
  name: '@dorkos/code-reviewer',
  version: '1.0.0',
  type: 'agent',
  installPath: '/tmp/installed/code-reviewer',
  scope: 'global',
  installedFrom: 'github.com/dorkos/code-reviewer',
};

const AGENT_INSTALLATION: InstalledPackage = {
  name: '@dorkos/code-reviewer',
  version: '1.1.0',
  type: 'agent',
  installPath: '/tmp/agents/e2e/.dork/plugins/code-reviewer',
  scope: 'override',
  agentPath: '/tmp/agents/e2e',
  agentId: 'agent-1',
  agentName: 'E2E Test Agent',
};

// Enriched variant (adds the capability `provides` counts the list omits).
const GLOBAL_INSTALLATION_ENRICHED: InstalledPackage = {
  ...GLOBAL_INSTALLATION,
  installedAt: '2026-01-15T00:00:00.000Z',
  provides: { commands: 3, skills: 2, hooks: true },
};

// ---------------------------------------------------------------------------
// Hook return-value helpers (cast to the hook's return type so each test only
// has to set the fields it cares about).
// ---------------------------------------------------------------------------

type DetailHookState = { data?: MarketplacePackageDetail; isLoading?: boolean };

function setCatalogState(packages: AggregatedPackage[] = []) {
  vi.mocked(useMarketplacePackages).mockReturnValue({
    data: packages,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useMarketplacePackages>);
}

/** Seed an open package: set the URL selection and make it resolvable in the catalog. */
function openPackage(pkg: AggregatedPackage) {
  mockParams.selectedPackageName = pkg.name;
  setCatalogState([pkg]);
}

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

// The enriched installations query (`usePackageInstallations`) is only
// consulted once the list marks the package installed; it fills in the
// `provides` counts.
function setInstallationsState(installations?: InstalledPackage[]) {
  vi.mocked(usePackageInstallations).mockReturnValue({
    data: installations,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof usePackageInstallations>);
}

const uninstallMutate = vi.fn();
function setUninstallState({
  isPending = false,
  variables,
}: {
  isPending?: boolean;
  variables?: { name: string; options?: { projectPath?: string } };
} = {}) {
  vi.mocked(useUninstallWithToast).mockReturnValue({
    mutate: uninstallMutate,
    mutateAsync: vi.fn(),
    isPending,
    variables,
    isSuccess: false,
    isError: false,
    error: null,
    reset: vi.fn(),
  } as unknown as ReturnType<typeof useUninstallWithToast>);
}

// ---------------------------------------------------------------------------
// Store reset helper — snapshot the initial store and restore it before each
// test so installConfirmPackage state never leaks across tests.
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
    mockParams.selectedPackageName = null;
    setCatalogState([]);
    setDetailState();
    setPreviewState();
    setInstalledState([]);
    setInstallationsState();
    setUninstallState();
  });

  afterEach(cleanup);

  it('renders nothing visible when no package is selected', () => {
    render(<PackageDetailSheet />);

    // Sheet is closed → its title should not appear in the document.
    expect(screen.queryByText('@dorkos/code-reviewer')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^install$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^close$/i })).not.toBeInTheDocument();
  });

  it('opens with package name and description when a package is selected in the URL', () => {
    openPackage(makePackage());
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

  it('clears the URL selection when the name does not resolve to a catalog package', () => {
    // A stale/removed `?pkg=` name: selection is set but the loaded catalog does
    // not contain it → the sheet clears the param and stays closed.
    mockParams.selectedPackageName = '@dorkos/removed';
    setCatalogState([makePackage()]);

    render(<PackageDetailSheet />);

    expect(mockParams.closeDetail).toHaveBeenCalled();
    expect(screen.queryByText('@dorkos/removed')).not.toBeInTheDocument();
  });

  it('renders the PermissionPreviewSection when the preview resolves', () => {
    openPackage(makePackage());
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
    // A non-agent package queues the confirm dialog; agent packages leave for
    // the creation flow (covered in use-request-install).
    openPackage(makePackage({ type: 'plugin' }));
    setDetailState({ data: makeDetail() });
    setPreviewState({ data: makeDetail() });
    setInstalledState([]); // not installed

    render(<PackageDetailSheet />);

    const installButton = screen.getByRole('button', { name: /^install$/i });
    expect(installButton).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /uninstall/i })).not.toBeInTheDocument();

    await user.click(installButton);

    // Install action delegates to the store, which should now have the
    // package queued for the install confirmation dialog.
    const state = useMarketplaceStore.getState();
    expect(state.installConfirmPackage).not.toBeNull();
    expect(state.installConfirmPackage?.name).toBe('@dorkos/code-reviewer');
  });

  it('shows the installations panel and uninstalls via two-click confirm', async () => {
    const user = userEvent.setup();
    openPackage(makePackage());
    setDetailState({ data: makeDetail() });
    setPreviewState({ data: makeDetail() });
    setInstalledState([GLOBAL_INSTALLATION]);
    setInstallationsState([GLOBAL_INSTALLATION_ENRICHED]);

    render(<PackageDetailSheet />);

    // Installed branch renders the installations panel (scope rows + provides),
    // not the install permission preview.
    expect(screen.getByText('Installed')).toBeInTheDocument();
    expect(screen.getByText('All agents (global)')).toBeInTheDocument();
    expect(screen.getByText('Provides 3 commands · 2 skills · hooks')).toBeInTheDocument();
    expect(screen.queryByText('Permissions & Effects')).not.toBeInTheDocument();
    expect(screen.queryByText('No special permissions required.')).not.toBeInTheDocument();

    // The footer offers "Install…" (add another scope); the bare Install
    // button of the not-installed branch does not render.
    expect(screen.getByRole('button', { name: 'Install…' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^install$/i })).not.toBeInTheDocument();

    // Uninstall is a two-click confirm: first click arms the row…
    const uninstallButton = screen.getByRole('button', { name: /uninstall for/i });
    await user.click(uninstallButton);
    expect(uninstallMutate).not.toHaveBeenCalled();

    // …second click (now labeled Confirm) fires the mutation.
    await user.click(screen.getByRole('button', { name: /confirm uninstall/i }));
    expect(uninstallMutate).toHaveBeenCalledTimes(1);
    expect(uninstallMutate).toHaveBeenCalledWith({
      name: '@dorkos/code-reviewer',
      options: undefined,
      where: undefined,
    });
  });

  it('renders a Shape-appropriate Provides line instead of an empty capability count', () => {
    // Shapes provide layout/agents/schedules, so their command/skill/hook counts
    // read as zero and formatProvides returns null. The panel must still say
    // something honest about a Shape rather than dropping the line.
    const shapePackage = makePackage({ name: 'linear-ops', type: 'shape' });
    const shapeInstallation: InstalledPackage = {
      name: 'linear-ops',
      version: '2.0.0',
      type: 'shape',
      installPath: '/tmp/.dork/shapes/linear-ops',
      scope: 'global',
      provides: { commands: 0, skills: 0, hooks: false },
    };
    openPackage(shapePackage);
    setDetailState({ data: makeDetail() });
    setInstalledState([shapeInstallation]);
    setInstallationsState([shapeInstallation]);

    render(<PackageDetailSheet />);

    expect(
      screen.getByText('Provides a workspace layout, agents, and schedules')
    ).toBeInTheDocument();
  });

  it('renders one row per installation with agent identity and override badge', () => {
    openPackage(makePackage());
    setDetailState({ data: makeDetail() });
    setInstalledState([GLOBAL_INSTALLATION, AGENT_INSTALLATION]);
    setInstallationsState([GLOBAL_INSTALLATION_ENRICHED, AGENT_INSTALLATION]);

    render(<PackageDetailSheet />);

    expect(screen.getByText('Installed in 2 locations')).toBeInTheDocument();
    expect(screen.getByText('All agents (global)')).toBeInTheDocument();
    expect(screen.getByText('E2E Test Agent')).toBeInTheDocument();
    expect(screen.getByText('Overrides global')).toBeInTheDocument();
    // Per-row versions render independently.
    expect(screen.getByText(/v1\.1\.0/)).toBeInTheDocument();
  });

  it('uninstalling an agent row passes the agent projectPath and scope label', async () => {
    const user = userEvent.setup();
    openPackage(makePackage());
    setDetailState({ data: makeDetail() });
    setInstalledState([GLOBAL_INSTALLATION, AGENT_INSTALLATION]);
    setInstallationsState([GLOBAL_INSTALLATION_ENRICHED, AGENT_INSTALLATION]);

    render(<PackageDetailSheet />);

    const agentUninstall = screen.getByRole('button', {
      name: 'Uninstall for E2E Test Agent',
    });
    await user.click(agentUninstall);
    await user.click(screen.getByRole('button', { name: 'Confirm uninstall for E2E Test Agent' }));

    expect(uninstallMutate).toHaveBeenCalledWith({
      name: '@dorkos/code-reviewer',
      options: { projectPath: '/tmp/agents/e2e' },
      where: 'E2E Test Agent',
    });
  });

  it('falls back to the installed list entries for the panel while the enriched fetch is pending', () => {
    // The enriched installations query hasn't resolved (data undefined), so the
    // panel falls back to the list entries, which already carry scope/agent
    // identity — it should render the rows without waiting. The provides line
    // is simply absent until the enriched fetch lands.
    openPackage(makePackage());
    setDetailState({ data: makeDetail() });
    setInstalledState([GLOBAL_INSTALLATION]);
    setInstallationsState(undefined);

    render(<PackageDetailSheet />);

    expect(screen.getByText('All agents (global)')).toBeInTheDocument();
    expect(screen.getByText('from github.com/dorkos/code-reviewer')).toBeInTheDocument();
    expect(screen.queryByText(/^Provides /)).not.toBeInTheDocument();
  });

  it('row Reinstall delegates to the install confirmation dialog, pre-scoped for agent rows', async () => {
    const user = userEvent.setup();
    // Reinstalling a package INTO a specific agent (agent-local scope) is the
    // legit scoped path — exercised with a non-agent package. An agent package
    // would instead route to a fresh creation (no identity replacement).
    openPackage(makePackage({ type: 'skill-pack' }));
    setDetailState({ data: makeDetail() });
    setInstalledState([GLOBAL_INSTALLATION, AGENT_INSTALLATION]);
    setInstallationsState([GLOBAL_INSTALLATION_ENRICHED, AGENT_INSTALLATION]);

    render(<PackageDetailSheet />);

    // Global row: no agent context — the dialog opens at its default scope.
    await user.click(screen.getByRole('button', { name: 'Reinstall for All agents (global)' }));
    let state = useMarketplaceStore.getState();
    expect(state.installConfirmPackage?.name).toBe('@dorkos/code-reviewer');
    expect(state.installContext).toBeNull();

    // Agent row: pre-scopes the dialog to that agent.
    await user.click(screen.getByRole('button', { name: 'Reinstall for E2E Test Agent' }));
    state = useMarketplaceStore.getState();
    expect(state.installContext).toEqual({
      agentPath: '/tmp/agents/e2e',
      agentName: 'E2E Test Agent',
    });
  });

  it('clicking Close clears the URL selection via closeDetail', async () => {
    const user = userEvent.setup();
    openPackage(makePackage());
    setDetailState({ data: makeDetail() });
    setPreviewState({ data: makeDetail() });

    render(<PackageDetailSheet />);

    // Two buttons in the DOM expose the accessible name "Close": Radix's
    // built-in icon X (top-right) and the explicit footer Close button. We
    // want the footer one — pick the <button> whose visible text is exactly
    // "Close" (the icon X uses an sr-only span and contains an SVG sibling).
    const closeButtons = screen.getAllByRole('button', { name: /^close$/i });
    const footerClose = closeButtons.find((btn) => btn.textContent?.trim() === 'Close');
    expect(footerClose).toBeDefined();
    await user.click(footerClose!);

    expect(mockParams.closeDetail).toHaveBeenCalled();
  });

  it('shows loading skeletons while the detail or preview query is pending', () => {
    openPackage(makePackage());
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
    // permissions required", which would flip to the installations panel once
    // the list lands and reveal the package as installed.
    openPackage(makePackage());
    setDetailState({ data: makeDetail() });
    setPreviewState({ data: makeDetail() });
    setInstalledState([], { isLoading: true });

    render(<PackageDetailSheet />);

    expect(screen.queryByText('Permissions & Effects')).not.toBeInTheDocument();
    expect(screen.queryByText('No special permissions required.')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Installed/)).not.toBeInTheDocument();
  });

  it('disables row actions while an uninstall is in flight and marks the removing row', () => {
    openPackage(makePackage());
    setDetailState({ data: makeDetail() });
    setInstalledState([GLOBAL_INSTALLATION, AGENT_INSTALLATION]);
    setInstallationsState([GLOBAL_INSTALLATION_ENRICHED, AGENT_INSTALLATION]);
    setUninstallState({
      isPending: true,
      variables: { name: '@dorkos/code-reviewer', options: { projectPath: '/tmp/agents/e2e' } },
    });

    render(<PackageDetailSheet />);

    // The in-flight row shows its removing label; every row action is disabled
    // so a click can't fire an install mutation while the uninstall transaction
    // is still moving/removing the target dir.
    expect(screen.getByText('Removing…')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Reinstall for All agents (global)' })
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reinstall for E2E Test Agent' })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Uninstall for All agents (global)' })
    ).toBeDisabled();
    // The footer "Install…" is disabled too.
    expect(screen.getByRole('button', { name: 'Install…' })).toBeDisabled();
  });

  it('renders the README "About" section when the detail carries readme markdown', () => {
    openPackage(makePackage());
    setDetailState({
      data: makeDetail({ readme: '# Linear Ops\n\nSync issues straight from your chat.' }),
    });
    setPreviewState({ data: makeDetail() });

    render(<PackageDetailSheet />);

    // The sheet's own "About" heading plus the streamdown-rendered README body.
    expect(screen.getByRole('heading', { name: 'About' })).toBeInTheDocument();
    expect(screen.getByText('Linear Ops')).toBeInTheDocument();
    expect(screen.getByText('Sync issues straight from your chat.')).toBeInTheDocument();
  });

  it('omits the README section when the detail carries no readme', () => {
    openPackage(makePackage());
    setDetailState({ data: makeDetail() }); // makeDetail() sets no readme
    setPreviewState({ data: makeDetail() });

    render(<PackageDetailSheet />);

    expect(screen.queryByRole('heading', { name: 'About' })).not.toBeInTheDocument();
  });
});
