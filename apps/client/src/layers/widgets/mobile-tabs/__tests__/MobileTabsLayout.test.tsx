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
import { act, render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import type { InteractionPendingEvent } from '@dorkos/shared/interaction-events';

// ── The global event stream ────────────────────────────────────────────────
// The Home tab now reads the approval queue (P4 AC-5), and that query keeps
// itself live off the SSE fan-out. Only the subscription is stubbed; the query
// itself runs against the mock transport, so the assertions below are about a
// real fetch landing in a real render.
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useEventSubscription: vi.fn(),
    useEventStream: () => ({ subscribe: vi.fn(), connectionState: 'connected', failedAttempts: 0 }),
  };
});

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
import { clearAskReceipts } from '@/layers/entities/attention';

// ── Router ──────────────────────────────────────────────────────────────────
// **The subscription is the seam under test, so the mock is a real one.**
// `commitNavigation()` fires every `onBeforeLoad` listener exactly as TanStack
// does on a committed load — INCLUDING one that lands on the URL already
// showing, which is the case the layout used to miss (review B1) and the case
// the deleted `sidebar-mobile-navigation.test.tsx` covered by name.
let mockHref = '/';
const mockNavigate = vi.fn();
const beforeLoadListeners = new Set<() => void>();
/**
 * Commit a navigation to `href`, defaulting to the URL already showing.
 *
 * Wrapped in `act` because the listeners are an external subscription, not a
 * React event: without it the store write lands but nothing re-renders, and
 * every assertion below would read the previous frame.
 */
function commitNavigation(href: string = mockHref) {
  mockHref = href;
  act(() => {
    for (const listener of [...beforeLoadListeners]) listener();
  });
}
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
  useRouter: () => ({
    state: {
      get location() {
        return { pathname: mockHref, search: {} };
      },
    },
    subscribe: (event: string, listener: () => void) => {
      if (event !== 'onBeforeLoad') return () => {};
      beforeLoadListeners.add(listener);
      return () => beforeLoadListeners.delete(listener);
    },
  }),
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname: mockHref, href: mockHref, search: {} } }),
  useSearch: () => ({}),
}));

// ── The snapshot the model is a function of ─────────────────────────────────
let mockState: SidebarState = busyFixture;
vi.mock('@/layers/features/dashboard-sidebar/model/use-sidebar-state', () => ({
  // **The `coveredSignalIds` option is honoured, not swallowed.** It is what
  // the phone's lead slot tells the model about the cards it is already
  // drawing (DOR-1391), and a stub that dropped it would leave the whole
  // one-blockage-one-place rule untested here while looking covered.
  useSidebarState: (options?: { coveredSignalIds?: readonly string[] }) =>
    options?.coveredSignalIds === undefined || options.coveredSignalIds.length === 0
      ? mockState
      : { ...mockState, coveredSignalIds: options.coveredSignalIds },
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
  useAskDorkBot: () => ({ ask: mockAsk, ready: mockDorkBotReady }),
}));
const mockAsk = vi.fn();
// Whether the roster has answered with DorkBot's directory yet.
let mockDorkBotReady = true;

import { MobileTabsLayout } from '../ui/MobileTabsLayout';
import { useMobilePanelStore } from '../model/mobile-panel-store';
import {
  MOBILE_TABS,
  MOBILE_TAB_BAR_DOCK,
  HOME_ZONE_IDS,
  LIBRARY_ZONE_IDS,
} from '../model/mobile-tabs';

// ── The viewport ───────────────────────────────────────────────────────────
// jsdom has none, and `useIsMobile` is a `matchMedia` question — so the touch
// half of this file (P4.2) sets it and the rest runs at the pointer default,
// exactly as the components do.
let phone = false;
function useEmulatedViewport() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => {
      const maxWidth = /max-width:\s*(\d+)px/.exec(query);
      return {
        matches: maxWidth === null ? false : phone && 390 <= Number(maxWidth[1]),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      };
    },
  });
}

