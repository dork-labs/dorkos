// @vitest-environment jsdom
/**
 * The footer strip: one row, four destinations, Ask DorkBot, and an update pill
 * that exists only while an update does.
 *
 * The suite this replaces belonged to `SidebarFooterBar` — the three-row footer
 * of logo, icon cluster and version line that BC-47 retires. The cases that
 * still describe live behaviour (settings reachable, an update announced, a
 * dismissal remembered) moved here onto their new surface; the ones that
 * described the branding block and the version row are gone with it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

// ---------------------------------------------------------------------------
// Router. Navigating moves the location, so an "active route" assertion reads
// the same value the app would.
// ---------------------------------------------------------------------------
const mockNavigate = vi.fn();
let mockPathname = '/marketplace';
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: mockPathname } }),
}));

// ---------------------------------------------------------------------------
// Server config: the version, the published latest, and the dismissals.
// ---------------------------------------------------------------------------
let mockConfigData: Record<string, unknown> | undefined;
const mockUpdateConfigMutate = vi.fn();
vi.mock('@/layers/entities/config/model/use-config', () => ({
  useConfig: () => ({ data: mockConfigData }),
}));
vi.mock('@/layers/entities/config/model/use-update-config', () => ({
  useUpdateConfig: () => ({ mutate: mockUpdateConfigMutate, isPending: false }),
}));

// ---------------------------------------------------------------------------
// The roster, which is where DorkBot's address comes from.
// ---------------------------------------------------------------------------
let mockAgents: { id: string; name: string; projectPath: string }[] = [
  { id: 'a1', name: 'dorkbot', projectPath: '/home/me/.dork/agents/dorkbot' },
  { id: 'a2', name: 'tangerine', projectPath: '/projects/tangerine' },
];
vi.mock('@/layers/entities/mesh/model/use-mesh-agent-paths', () => ({
  useMeshAgentPaths: () => ({ data: { agents: mockAgents } }),
}));

// ---------------------------------------------------------------------------
// The desktop native updater. Off by default: these run in a browser.
// ---------------------------------------------------------------------------
let mockDesktop: { isDesktop: boolean; status: { state: string; version?: string } | null } = {
  isDesktop: false,
  status: null,
};
const mockRestart = vi.fn();
vi.mock('@/layers/features/session-list/model/use-desktop-updater', () => ({
  useDesktopUpdater: () => ({ ...mockDesktop, restart: mockRestart }),
}));

// The `sidebar.footer` extension slot, standing in for what `main.tsx`
// registers. Two of these are built-ins whose handlers the strip overrides by
// id; `edit-agent` is a plain contribution, which is what an extension's looks
// like.
const MockIcon = () => null;
const mockAgentDialog = vi.fn();
vi.mock('@/layers/shared/model/extension-registry', () => ({
  useSlotContributions: () => [
    {
      id: 'edit-agent',
      icon: MockIcon,
      label: 'Edit Agent',
      onClick: mockAgentDialog,
      priority: 1,
    },
    { id: 'settings', icon: MockIcon, label: 'Settings', onClick: () => {}, priority: 2 },
    { id: 'theme', icon: MockIcon, label: 'Toggle Theme', onClick: () => {}, priority: 3 },
    {
      id: 'devtools',
      icon: MockIcon,
      label: 'Devtools',
      onClick: () => {},
      priority: 4,
      showInDevOnly: true,
    },
  ],
}));

const mockSetTheme = vi.fn();
let mockTheme = 'light';
vi.mock('@/layers/shared/model/use-theme', () => ({
  useTheme: () => ({ theme: mockTheme, setTheme: mockSetTheme }),
}));

const mockOpenSettings = vi.fn();
vi.mock('@/layers/shared/model/use-dialog-deep-link', () => ({
  useSettingsDeepLink: () => ({
    isOpen: false,
    activeTab: null,
    section: null,
    open: mockOpenSettings,
    close: vi.fn(),
    setTab: vi.fn(),
    setSection: vi.fn(),
  }),
}));

import { TooltipProvider } from '@/layers/shared/ui';
import { takeAskDorkBotOrigin } from '@/layers/shared/lib';
import { buildSidebarModel } from '../model/build-sidebar-model';
import { busyFixture } from '../model/fixtures';
import { SidebarFooterStrip } from '../ui/SidebarFooterStrip';

/** Mount the strip with the one provider its tooltips need. */
function renderStrip() {
  return render(
    <TooltipProvider>
      <SidebarFooterStrip />
    </TooltipProvider>
  );
}

/** The strip's single row — what BC-47's "one row" means in the DOM. */
function row() {
  return screen.getByTestId('sidebar-footer-strip-row');
}

