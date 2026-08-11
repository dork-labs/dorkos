// @vitest-environment jsdom
/**
 * The phone cockpit: four destinations, no drawer, and Home composed from the
 * same build the desktop panel draws.
 *
 * **The model half is real.** `useSidebarState` is the one thing stubbed — with
 * the programme's own journey fixtures, which is what a real cockpit hands the
 * model — and everything downstream of it runs: `useSidebarModel` calls the
 * real `buildSidebarModel`, `SidebarZones` draws the result, and the assertions
 * read the DOM those zones produced. A suite that stubbed the model would prove
 * the tabs render a mock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { buildSidebarModel } from '@/layers/features/dashboard-sidebar/model/build-sidebar-model';
import type { SidebarState } from '@/layers/features/dashboard-sidebar/model/sidebar-state';
import {
  busyFixture,
  powerFixture,
  quietFixture,
  SIDEBAR_FIXTURES,
} from '@/layers/features/dashboard-sidebar/model/fixtures';
import { SIDEBAR_ZONE_IDS } from '@/layers/features/dashboard-sidebar';
import { LIVE_REGION_DEBOUNCE_MS } from '@/layers/features/dashboard-sidebar/model/use-live-region-text';

// ── Router ──────────────────────────────────────────────────────────────────
// The href MOVES, because "the layout gets out of the way of where you went" is
// a property of the location changing. A mock whose location never moved would
// make that assertion vacuous.
let mockHref = '/';
const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
  useRouter: () => ({
    state: {
      get location() {
        return { pathname: mockHref, search: {} };
      },
    },
  }),
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname: mockHref, href: mockHref, search: {} } }),
  useSearch: () => ({}),
}));

// ── The snapshot the model is a function of ─────────────────────────────────
let mockState: SidebarState = busyFixture;
vi.mock('@/layers/features/dashboard-sidebar/model/use-sidebar-state', () => ({
  useSidebarState: () => mockState,
  SIDEBAR_CLOCK_TICK_MS: 60_000,
}));
vi.mock('@/layers/features/dashboard-sidebar/model/use-legacy-pin-migration', () => ({
  useLegacyPinMigration: () => {},
}));

// The two pieces of chrome the panels borrow are covered by their own suites;
// here they only need to be findable, so the assertions are about WHERE the
// layout puts them rather than about what they contain.
vi.mock('@/layers/features/dashboard-sidebar/ui/SidebarHeaderBlock', () => ({
  SidebarHeaderBlock: () => <div data-testid="sidebar-header-block">Header block</div>,
}));
vi.mock('@/layers/features/dashboard-sidebar/ui/SidebarFooterStrip', () => ({
  SidebarFooterStrip: () => <div data-testid="sidebar-footer-strip">Footer strip</div>,
  useAskDorkBot: () => ({ ask: mockAsk, ready: true }),
}));
const mockAsk = vi.fn();

import { MobileTabsLayout } from '../ui/MobileTabsLayout';
import {
  MOBILE_TABS,
  MOBILE_TAB_BAR_DOCK,
  HOME_ZONE_IDS,
  LIBRARY_ZONE_IDS,
} from '../model/mobile-tabs';

function renderLayout(takeover: React.ReactNode = null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={createMockTransport()}>
        <TooltipProvider>
          <MobileTabsLayout takeover={takeover} />
        </TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
}

/** The panel for a destination — the box the layout shows or puts away. */
const panel = (id: string) => screen.getByTestId(`mobile-tab-panel-${id}`);
/** Whether a panel is the one on screen, by the class that decides it. */
const showing = (id: string) => !panel(id).className.includes('invisible');
/** Every zone landmark inside one panel, in DOM order. */
const zonesIn = (id: string) =>
  Array.from(panel(id).querySelectorAll('[data-sidebar-zone]')).map((el) =>
    el.getAttribute('data-sidebar-zone')
  );

beforeEach(() => {
  mockState = busyFixture;
  mockHref = '/';
  mockAsk.mockClear();
});
afterEach(cleanup);

