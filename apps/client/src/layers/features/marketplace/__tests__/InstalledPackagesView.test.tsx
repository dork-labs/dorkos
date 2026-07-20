/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, act, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InstalledPackage, InstalledShapeSummary } from '@dorkos/shared/marketplace-schemas';
import { useInstalledPackages } from '@/layers/entities/marketplace';
import { useShapes } from '@/layers/entities/shapes';
import { useAppStore } from '@/layers/shared/model';

import { useUninstallWithToast } from '../model/use-uninstall-with-toast';
import { useUpdateWithToast } from '../model/use-update-with-toast';
import { InstalledPackagesView } from '../ui/InstalledPackagesView';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
// The view drives uninstall/update through the feature-layer toast wrappers
// (which fire sonner notifications), so mock those rather than the raw entity
// mutation hooks.

vi.mock('@/layers/entities/marketplace', () => ({
  useInstalledPackages: vi.fn(),
}));

vi.mock('@/layers/entities/shapes', () => ({
  useShapes: vi.fn(),
}));

vi.mock('../model/use-uninstall-with-toast', () => ({
  useUninstallWithToast: vi.fn(),
}));

vi.mock('../model/use-update-with-toast', () => ({
  useUpdateWithToast: vi.fn(),
}));

const uninstallMutate = vi.fn();
const updateMutate = vi.fn();

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

function setUpdateState(state: MutationMockState = {}) {
  vi.mocked(useUpdateWithToast).mockReturnValue({
    mutate: updateMutate,
    mutateAsync: vi.fn(),
    isPending: state.isPending ?? false,
    isSuccess: false,
    isError: false,
    error: null,
    variables: state.variables,
    reset: vi.fn(),
  } as unknown as ReturnType<typeof useUpdateWithToast>);
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InstalledPackagesView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setUninstallState();
    setUpdateState();
    setShapesState();
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

  describe('update action', () => {
    it('fires the update mutation with apply: true on click', async () => {
      const user = userEvent.setup();
      setInstalledState({ data: [makeInstalled({ name: '@dorkos/reviewer' })] });

      render(<InstalledPackagesView />);

      await user.click(screen.getByRole('button', { name: /check for updates to Reviewer/i }));

      expect(updateMutate).toHaveBeenCalledTimes(1);
      expect(updateMutate).toHaveBeenCalledWith({
        name: '@dorkos/reviewer',
        options: { apply: true },
      });
    });

    it('disables only the row whose update is in flight', () => {
      setInstalledState({
        data: [
          makeInstalled({ name: '@dorkos/reviewer' }),
          makeInstalled({ name: '@dorkos/formatter' }),
        ],
      });
      setUpdateState({ isPending: true, variables: { name: '@dorkos/reviewer' } });

      render(<InstalledPackagesView />);

      const reviewerBtn = screen.getByRole('button', {
        name: /check for updates to Reviewer/i,
      });
      const formatterBtn = screen.getByRole('button', {
        name: /check for updates to Formatter/i,
      });

      expect(reviewerBtn).toBeDisabled();
      expect(reviewerBtn.textContent).toMatch(/updating/i);
      expect(formatterBtn).not.toBeDisabled();
      expect(formatterBtn.textContent).toMatch(/^update/i);
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