describe('SidebarFooterStrip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = '/marketplace';
    mockConfigData = {
      version: '1.2.3',
      latestVersion: null,
      isDevMode: false,
      dismissedUpgradeVersions: [],
    };
    mockAgents = [
      { id: 'a1', name: 'dorkbot', projectPath: '/home/me/.dork/agents/dorkbot' },
      { id: 'a2', name: 'tangerine', projectPath: '/projects/tangerine' },
    ];
    mockDesktop = { isDesktop: false, status: null };
    mockTheme = 'light';
    takeAskDorkBotOrigin();
  });

  afterEach(() => {
    cleanup();
  });

  // ── BC-47: one slim tinted strip ─────────────────────────────────────────

  it('is one row: the four destinations, one overflow glyph, then Ask DorkBot', () => {
    renderStrip();

    const buttons = within(row()).getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Home',
      'Team',
      'Marketplace',
      'Connections',
      'More',
      'Ask DorkBot',
    ]);
  });

  it('keeps the Ask DorkBot label on one line', () => {
    renderStrip();

    // Measured, not assumed: laid out as peers rather than folded into `More`,
    // the footer contributions wrapped this label onto a second line in a real
    // 272px panel, which is what turned a "slim strip" into a two-line block.
    expect(screen.getByLabelText('Ask DorkBot').className).toContain('whitespace-nowrap');
  });

  it('keeps the sidebar.footer extension seam alive', async () => {
    renderStrip();

    // A contribution nothing special-cases still gets a row and still fires: the
    // slot is a published API, and the footer redesign must not quietly orphan
    // whatever an extension put there.
    await userEvent.click(screen.getByLabelText('More'));
    await userEvent.click(await screen.findByText('Edit Agent'));
    expect(mockAgentDialog).toHaveBeenCalled();
  });

  it('opens settings through the URL deep link', async () => {
    renderStrip();

    await userEvent.click(screen.getByLabelText('More'));
    await userEvent.click(await screen.findByText('Settings'));
    expect(mockOpenSettings).toHaveBeenCalled();
  });

  it.each([
    ['light', 'dark'],
    ['dark', 'system'],
    ['system', 'light'],
  ])('cycles the theme from %s to %s', async (from, to) => {
    mockTheme = from;
    renderStrip();

    await userEvent.click(screen.getByLabelText('More'));
    await userEvent.click(await screen.findByText('Theme'));
    expect(mockSetTheme).toHaveBeenCalledWith(to);
  });

  it('carries no logo block and no version line', () => {
    renderStrip();

    // The brand link the old footer wore, and the `v1.2.3` beside it. The
    // version is loaded (the pill cases below prove this mock is live), so a
    // version line would be drawn if the component still drew one.
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByText(/v1\.2\.3/)).toBeNull();
  });

  it('separates by tint, never by a border', () => {
    const { container } = renderStrip();

    const bordered = container.querySelectorAll('[class*="border-t"]');
    expect(bordered).toHaveLength(0);
    // The tint itself, and specifically NOT `--muted`, which inverts between
    // themes (spec R1).
    expect(row().className).toContain('bg-sidebar-accent');
    expect(container.innerHTML).not.toContain('bg-muted');
  });

  // ── Destinations ─────────────────────────────────────────────────────────

  it.each([
    ['Home', '/'],
    ['Team', '/team'],
    ['Marketplace', '/marketplace'],
    ['Connections', '/connections'],
  ])('%s navigates to %s', (label, to) => {
    renderStrip();

    fireEvent.click(screen.getByLabelText(label));
    expect(mockNavigate).toHaveBeenCalledWith({ to });
  });

  it('gives the active route the active tint and nothing else', () => {
    mockPathname = '/marketplace';
    renderStrip();

    const marketplace = screen.getByLabelText('Marketplace');
    expect(marketplace).toHaveAttribute('aria-current', 'page');
    expect(marketplace.className).toContain('bg-sidebar/70');
    for (const other of ['Home', 'Team', 'Connections']) {
      expect(screen.getByLabelText(other)).not.toHaveAttribute('aria-current');
      expect(screen.getByLabelText(other).className).not.toContain('bg-sidebar/70');
    }
  });

  it('reads Home as active across the whole home surface', () => {
    mockPathname = '/activity';
    renderStrip();

    expect(screen.getByLabelText('Home')).toHaveAttribute('aria-current', 'page');
  });

  it('keeps the Team anchor the e2e specs and tours resolve', () => {
    renderStrip();

    expect(screen.getByTestId('nav-agents')).toHaveAttribute('aria-label', 'Team');
  });

  // ── BC-48: Ask DorkBot ───────────────────────────────────────────────────

  it('opens a fresh DorkBot session carrying the seed, and records where you came from', () => {
    mockPathname = '/marketplace';
    renderStrip();

    fireEvent.click(screen.getByLabelText('Ask DorkBot'));

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    const call = mockNavigate.mock.calls[0][0] as {
      to: string;
      search: { dir?: string; session?: string; seed?: string };
    };
    expect(call.to).toBe('/session');
    expect(call.search.dir).toBe('/home/me/.dork/agents/dorkbot');
    expect(call.search.seed).toBe('dorkbot-help');
    // A FRESH conversation: a minted id, not a resolved one.
    expect(call.search.session).toMatch(/^[0-9a-f-]{36}$/);
    expect(takeAskDorkBotOrigin()).toBe('/marketplace');
  });

  it('waits rather than guessing while the roster has not answered', () => {
    mockAgents = [];
    renderStrip();

    const ask = screen.getByLabelText('Ask DorkBot');
    expect(ask).toBeDisabled();
    fireEvent.click(ask);
    expect(mockNavigate).not.toHaveBeenCalled();
    // …and the same button works the moment DorkBot has an address, which is
    // what makes the assertion above about readiness rather than about a button
    // that never works.
    cleanup();
    mockAgents = [{ id: 'a1', name: 'dorkbot', projectPath: '/dorkbot' }];
    renderStrip();
    fireEvent.click(screen.getByLabelText('Ask DorkBot'));
    expect(mockNavigate).toHaveBeenCalledTimes(1);
  });

  // ── BC-44: the update pill ───────────────────────────────────────────────

  it('renders zero DOM for the pill when no update is ready', () => {
    const { container } = renderStrip();

    expect(screen.queryByText(/Update ready/)).toBeNull();
    // The strip's only child is the row — nothing is reserved for the pill.
    expect(container.querySelector('[data-testid="sidebar-footer-strip"]')?.children).toHaveLength(
      1
    );
  });

  it('announces a newer published version and hands over the command', () => {
    mockConfigData = {
      version: '1.2.3',
      latestVersion: '1.4.0',
      isDevMode: false,
      dismissedUpgradeVersions: [],
    };
    renderStrip();

    expect(screen.getByText('Update ready — v1.4.0')).toBeInTheDocument();
  });

  it('stays quiet about a version the operator already dismissed', () => {
    mockConfigData = {
      version: '1.2.3',
      latestVersion: '1.4.0',
      isDevMode: false,
      dismissedUpgradeVersions: ['1.4.0'],
    };
    renderStrip();

    expect(screen.queryByText(/Update ready/)).toBeNull();
  });

  it('remembers a dismissal', () => {
    mockConfigData = {
      version: '1.2.3',
      latestVersion: '1.4.0',
      isDevMode: false,
      dismissedUpgradeVersions: ['1.0.0'],
    };
    renderStrip();

    fireEvent.click(screen.getByLabelText('Dismiss update notification'));
    expect(mockUpdateConfigMutate).toHaveBeenCalledWith({
      ui: { dismissedUpgradeVersions: ['1.0.0', '1.4.0'] },
    });
  });

  it('offers a restart on the desktop app, and only once the download has landed', () => {
    mockDesktop = { isDesktop: true, status: { state: 'downloading' } };
    const { unmount } = renderStrip();
    expect(screen.queryByText(/Update ready/)).toBeNull();
    unmount();

    mockDesktop = { isDesktop: true, status: { state: 'downloaded', version: '2.0.0' } };
    renderStrip();
    fireEvent.click(screen.getByText('Update ready — Restart'));
    expect(mockRestart).toHaveBeenCalled();
  });

  it('never puts an update in Now', () => {
    mockConfigData = {
      version: '1.2.3',
      latestVersion: '1.4.0',
      isDevMode: false,
      dismissedUpgradeVersions: [],
    };
    renderStrip();

    // Observable: the pill IS on screen for this state.
    expect(screen.getByText('Update ready — v1.4.0')).toBeInTheDocument();

    // And the zone model built from the same moment — a fleet that genuinely
    // has things waiting, so the Now zone is populated and the query below can
    // fail — carries nothing about it.
    const model = buildSidebarModel(busyFixture);
    const now = model.zones.find((zone) => zone.id === 'now');
    const nowRows = now?.sections.flatMap((section) => section.rows) ?? [];
    expect(nowRows.length).toBeGreaterThan(0);
    const nowText = nowRows.map((r) => `${r.primary} ${r.secondary ?? ''} ${r.reason}`);
    expect(nowText).not.toContain('Update ready — v1.4.0');
    expect(nowText.filter((text) => /update|version|restart/i.test(text))).toEqual([]);
    // Every Now row is an agent that needs you or a rollup of them, and nothing
    // else can be (BC-5) — these are the only provenances the model can emit
    // into this zone, so an update could not join them without a new rule.
    expect(nowRows.every((r) => /^(now:|rollup:)/.test(r.reason))).toBe(true);
  });
});
