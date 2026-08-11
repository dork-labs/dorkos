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
    { id: 'theme', icon: MockIcon, label: 'Toggle Theme', onClick: () => {}, priority: 3 },
    {
      id: 'devtools',
      icon: MockIcon,
      label: 'Devtools',
      onClick: () => {},
      priority: 4,
      showInDevOnly: true,
    },
    // An EXTENSION's dev-only button. The built-in `devtools` cannot stand in
    // for it: that one has its own `import.meta.env.DEV` gate, so a renderer
    // that ignored the slot's `showInDevOnly` flag entirely would still hide it
    // — and would still show this one to every production user.
    {
      id: 'ext-dev-only',
      icon: MockIcon,
      label: 'Extension Dev Thing',
      onClick: () => {},
      priority: 5,
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

// The account rows read the roster, the auth session and two deep links; this
// suite is about the strip's own layout, so they stand in. Their behaviour is
// pinned in `features/profile`'s own suite.
vi.mock('@/layers/features/profile', () => ({
  AccountMenuContainer: () => <div data-testid="account-menu-rows" />,
}));
// Same treatment: the help rows are the report-issue slice's subject.
vi.mock('@/layers/features/report-issue', () => ({
  HelpMenuItems: () => <div data-testid="help-menu-items" />,
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
    vi.unstubAllEnvs();
    // Radix locks the page while a menu is open and restores on close, not on
    // unmount. A suite that leaves one open hands the NEXT test a body with
    // `pointer-events: none`, and user-event refuses to click through that — so
    // the following test fails for a reason that has nothing to do with it.
    document.body.style.pointerEvents = '';
    document.body.removeAttribute('data-scroll-locked');
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

  it('marks its destinations structurally, so a fifth one cannot hide from a count', () => {
    renderStrip();

    // The browser spec counts `[data-sidebar-destination]`. It was a name-match
    // regex first, which could never have seen a fifth destination — the
    // newcomer was filtered out before the count ran.
    const marked = row().querySelectorAll('[data-sidebar-destination]');
    expect([...marked].map((el) => el.getAttribute('aria-label'))).toEqual([
      'Home',
      'Team',
      'Marketplace',
      'Connections',
    ]);
    // …and nothing else in the row wears the mark: `More` and Ask DorkBot are
    // excluded by structure, not by name.
    expect(marked).toHaveLength(within(row()).getAllByRole('button').length - 2);
  });

  it('gives every control in the row a keyboard focus ring', () => {
    renderStrip();

    // These are bare `<button>`s. The shadcn `SidebarMenuButton` they replaced
    // carried the ring; the repo's ring is a UTILITY, not a global
    // `:focus-visible` rule, so it has to be asked for by name or a keyboard
    // sees nothing at all.
    for (const button of within(row()).getAllByRole('button')) {
      expect(button.className).toContain('focus-ring');
    }
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

  it('honours showInDevOnly for an extension button, not only for the built-in', async () => {
    vi.stubEnv('DEV', false);
    renderStrip();

    await userEvent.click(screen.getByLabelText('More'));
    // Observable: the menu IS open and its ordinary rows are on screen.
    expect(await screen.findByText('Edit Agent')).toBeInTheDocument();
    // The flag belongs to the SLOT, and the footer bar this replaced applied it
    // to every contribution. Gating only the built-in `devtools` on
    // `import.meta.env.DEV` would put an extension's dev-only button in front of
    // every production user.
    expect(screen.queryByText('Extension Dev Thing')).toBeNull();
    expect(screen.queryByText('React Query')).toBeNull();
  });

  it('shows the dev-only rows in a development build', async () => {
    renderStrip();

    await userEvent.click(screen.getByLabelText('More'));
    expect(await screen.findByText('Extension Dev Thing')).toBeInTheDocument();
    expect(screen.getByText('React Query')).toBeInTheDocument();
  });

  it('keeps help and feedback reachable after its ? trigger left the footer', async () => {
    renderStrip();

    // The help menu had its own trigger in the old icon cluster. One row has
    // room for one fold, so its rows moved into `More` — deleting the slice
    // instead would have taken the docs link, the GitHub path and the
    // feedback-requests entry with it.
    await userEvent.click(screen.getByLabelText('More'));
    expect(await screen.findByTestId('help-menu-items')).toBeInTheDocument();
    // Your account folded in beside it, for the same reason and by the same
    // measurement: a seventh control took the row's scrollWidth past its box.
    expect(screen.getByTestId('account-menu-rows')).toBeInTheDocument();
  });

  it('offers no Settings row of its own — the header block’s menu is the one door', async () => {
    // P2.4's header block carries "Workspace settings" (BC-43), so the built-in
    // `settings` contribution retired rather than leaving one dialog behind two
    // differently-named rows in two menus. Deleting the assertion would have
    // been the cheap way out; this one fails if the row comes back.
    renderStrip();

    await userEvent.click(screen.getByLabelText('More'));
    // Observable: the fold really did open and really does have rows.
    expect(await screen.findByTestId('help-menu-items')).toBeInTheDocument();
    expect(screen.queryByText('Settings')).not.toBeInTheDocument();
    expect(mockOpenSettings).not.toHaveBeenCalled();
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

  it('never puts an update in Heads up', () => {
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
    // has things waiting, so the Heads up zone is populated and the query below can
    // fail — carries nothing about it.
    const model = buildSidebarModel(busyFixture);
    const now = model.zones.find((zone) => zone.id === 'now');
    const nowRows = now?.sections.flatMap((section) => section.rows) ?? [];
    expect(nowRows.length).toBeGreaterThan(0);
    const nowText = nowRows.map((r) => `${r.primary} ${r.secondary ?? ''} ${r.reason}`);
    expect(nowText).not.toContain('Update ready — v1.4.0');
    expect(nowText.filter((text) => /update|version|restart/i.test(text))).toEqual([]);
    // Every Heads up row is an agent that needs you or a rollup of them, and nothing
    // else can be (BC-5) — these are the only provenances the model can emit
    // into this zone, so an update could not join them without a new rule.
    expect(nowRows.every((r) => /^(now:|rollup:)/.test(r.reason))).toBe(true);
  });
});