/** One approval waiting on the operator, shaped as the server sends it. */
function anApproval(): PendingApproval {
  return {
    approvalId: 'ap-1',
    capabilityId: 'fs.write',
    capabilityTitle: 'Write to a file',
    tier: 'destructive',
    summary: 'Scout wants to write src/index.ts.',
    hasAgentPath: true,
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
}

/** One question an agent is parked on, shaped as the fleet-wide stream sends it. */
function aQuestion(): InteractionPendingEvent {
  return {
    sessionId: 'session-question-1',
    cwd: '/projects/meeting-notes',
    interaction: {
      type: 'question',
      id: 'q-1',
      startedAt: Date.now(),
      remainingMs: 600_000,
      timeoutMs: 600_000,
      questions: [
        { header: 'Ambiguous target', question: 'Which file?', options: [], multiSelect: false },
      ],
    },
  };
}

function renderLayout(
  takeover: React.ReactNode = null,
  transport: ReturnType<typeof createMockTransport> = createMockTransport()
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
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
  phone = false;
  useEmulatedViewport();
  mockState = busyFixture;
  mockHref = '/';
  mockDorkBotReady = true;
  mockAsk.mockClear();
  beforeLoadListeners.clear();
  useMobilePanelStore.setState({ panelUp: false });
  // The Ask receipt store is module-level, shared by every card `AskList`
  // draws anywhere in the app — a "You said no" from one test's answered
  // question would otherwise still be showing when the next test's fixture
  // reuses its interaction id.
  clearAskReceipts();
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

    // ── review B1: the cold-load state ──
    it('opens with the panels DOWN, so a cold load can reach the routed page', () => {
      // `/` is the #team room. Opening with Home over it meant a phone could
      // not see the home surface at all until it navigated somewhere else.
      renderLayout();
      expect(screen.getByTestId('mobile-tab-panels').className).toContain('invisible');
      expect(document.querySelectorAll('[data-mobile-tab][aria-current]')).toHaveLength(0);
    });

    it('marks exactly one destination current once a panel is up', async () => {
      const user = userEvent.setup();
      renderLayout();
      await user.click(screen.getByTestId('mobile-tab-home'));
      expect(screen.getByTestId('mobile-tab-home')).toHaveAttribute('aria-current', 'page');
      expect(document.querySelectorAll('[data-mobile-tab][aria-current]')).toHaveLength(1);
    });

    // ── review one-liner: aria-current must not describe the last press ──
    it('marks nothing current while the operator is looking at a conversation', async () => {
      const user = userEvent.setup();
      renderLayout();
      await user.click(screen.getByTestId('mobile-tab-library'));
      expect(screen.getByTestId('mobile-tab-library')).toHaveAttribute('aria-current', 'page');

      // The observable half: a panel really was current a moment ago, so this
      // is a transition rather than a state that was never entered.
      commitNavigation('/session?session=abc');
      expect(document.querySelectorAll('[data-mobile-tab][aria-current]')).toHaveLength(0);
      expect(screen.getByTestId('mobile-tab-library')).not.toHaveAttribute('aria-current');
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
      const { container } = renderLayout();
      const badge = screen.getByTestId('mobile-tab-badge-home').textContent;
      // It publishes a second after the count settles (`LIVE_REGION_DEBOUNCE_MS`),
      // which is why this waits rather than reading straight after the render.
      await waitFor(
        () => {
          const live = container.querySelector('[aria-live="polite"]');
          expect(live?.textContent).toContain(String(badge));
        },
        { timeout: LIVE_REGION_DEBOUNCE_MS * 3 }
      );
    });

    it('announces the count from OUTSIDE the panels, where nothing is inert (P4.2)', async () => {
      // **The badge is `aria-hidden` because something else says the number.**
      // That something used to be the region inside Now's zone — which is
      // inside a panel this layout marks `inert` whenever it is put away, so
      // for every moment the operator was in a conversation the count was
      // announced by nobody at all.
      mockState = powerFixture;
      const { container } = renderLayout();
      expect(screen.getByTestId('mobile-tab-badge-home')).toHaveAttribute('aria-hidden', 'true');

      const regions = Array.from(container.querySelectorAll('[aria-live="polite"]'));
      // Exactly one, so the bar and the zone cannot both say it — two regions
      // carrying one number is the siren BC-11 exists to prevent.
      expect(regions).toHaveLength(1);
      expect(panel('home').querySelector('[aria-live="polite"]')).toBeNull();
      // …and it really is outside the box the layout puts away.
      expect(screen.getByTestId('mobile-tab-panels').contains(regions[0]!)).toBe(false);

      // Not an empty element that happens to sit in the right place: it says
      // the number, and it still says it with every panel down.
      await waitFor(() => expect(regions[0]!.textContent).toMatch(/\d/), {
        timeout: LIVE_REGION_DEBOUNCE_MS * 3,
      });
      commitNavigation('/session?session=abc');
      expect(screen.getByTestId('mobile-tab-panels')).toHaveAttribute('inert');
      expect(regions[0]!.textContent).toMatch(/\d/);
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

    it('calls that destination "All", under the id `library` (D1)', () => {
      // The word named a heading the panel no longer draws anywhere, so the
      // label changed and the ID did not — the id is the zone's, the panel's DOM
      // id and half the browser suite's handles. Same pattern as DOR-1155's
      // `now`/"Heads up": label only, never the id.
      renderLayout();
      const tab = screen.getByTestId('mobile-tab-library');
      expect(tab).toHaveTextContent('All');
      expect(tab).not.toHaveTextContent('Library');
      expect(tab).toHaveAccessibleName('All');
      // …and the id it is keyed by, and the zone it draws, are untouched.
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

    it('mounts the bottom slot at the foot of Home, and nowhere else', () => {
      // A phone never mounted it at all, so the one card the cockpit offers —
      // getting started, an update, the profile prompt, a promo — was
      // desktop-only (spec `sidebar-simplification` D4). Home is this
      // cockpit's first screen, so it goes there; Library and You are not
      // where you land.
      renderLayout();

      expect(panel('home').querySelectorAll('[data-slot="sidebar-bottom-slot"]').length).toBe(1);
      expect(panel('library').querySelectorAll('[data-slot="sidebar-bottom-slot"]').length).toBe(0);
      expect(panel('you').querySelectorAll('[data-slot="sidebar-bottom-slot"]').length).toBe(0);
    });

    it('puts the bottom slot after the zones, not among them', () => {
      // It is the panel's foot, not a row in the list.
      renderLayout();
      const zones = panel('home').querySelectorAll('[data-sidebar-zone]');
      const slot = panel('home').querySelector('[data-slot="sidebar-bottom-slot"]');
      const last = zones[zones.length - 1]!;
      // Excluding CONTAINED_BY: a descendant reports as FOLLOWING too, so the
      // bare flag would pass with the slot rendered INSIDE the last zone.
      const position = last.compareDocumentPosition(slot!);
      expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(position & Node.DOCUMENT_POSITION_CONTAINED_BY).toBeFalsy();
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
      await user.click(screen.getByTestId('mobile-tab-home'));
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
      await user.click(screen.getByTestId('mobile-tab-home'));
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

  describe('opening a destination from a row (review B1)', () => {
    it('yields on the navigation commit, keeping the bar and every panel', async () => {
      const user = userEvent.setup();
      renderLayout();
      await user.click(screen.getByTestId('mobile-tab-home'));
      expect(showing('home')).toBe(true);

      commitNavigation('/session?session=abc');

      // The layer is put away so the conversation is what you are looking at,
      // and the bar is still there to bring Home back.
      expect(screen.getByTestId('mobile-tab-panels').className).toContain('invisible');
      expect(screen.getByTestId('mobile-tab-bar')).toBeInTheDocument();
      expect(panel('home')).toBeInTheDocument();
    });

    // ── The case the deleted `sidebar-mobile-navigation.test.tsx` named, and the
    //    exact defect review B1 measured. Re-opening the conversation you already
    //    have open is the commonest tap of all — Today pins it as its first row —
    //    and TanStack reports it as an unchanged href. A layout that diffed hrefs
    //    did nothing here, leaving a layer with no way out. ──
    it('yields on a navigation that lands on the URL already showing', async () => {
      const user = userEvent.setup();
      renderLayout();
      await user.click(screen.getByTestId('mobile-tab-home'));
      const before = mockHref;
      expect(showing('home')).toBe(true);

      commitNavigation();

      // Same URL, and the layer still got out of the way.
      expect(mockHref).toBe(before);
      expect(screen.getByTestId('mobile-tab-panels').className).toContain('invisible');
    });

    it('marks the covered page reachable again when it comes back', async () => {
      // Every press has to recover the layer, because navigating away was the
      // only escape when it did not.
      const user = userEvent.setup();
      renderLayout();
      await user.click(screen.getByTestId('mobile-tab-home'));
      commitNavigation();
      expect(screen.getByTestId('mobile-tab-panels').className).toContain('invisible');

      await user.click(screen.getByTestId('mobile-tab-library'));
      expect(screen.getByTestId('mobile-tab-panels').className).not.toContain('invisible');
      expect(showing('library')).toBe(true);
    });

    it('publishes whether a panel covers the page, for the shell to act on', () => {
      // The bit `AppShell` reads to mark the routed page `inert` (review B2).
      // Asserted here as well as there, because a store nobody writes is a
      // shell that silently stops inert-ing.
      renderLayout();
      expect(useMobilePanelStore.getState().panelUp).toBe(false);
      act(() => useMobilePanelStore.getState().raise());
      expect(useMobilePanelStore.getState().panelUp).toBe(true);
      expect(screen.getByTestId('mobile-tab-panels').className).not.toContain('invisible');
      commitNavigation();
      expect(useMobilePanelStore.getState().panelUp).toBe(false);
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

    // ── review one-liner: the hook exports `ready` for exactly this ──
    it('says it is not ready rather than doing nothing, until the roster answers', async () => {
      mockDorkBotReady = false;
      const user = userEvent.setup();
      renderLayout();

      const dorkbot = screen.getByTestId('mobile-tab-dorkbot');
      expect(dorkbot).toBeDisabled();
      await user.click(dorkbot);
      expect(mockAsk).not.toHaveBeenCalled();
    });

    it('leaves the panel you were reading alone when it is not ready', async () => {
      mockDorkBotReady = false;
      const user = userEvent.setup();
      renderLayout();
      await user.click(screen.getByTestId('mobile-tab-library'));

      await user.click(screen.getByTestId('mobile-tab-dorkbot'));

      // The press did nothing, so it took nothing away either.
      expect(showing('library')).toBe(true);
      expect(screen.getByTestId('mobile-tab-library')).toHaveAttribute('aria-current', 'page');
    });

    it('is pressable, and only disabled by the roster', async () => {
      // The positive half — without it "disabled" above could be permanent.
      const user = userEvent.setup();
      renderLayout();
      expect(screen.getByTestId('mobile-tab-dorkbot')).toBeEnabled();
      await user.click(screen.getByTestId('mobile-tab-dorkbot'));
      expect(mockAsk).toHaveBeenCalledTimes(1);
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
      // Plus whatever a docked PIP is holding — absent, `--pip-dock` resolves
      // to the `0px` fallback and this is the bar's height and nothing else.
      expect(panels.style.bottom).toBe(`calc(${MOBILE_TAB_BAR_DOCK} + var(--pip-dock, 0px))`);
    });

    it('publishes the bar height so other layers can dock above it (DOR-1177)', () => {
      // The PIP mini-bar is a `features/` component and cannot import this
      // widget's constant, but it must not paint over the bar — so the number
      // travels as a custom property. Before this, a docked PIP covered all
      // four destinations and every one of them was unpressable.
      const { unmount } = renderLayout();
      expect(document.documentElement.style.getPropertyValue('--mobile-tab-dock')).toBe(
        MOBILE_TAB_BAR_DOCK
      );

      // And it goes away with the cockpit. A stale value left behind at desktop
      // width would float the desktop PIP off an edge that is no longer there.
      unmount();
      expect(document.documentElement.style.getPropertyValue('--mobile-tab-dock')).toBe('');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Touch (P4.2). Everything below runs at 390 wide, which is the only width
  // at which any of it exists.
  // ─────────────────────────────────────────────────────────────────────────
  describe('at 390×844 (P4.2)', () => {
    beforeEach(() => {
      phone = true;
      useEmulatedViewport();
    });
    afterEach(() => {
      phone = false;
      useEmulatedViewport();
    });

    it('tops Today with Catch up, drawn from the model rather than from a prop', () => {
      // The wire-through: real fixture → real `buildSidebarModel` → real zones
      // → this control, with nothing between them stubbed. `busy` is chosen
      // because its Today genuinely holds unread rooms.
      mockState = busyFixture;
      renderLayout();
      const today = panel('home').querySelector('[data-sidebar-zone="today"]');
      expect(today).not.toBeNull();
      const catchUp = within(today as HTMLElement).getByTestId('today-catch-up');
      // The number it offers to clear is the model's, not a guess.
      const rows =
        buildSidebarModel(busyFixture)
          .zones.find((zone) => zone.id === 'today')
          ?.sections.find((section) => section.id === 'today')?.rows ?? [];
      const unread = new Set(
        rows
          .filter((row) => row.unread.tier !== 'none' && row.target.kind === 'room')
          .map((row) => (row.target.kind === 'room' ? row.target.roomId : ''))
      );
      expect(unread.size).toBeGreaterThan(0);
      expect(catchUp).toHaveAccessibleName(new RegExp(`mark ${unread.size} unread`));
    });

    it('draws no Catch up under a pointer, on the very same model', () => {
      // The pair. Same fixture, same zones — only the viewport differs, which
      // is what makes the presence above about the device.
      phone = false;
      useEmulatedViewport();
      mockState = busyFixture;
      renderLayout();
      expect(screen.queryByTestId('today-catch-up')).toBeNull();
    });

    it('puts an approval in Home and lets it be answered without going anywhere (AC-5)', async () => {
      const user = userEvent.setup();
      mockState = quietFixture;
      const transport = createMockTransport();
      transport.listPendingApprovals = vi.fn().mockResolvedValue({ approvals: [anApproval()] });
      renderLayout(null, transport);
      // Go to Home the way an operator does, so "the panel is still up
      // afterwards" is a claim about answering rather than about a cold load.
      await user.click(screen.getByTestId('mobile-tab-home'));

      const card = await screen.findByText('Write to a file');
      // In Home, in Now — not in a separate box bolted above the zones.
      const now = panel('home').querySelector('[data-sidebar-zone="now"]');
      expect(now).not.toBeNull();
      expect((now as HTMLElement).contains(card)).toBe(true);

      const before = mockHref;
      await user.click(screen.getByRole('button', { name: /^Allow$/ }));
      await waitFor(() => expect(transport.grantApproval).toHaveBeenCalledWith('ap-1', undefined));
      // The route did not change and no navigation was committed: the card
      // resolved where it was.
      expect(mockHref).toBe(before);
      expect(mockNavigate).not.toHaveBeenCalled();
      expect(screen.getByTestId('mobile-tab-panels').className).not.toContain('invisible');
    });

    it('puts a question in Home as a full card, matching an approval rather than a smaller row', async () => {
      const user = userEvent.setup();
      mockState = quietFixture;
      const transport = createMockTransport();
      transport.listPendingInteractions = vi
        .fn()
        .mockResolvedValue({ interactions: [aQuestion()] });
      renderLayout(null, transport);
      await user.click(screen.getByTestId('mobile-tab-home'));

      // The same headline `AskList`/`InteractionAsk` draw everywhere else —
      // reused components, not a mobile-only rendering of the question.
      const card = await screen.findByText('meeting-notes has a question');
      const now = panel('home').querySelector('[data-sidebar-zone="now"]');
      expect(now).not.toBeNull();
      expect((now as HTMLElement).contains(card)).toBe(true);

      // Answering rides the shared `useAnswerAsk` flow: a question has no
      // yes/no, so "Skip" submits an empty answer, exactly as it does on every
      // other surface that draws this card.
      await user.click(screen.getByRole('button', { name: 'Skip' }));
      await waitFor(() =>
        expect(transport.submitAnswers).toHaveBeenCalledWith('session-question-1', 'q-1', {})
      );
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('opens the session from a mobile Ask card, the one action a Now row already offers', async () => {
      const user = userEvent.setup();
      mockState = quietFixture;
      const transport = createMockTransport();
      transport.listPendingInteractions = vi
        .fn()
        .mockResolvedValue({ interactions: [aQuestion()] });
      renderLayout(null, transport);
      await user.click(screen.getByTestId('mobile-tab-home'));
      await screen.findByText('meeting-notes has a question');

      await user.click(screen.getByRole('button', { name: 'Open session' }));

      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/session',
        search: { session: 'session-question-1' },
      });
    });

    it('holds the slot open long enough to show the receipt after the last Ask is answered', async () => {
      // Adversarial regression probe: answering the only pending Ask used to
      // unmount this whole slot the instant the refetch came back empty,
      // tearing the "You said no" receipt away in the same frame it appeared.
      // `useSettlingAsks()` is what the two sibling surfaces
      // (`InboxBell`, `PinnedTriageHeaderView`) already guard with —
      // this seeds the exact race and would fail without it.
      const user = userEvent.setup();
      mockState = quietFixture;
      const transport = createMockTransport();
      transport.listPendingInteractions = vi
        .fn()
        .mockResolvedValueOnce({ interactions: [aQuestion()] })
        .mockResolvedValue({ interactions: [] });
      renderLayout(null, transport);
      await user.click(screen.getByTestId('mobile-tab-home'));
      await screen.findByText('meeting-notes has a question');

      await user.click(screen.getByRole('button', { name: 'Skip' }));
      await waitFor(() =>
        expect(transport.submitAnswers).toHaveBeenCalledWith('session-question-1', 'q-1', {})
      );

      // `useAnswerAsk`'s `finally` re-invalidates the query, which now comes
      // back with an empty list — exactly the moment the slot used to vanish.
      await waitFor(() => expect(transport.listPendingInteractions).toHaveBeenCalledTimes(2));

      expect(screen.getByTestId('mobile-now-attention')).toBeInTheDocument();
      expect(screen.getByText('You said no')).toBeInTheDocument();
    });

    it('says so loudly when the approval list cannot be read — even with no Now zone to say it in', async () => {
      mockState = quietFixture;
      const transport = createMockTransport();
      transport.listPendingApprovals = vi.fn().mockRejectedValue(new Error('offline'));
      renderLayout(null, transport);

      // `quiet` has no Now zone at all, which is the whole trap: the failure
      // that most needs saying is the one where nothing else drew the zone.
      expect(buildSidebarModel(quietFixture).zones.some((zone) => zone.id === 'now')).toBe(false);
      const notice = await screen.findByText(/could not check whether anything is waiting/i);
      expect(panel('home').contains(notice)).toBe(true);

      // And the retry is wired to a real refetch rather than being decoration.
      const user = userEvent.setup();
      const reads = vi.mocked(transport.listPendingApprovals);
      const before = reads.mock.calls.length;
      await user.click(screen.getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(reads.mock.calls.length).toBeGreaterThan(before));
    });

    it('draws nothing about approvals when there are none and nothing failed', async () => {
      mockState = quietFixture;
      renderLayout();
      await waitFor(() => expect(screen.queryByTestId('mobile-now-attention')).toBeNull());
      expect(screen.queryByText(/could not check whether anything is waiting/i)).toBeNull();
    });

    it('draws a blocked Ask ONCE — the card, not the card and a row (DOR-1391)', async () => {
      // The double-draw: the phone answered the same question twice in one
      // viewport, as an answerable card at the top of Heads up and as a line of
      // text underneath it that only navigated. The card wins.
      const user = userEvent.setup();
      mockState = {
        ...quietFixture,
        attention: [
          {
            id: 'blocked:q-1',
            kind: 'question',
            primary: 'meeting-notes',
            secondary: 'has a question',
            since: new Date().toISOString(),
            deepLink: '/session?session=session-question-1',
          },
        ],
      };
      const transport = createMockTransport();
      transport.listPendingInteractions = vi
        .fn()
        .mockResolvedValue({ interactions: [aQuestion()] });
      renderLayout(null, transport);
      await user.click(screen.getByTestId('mobile-tab-home'));

      // The card is there…
      await screen.findByText('meeting-notes has a question');
      expect(screen.getByTestId('mobile-now-attention')).toBeInTheDocument();
      // …and the row for the same blockage is not.
      const rows = Array.from(panel('home').querySelectorAll('[data-sidebar-row]'));
      expect(rows.map((row) => row.textContent)).not.toContain('meeting-notes›has a question');
    });

    it('keeps the row when no card covers that blockage — the same panel, the other half', async () => {
      // A wedged session has no answerable card, so its row is the only thing
      // saying so. Without this, "the row is gone" above would also pass for a
      // panel that had stopped drawing Heads up rows at all.
      const user = userEvent.setup();
      mockState = {
        ...quietFixture,
        attention: [
          {
            id: 'error:ses-9',
            kind: 'error',
            primary: 'meeting-notes',
            secondary: 'Stopped with an error',
            since: new Date().toISOString(),
            deepLink: '/session?session=ses-9',
          },
        ],
      };
      const transport = createMockTransport();
      transport.listPendingInteractions = vi
        .fn()
        .mockResolvedValue({ interactions: [aQuestion()] });
      renderLayout(null, transport);
      await user.click(screen.getByTestId('mobile-tab-home'));

      await screen.findByText('meeting-notes has a question');
      const rows = Array.from(panel('home').querySelectorAll('[data-sidebar-row]'));
      expect(rows.map((row) => row.textContent)).toContain('meeting-notes›Stopped with an error');
    });

    it('reorders nothing by drag on a phone (R3)', () => {
      // Drag is off here — `SidebarDnd` never mounts a `DndContext` below 768px
      // — so the menu is the only way to move a row.
      //
      // **The WCAG 2.5.7 half of this claim lives where it can fail.** "Every
      // draggable row's menu carries a move action" is a property of the MENU
      // BUILDERS, so it is asserted on them: `AgentRowMenuItems.test.tsx` and
      // `RoomRowMenuItems.test.tsx` mount the menu and drive "Move to group".
      // The model once carried an `actions` array that read like the same
      // guarantee and was rendered by nothing at all.
      mockState = powerFixture;
      renderLayout();
      expect(document.querySelector('[data-dnd-context]')).toBeNull();
      expect(panel('library').querySelectorAll('[aria-roledescription="sortable"]')).toHaveLength(
        0
      );

      // …and the model really did mark rows draggable, so the absence above is
      // the phone rather than a fixture with nothing to drag.
      const draggable = buildSidebarModel(powerFixture)
        .zones.flatMap((zone) => zone.sections)
        .flatMap((section) => [section, ...(section.subsections ?? [])])
        .flatMap((section) => section.rows)
        .filter((row) => row.draggable);
      expect(draggable.length).toBeGreaterThan(0);
    });
  });
});