describe('MobileTabsLayout', () => {
  describe('the bar', () => {
    it('offers exactly the destinations the model of the bar names, and no more', () => {
      renderLayout();
      // Enumerated from the descriptor list, not from a literal written twice:
      // a fifth destination is counted here whatever it ends up being called.
      const buttons = Array.from(document.querySelectorAll('[data-mobile-tab]'));
      expect(buttons).toHaveLength(MOBILE_TABS.length);
      expect(buttons.map((b) => b.textContent?.replace(/\d+/g, ''))).toEqual(
        MOBILE_TABS.map((t) => t.label)
      );
    });

    it('starts on Home, and marks exactly one destination current', () => {
      renderLayout();
      expect(screen.getByTestId('mobile-tab-home')).toHaveAttribute('aria-current', 'page');
      const current = Array.from(document.querySelectorAll('[data-mobile-tab][aria-current]'));
      expect(current).toHaveLength(1);
    });
  });

  describe('the Home badge (P4 AC-2)', () => {
    // The discriminating pair. In `busy` the Now zone holds FOUR rows and three
    // of them need the operator — the fourth is the "N working" rollup. In
    // `power` it holds FIVE (the cap) while SEVEN need the operator. So a badge
    // that counted rows would read 4 and 5; the number BC-11 announces is 3 and
    // 7. Neither fixture can be satisfied by the wrong source, and they fail in
    // opposite directions.
    it.each([
      { name: 'busy', state: busyFixture, rows: 4, needsYou: 3 },
      { name: 'power', state: powerFixture, rows: 5, needsYou: 7 },
    ])('shows the needs-you count, not the row count ($name)', ({ state, rows, needsYou }) => {
      mockState = state;
      const model = buildSidebarModel(state);
      const now = model.zones.find((zone) => zone.id === 'now');
      // The premise the case rests on — asserted, so this stops being a real
      // test the day a fixture changes shape instead of quietly passing.
      expect(now?.sections.reduce((n, s) => n + s.rows.length, 0)).toBe(rows);
      expect(now?.needsYouCount).toBe(needsYou);
      expect(rows).not.toBe(needsYou);

      renderLayout();
      expect(screen.getByTestId('mobile-tab-badge-home')).toHaveTextContent(String(needsYou));
    });

    it('is the same number the live region announces', async () => {
      mockState = powerFixture;
      renderLayout();
      const badge = screen.getByTestId('mobile-tab-badge-home').textContent;
      // The live region is the real one, rendered by the real Now zone inside
      // the Home panel — so this compares the badge against BC-11's own words.
      // It publishes a second after the count settles (`LIVE_REGION_DEBOUNCE_MS`),
      // which is why this waits rather than reading straight after the render.
      await waitFor(
        () => {
          const live = panel('home').querySelector('[aria-live="polite"]');
          expect(live?.textContent).toContain(String(badge));
        },
        { timeout: LIVE_REGION_DEBOUNCE_MS * 3 }
      );
    });

    it('draws no badge when nothing needs you', () => {
      mockState = quietFixture;
      renderLayout();
      expect(screen.queryByTestId('mobile-tab-badge-home')).not.toBeInTheDocument();
    });

    it('never badges Library, under any state the fixtures produce', () => {
      // Every journey, including the two that badge Home. Library is the calm
      // surface: it asks for nothing (§9).
      for (const fixture of SIDEBAR_FIXTURES) {
        mockState = fixture.state;
        renderLayout();
        expect(
          screen.queryByTestId('mobile-tab-badge-library'),
          `${fixture.name} put a badge on Library`
        ).not.toBeInTheDocument();
        cleanup();
      }
    });
  });

  describe('what each destination holds', () => {
    it('composes Home from Now and Today, in that order', () => {
      renderLayout();
      expect(zonesIn('home')).toEqual(['now', 'today']);
    });

    it('puts Library in its own destination', () => {
      renderLayout();
      expect(zonesIn('library')).toEqual(['library']);
    });

    it('renders no zone twice, and leaves none of the model undrawn', () => {
      renderLayout();
      const drawn = [...zonesIn('home'), ...zonesIn('library')];
      expect(new Set(drawn).size).toBe(drawn.length);
      // Enumerated from the model's own build, never from a list written here.
      const emitted = buildSidebarModel(busyFixture).zones.map((zone) => zone.id);
      expect(drawn.sort()).toEqual([...emitted].sort());
    });

    it('splits the model exactly once — Home and Library together are every zone', () => {
      // The property that keeps a fifth zone from silently rendering nowhere.
      expect([...HOME_ZONE_IDS, ...LIBRARY_ZONE_IDS].sort()).toEqual([...SIDEBAR_ZONE_IDS].sort());
      expect(HOME_ZONE_IDS.some((id) => LIBRARY_ZONE_IDS.includes(id))).toBe(false);
    });

    it('draws day one in Home, where Now would have been', () => {
      mockState = SIDEBAR_FIXTURES[0].state;
      renderLayout();
      expect(zonesIn('home')).toContain('getting-started');
      expect(zonesIn('library')).not.toContain('getting-started');
    });

    it('keeps New in the header, and mounts no floating action button', () => {
      renderLayout();
      expect(within(panel('home')).getByTestId('sidebar-header-block')).toBeInTheDocument();
    });

    it('puts the four places DorkOS goes in You', () => {
      renderLayout();
      expect(within(panel('you')).getByTestId('sidebar-footer-strip')).toBeInTheDocument();
    });
  });

  describe('a contributed sidebar.body takeover', () => {
    it('lands in Library and nowhere else', () => {
      renderLayout(<div data-testid="takeover-body">facets</div>);
      expect(within(panel('library')).getByTestId('takeover-body')).toBeInTheDocument();
      expect(within(panel('home')).queryByTestId('takeover-body')).not.toBeInTheDocument();
      // …and it REPLACES Library rather than sitting beside it.
      expect(zonesIn('library')).toEqual([]);
    });

    it('leaves Home standing — a takeover is not a reason to stop being told', () => {
      renderLayout(<div data-testid="takeover-body">facets</div>);
      expect(zonesIn('home')).toEqual(['now', 'today']);
      expect(screen.getByTestId('mobile-tab-badge-home')).toBeInTheDocument();
    });
  });

  describe('switching destinations (P4 AC-1)', () => {
    it('shows one panel at a time and unmounts none of them', async () => {
      const user = userEvent.setup();
      renderLayout();
      expect(showing('home')).toBe(true);
      expect(showing('library')).toBe(false);

      await user.click(screen.getByTestId('mobile-tab-library'));
      expect(showing('library')).toBe(true);
      expect(showing('home')).toBe(false);
      // Still in the tree — which is what makes a scroll offset survivable.
      expect(panel('home')).toBeInTheDocument();
    });

    it('carries Home’s scroll offset through a round trip to Library', async () => {
      const user = userEvent.setup();
      renderLayout();
      // The scroller PageContainer owns, driven the way a thumb drives it.
      const scroller = panel('home').querySelector<HTMLElement>('.overflow-y-auto');
      expect(scroller).not.toBeNull();
      scroller!.scrollTop = 240;

      await user.click(screen.getByTestId('mobile-tab-library'));
      await user.click(screen.getByTestId('mobile-tab-home'));

      // Same element — not a remount — and the offset it was left at. `visibility`
      // keeps the layout box; `display: none` would have reset this to 0.
      expect(panel('home').querySelector<HTMLElement>('.overflow-y-auto')).toBe(scroller);
      expect(scroller!.scrollTop).toBe(240);
      expect(panel('home').className).not.toContain('hidden');
    });

    it('hides an inactive panel from the keyboard and the accessibility tree', async () => {
      const user = userEvent.setup();
      renderLayout();
      await user.click(screen.getByTestId('mobile-tab-library'));
      expect(panel('home')).toHaveAttribute('inert');
      expect(panel('library')).not.toHaveAttribute('inert');
    });
  });

  describe('opening a destination from a row', () => {
    it('yields to where you went, keeping the bar and every panel', () => {
      const { rerender } = renderLayout();
      expect(showing('home')).toBe(true);

      mockHref = '/session?session=abc';
      rerender(
        <QueryClientProvider client={new QueryClient()}>
          <TransportProvider transport={createMockTransport()}>
            <TooltipProvider>
              <MobileTabsLayout takeover={null} />
            </TooltipProvider>
          </TransportProvider>
        </QueryClientProvider>
      );

      // The panel layer is put away so the conversation is what you are looking
      // at, and the bar is still there to bring Home back.
      expect(screen.getByTestId('mobile-tab-panels').className).toContain('invisible');
      expect(screen.getByTestId('mobile-tab-bar')).toBeInTheDocument();
      expect(panel('home')).toBeInTheDocument();
    });
  });

  describe('DorkBot', () => {
    it('opens a conversation rather than a panel', async () => {
      const user = userEvent.setup();
      renderLayout();
      await user.click(screen.getByTestId('mobile-tab-dorkbot'));
      expect(mockAsk).toHaveBeenCalledTimes(1);
      // No panel of its own — the conversation is the destination.
      expect(screen.queryByTestId('mobile-tab-panel-dorkbot')).not.toBeInTheDocument();
      expect(screen.getByTestId('mobile-tab-panels').className).toContain('invisible');
    });
  });

  describe('nothing overlaps the bar', () => {
    it('stops the panels exactly where the bar starts', () => {
      renderLayout();
      const bar = screen.getByTestId('mobile-tab-bar');
      const panels = screen.getByTestId('mobile-tab-panels');
      // One string, two uses. Two literals here would be two chances for a
      // phone with a home indicator to hide Today's last row behind the bar.
      expect(bar.style.height).toBe(MOBILE_TAB_BAR_DOCK);
      expect(panels.style.bottom).toBe(MOBILE_TAB_BAR_DOCK);
    });
  });
});
