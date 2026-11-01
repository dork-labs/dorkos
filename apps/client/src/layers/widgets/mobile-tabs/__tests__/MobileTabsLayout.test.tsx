// @vitest-environment jsdom
/**
 * The phone cockpit: three destinations, no drawer, and Home drawing the same
 * list the desktop panel draws.
 *
 * **The model half is real.** `useSidebarState` is the one thing stubbed — with
 * the programme's own journey fixtures, which is what a real cockpit hands the
 * model — and everything downstream of it runs: `useSidebarModel` calls the
 * real `buildSidebarModel`, `SidebarSections` draws the result, and the
 * assertions read the DOM those sections produced. A suite that stubbed the
 * model would prove the tabs render a mock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, cleanup, waitFor, within } from '@testing-library/react';
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

import { createInitialSlots, TransportProvider, useExtensionRegistry } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { buildSidebarModel } from '@/layers/features/dashboard-sidebar/model/build-sidebar-model';
import type { SidebarState } from '@/layers/features/dashboard-sidebar/model/sidebar-state';
import {
  addOn,
  busyFixture,
  powerFixture,
  quietFixture,
} from '@/layers/features/dashboard-sidebar/model/fixtures';
import { clearAskReceipts } from '@/layers/entities/attention';
import { LIVE_REGION_DEBOUNCE_MS } from '../model/use-live-region-text';

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
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
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
  useSidebarState: () => mockState,
  SIDEBAR_CLOCK_TICK_MS: 60_000,
}));
// A settled panel: these cases are about what each destination draws,
// not about the boot gate, whose own behaviour is covered in the sidebar
// feature's `model/boot/__tests__` (spec `sidebar-simplification` D6).
vi.mock('@/layers/features/dashboard-sidebar/model/boot/use-boot-state', () => ({
  useBootState: () => ({ phase: 'settled', settled: true, fleetKnown: true, startedWarm: false }),
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
import { MOBILE_TABS, MOBILE_TAB_BAR_DOCK } from '../model/mobile-tabs';

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
    area: null,
    alwaysOffered: false,
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
}

/**
 * One question an agent is parked on, shaped as the fleet-wide stream sends it.
 *
 * The id is a parameter because answering one schedules a 1_200 ms removal timer
 * against the module-level receipt store, and that timer outlives the test that
 * started it — `clearAskReceipts()` empties the store but cannot cancel a
 * `setTimeout` already in flight. One leaked timer is enough: it deletes by id,
 * so any later case reusing that id can have its held envelope taken away. Any
 * case that depends on the hold takes an id of its own.
 */
function aQuestion(id = 'q-1'): InteractionPendingEvent {
  return {
    sessionId: 'session-question-1',
    cwd: '/projects/meeting-notes',
    interaction: {
      type: 'question',
      id,
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

/**
 * Run a promise chain to completion while the fake clock barely moves.
 *
 * Bounded by event-loop turns rather than by wall clock, and it advances fake
 * time a millisecond at a time, so a hold measured in seconds cannot be spent by
 * the flush itself. `done` is re-asserted by the caller with a real `expect`, so
 * a flush that ran out of turns fails on the condition it was waiting for rather
 * than passing over a half-settled tree.
 */
async function flushOnFakeTime(done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 50 && !done(); turn += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
  }
}

/** The panel for a destination — the box the layout shows or puts away. */
const panel = (id: string) => screen.getByTestId(`mobile-tab-panel-${id}`);
/** Whether a panel is the one on screen, by the class that decides it. */
const showing = (id: string) => !panel(id).className.includes('invisible');
/** Every section inside one panel, in DOM order. */
const sectionsIn = (id: string) =>
  Array.from(panel(id).querySelectorAll('[data-sidebar-section]')).map((el) =>
    el.getAttribute('data-sidebar-section')
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
      // another destination is counted here whatever it ends up being called.
      const buttons = Array.from(document.querySelectorAll('[data-mobile-tab]'));
      expect(buttons).toHaveLength(MOBILE_TABS.length);
      expect(buttons.map((b) => b.textContent?.replace(/\d+/g, ''))).toEqual(
        MOBILE_TABS.map((t) => t.label)
      );
    });

    it('is Home, DorkBot and You — the list lives in one tab, so there is no second', () => {
      renderLayout();
      expect(MOBILE_TABS.map((tab) => tab.id)).toEqual(['home', 'dorkbot', 'you']);
      expect(screen.queryByTestId('mobile-tab-library')).not.toBeInTheDocument();
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
      await user.click(screen.getByTestId('mobile-tab-you'));
      expect(screen.getByTestId('mobile-tab-you')).toHaveAttribute('aria-current', 'page');

      // The observable half: a panel really was current a moment ago, so this
      // is a transition rather than a state that was never entered.
      commitNavigation('/session?session=abc');
      expect(document.querySelectorAll('[data-mobile-tab][aria-current]')).toHaveLength(0);
      expect(screen.getByTestId('mobile-tab-you')).not.toHaveAttribute('aria-current');
    });
  });

  describe('the Home badge (P4 AC-2)', () => {
    /** A transport with one approval and one question waiting. */
    function twoWaiting() {
      const transport = createMockTransport();
      transport.listPendingApprovals = vi.fn().mockResolvedValue({ approvals: [anApproval()] });
      transport.listPendingInteractions = vi
        .fn()
        .mockResolvedValue({ interactions: [aQuestion()] });
      return transport;
    }

    it('counts what is waiting on you — every approval and every question', async () => {
      renderLayout(null, twoWaiting());
      expect(await screen.findByTestId('mobile-tab-badge-home')).toHaveTextContent('2');
    });

    it('draws the count as the solid warning pill, on a bar with no hairline (Phase 4 S16)', async () => {
      renderLayout(null, twoWaiting());
      const badge = await screen.findByTestId('mobile-tab-badge-home');
      // The shared pill, not palette literals of its own.
      expect(badge).toHaveAttribute('data-slot', 'count-pill');
      expect(badge).toHaveAttribute('data-tone', 'warning');
      expect(badge).toHaveAttribute('data-placement', 'corner');
      expect(badge.className).not.toMatch(/amber/);
      // The bar's tint separates it; a border above it was a second edge.
      expect(screen.getByTestId('mobile-tab-bar').className).not.toMatch(/\bborder/);
    });

    it('is the same number the live region announces', async () => {
      const { container } = renderLayout(null, twoWaiting());
      const badge = (await screen.findByTestId('mobile-tab-badge-home')).textContent;
      // It publishes a second after the count settles (`LIVE_REGION_DEBOUNCE_MS`),
      // which is why this waits rather than reading straight after the render.
      await waitFor(
        () => {
          const live = container.querySelector('[aria-live="polite"]');
          expect(live?.textContent).toBe(`${badge} agents need you`);
        },
        { timeout: LIVE_REGION_DEBOUNCE_MS * 3 }
      );
    });

    it('announces the count from OUTSIDE the panels, where nothing is inert (P4.2)', async () => {
      // **The badge is `aria-hidden` because something else says the number.**
      // A region inside a panel would be `inert` whenever it is put away — so
      // for every moment the operator was in a conversation the count would be
      // announced by nobody at all.
      const { container } = renderLayout(null, twoWaiting());
      expect(await screen.findByTestId('mobile-tab-badge-home')).toHaveAttribute(
        'aria-hidden',
        'true'
      );

      const regions = Array.from(container.querySelectorAll('[aria-live="polite"]'));
      // Exactly one, so two regions cannot both say it — two regions carrying
      // one number is the siren BC-11 exists to prevent.
      expect(regions).toHaveLength(1);
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

    it('draws no badge when nothing is waiting, whatever the list holds', async () => {
      // `busy` is a full list — unread channels, a DM with a count — and none
      // of that is a reason to badge the bar: unread lives on the rows.
      mockState = busyFixture;
      renderLayout();
      await waitFor(() => expect(screen.queryByTestId('mobile-now-attention')).toBeNull());
      expect(screen.queryByTestId('mobile-tab-badge-home')).not.toBeInTheDocument();
    });

    it('never badges another destination', async () => {
      renderLayout(null, twoWaiting());
      await screen.findByTestId('mobile-tab-badge-home');
      expect(screen.queryByTestId('mobile-tab-badge-you')).not.toBeInTheDocument();
      expect(screen.queryByTestId('mobile-tab-badge-dorkbot')).not.toBeInTheDocument();
    });
  });

  describe('what each destination holds', () => {
    it('draws the whole list in Home: the top items, Channels, Direct messages', () => {
      renderLayout();
      expect(sectionsIn('home')).toEqual(['top', 'channels', 'dms']);
    });

    it('draws every section the model emits, once', () => {
      mockState = powerFixture;
      renderLayout();
      // Enumerated from the model's own build, never from a list written here.
      const emitted = buildSidebarModel(powerFixture).sections.map((section) => section.id);
      expect(sectionsIn('home')).toEqual(emitted);
    });

    it('keeps New in the header, and mounts no floating action button', () => {
      renderLayout();
      expect(within(panel('home')).getByTestId('sidebar-header-block')).toBeInTheDocument();
    });

    it('puts the four places DorkOS goes in You', () => {
      renderLayout();
      expect(within(panel('you')).getByTestId('sidebar-footer-strip')).toBeInTheDocument();
    });

    it('lists mini apps’ pages in Home’s list, and only there', () => {
      useExtensionRegistry.getState().register('pages', {
        id: 'flow:',
        extensionId: 'flow',
        path: '',
        component: () => null,
        title: 'Flow',
        menu: true,
      });
      mockState = { ...busyFixture, addOns: [addOn('flow', '', 'Flow')] };
      try {
        renderLayout();

        const addOns = panel('home').querySelector('[data-sidebar-section="addons"]');
        expect(addOns).not.toBeNull();
        expect(
          within(addOns as HTMLElement).getByRole('button', { name: 'Flow' })
        ).toBeInTheDocument();
        expect(
          within(panel('you')).queryByRole('button', { name: 'Flow' })
        ).not.toBeInTheDocument();
      } finally {
        useExtensionRegistry.setState({ slots: createInitialSlots() });
      }
    });

    it('mounts the bottom slot at the foot of Home, after the list, and nowhere else', () => {
      renderLayout();
      expect(panel('home').querySelectorAll('[data-slot="sidebar-bottom-slot"]').length).toBe(1);
      expect(panel('you').querySelectorAll('[data-slot="sidebar-bottom-slot"]').length).toBe(0);

      const sections = panel('home').querySelectorAll('[data-sidebar-section]');
      const slot = panel('home').querySelector('[data-slot="sidebar-bottom-slot"]');
      const last = sections[sections.length - 1]!;
      // Excluding CONTAINED_BY: a descendant reports as FOLLOWING too, so the
      // bare flag would pass with the slot rendered INSIDE the last section.
      const position = last.compareDocumentPosition(slot!);
      expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(position & Node.DOCUMENT_POSITION_CONTAINED_BY).toBeFalsy();
    });
  });

  describe('a contributed sidebar.body takeover', () => {
    it('replaces Home’s list and nothing else', () => {
      renderLayout(<div data-testid="takeover-body">facets</div>);
      expect(within(panel('home')).getByTestId('takeover-body')).toBeInTheDocument();
      expect(sectionsIn('home')).toEqual([]);
      // The way to make things stays: the header block is not the list.
      expect(within(panel('home')).getByTestId('sidebar-header-block')).toBeInTheDocument();
    });

    it('keeps what is waiting on you above it — browsing is not a reason to stop being told', async () => {
      const transport = createMockTransport();
      transport.listPendingApprovals = vi.fn().mockResolvedValue({ approvals: [anApproval()] });
      renderLayout(<div data-testid="takeover-body">facets</div>, transport);
      expect(await within(panel('home')).findByText('Write to a file')).toBeInTheDocument();
      expect(screen.getByTestId('mobile-tab-badge-home')).toBeInTheDocument();
    });
  });

  describe('switching destinations (P4 AC-1)', () => {
    it('shows one panel at a time and unmounts none of them', async () => {
      const user = userEvent.setup();
      renderLayout();
      await user.click(screen.getByTestId('mobile-tab-home'));
      expect(showing('home')).toBe(true);
      expect(showing('you')).toBe(false);

      await user.click(screen.getByTestId('mobile-tab-you'));
      expect(showing('you')).toBe(true);
      expect(showing('home')).toBe(false);
      // Still in the tree — which is what makes a scroll offset survivable.
      expect(panel('home')).toBeInTheDocument();
    });

    it('carries Home’s scroll offset through a round trip to You', async () => {
      const user = userEvent.setup();
      renderLayout();
      await user.click(screen.getByTestId('mobile-tab-home'));
      // The scroller PageContainer owns, driven the way a thumb drives it.
      const scroller = panel('home').querySelector<HTMLElement>('.overflow-y-auto');
      expect(scroller).not.toBeNull();
      scroller!.scrollTop = 240;

      await user.click(screen.getByTestId('mobile-tab-you'));
      await user.click(screen.getByTestId('mobile-tab-home'));

      // Same element — not a remount — and the offset it was left at.
      expect(panel('home').querySelector<HTMLElement>('.overflow-y-auto')).toBe(scroller);
      expect(scroller!.scrollTop).toBe(240);
      expect(panel('home').className).not.toContain('hidden');
    });

    it('hides an inactive panel from the keyboard and the accessibility tree', async () => {
      const user = userEvent.setup();
      renderLayout();
      await user.click(screen.getByTestId('mobile-tab-you'));
      expect(panel('home')).toHaveAttribute('inert');
      expect(panel('you')).not.toHaveAttribute('inert');
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

    // ── Re-opening the conversation you already have open is the commonest tap
    //    of all, and TanStack reports it as an unchanged href. A layout that
    //    diffed hrefs did nothing here, leaving a layer with no way out. ──
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
      const user = userEvent.setup();
      renderLayout();
      await user.click(screen.getByTestId('mobile-tab-home'));
      commitNavigation();
      expect(screen.getByTestId('mobile-tab-panels').className).toContain('invisible');

      await user.click(screen.getByTestId('mobile-tab-you'));
      expect(screen.getByTestId('mobile-tab-panels').className).not.toContain('invisible');
      expect(showing('you')).toBe(true);
    });

    it('publishes whether a panel covers the page, for the shell to act on', () => {
      // The bit `AppShell` reads to mark the routed page `inert` (review B2).
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
      await user.click(screen.getByTestId('mobile-tab-you'));

      await user.click(screen.getByTestId('mobile-tab-dorkbot'));

      // The press did nothing, so it took nothing away either.
      expect(showing('you')).toBe(true);
      expect(screen.getByTestId('mobile-tab-you')).toHaveAttribute('aria-current', 'page');
    });

    it('is pressable, and only disabled by the roster', async () => {
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
      // One string, two uses.
      expect(bar.style.height).toBe(MOBILE_TAB_BAR_DOCK);
      // Plus whatever a docked PIP is holding — absent, `--pip-dock` resolves
      // to the `0px` fallback and this is the bar's height and nothing else.
      expect(panels.style.bottom).toBe(`calc(${MOBILE_TAB_BAR_DOCK} + var(--pip-dock, 0px))`);
    });

    it('publishes the bar height so other layers can dock above it (DOR-1177)', () => {
      const { unmount } = renderLayout();
      expect(document.documentElement.style.getPropertyValue('--mobile-tab-dock')).toBe(
        MOBILE_TAB_BAR_DOCK
      );

      // And it goes away with the cockpit.
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

    it('puts an approval at the top of Home and lets it be answered without going anywhere (AC-5)', async () => {
      const user = userEvent.setup();
      mockState = quietFixture;
      const transport = createMockTransport();
      transport.listPendingApprovals = vi.fn().mockResolvedValue({ approvals: [anApproval()] });
      renderLayout(null, transport);
      // Go to Home the way an operator does, so "the panel is still up
      // afterwards" is a claim about answering rather than about a cold load.
      await user.click(screen.getByTestId('mobile-tab-home'));

      const card = await screen.findByText('Write to a file');
      // In Home, above the list — the raised panel covers the header's Inbox.
      const cards = within(panel('home')).getByTestId('mobile-now-attention');
      expect(cards.contains(card)).toBe(true);
      const firstSection = panel('home').querySelector('[data-sidebar-section]');
      expect(
        cards.compareDocumentPosition(firstSection!) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();

      const before = mockHref;
      await user.click(screen.getByRole('button', { name: /^Allow$/ }));
      await waitFor(() => expect(transport.grantApproval).toHaveBeenCalledWith('ap-1', undefined));
      // The route did not change and no navigation was committed.
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

      // The same headline `AskList`/`InteractionAsk` draw everywhere else.
      const card = await screen.findByText('meeting-notes has a question');
      expect(within(panel('home')).getByTestId('mobile-now-attention').contains(card)).toBe(true);

      // "Skip" submits an empty answer, exactly as it does on every other
      // surface that draws this card.
      await user.click(screen.getByRole('button', { name: 'Skip' }));
      await waitFor(() =>
        expect(transport.submitAnswers).toHaveBeenCalledWith('session-question-1', 'q-1', {})
      );
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('opens the session from a mobile Ask card', async () => {
      const user = userEvent.setup();
      mockState = quietFixture;
      const transport = createMockTransport();
      transport.listPendingInteractions = vi
        .fn()
        .mockResolvedValue({ interactions: [aQuestion()] });
      renderLayout(null, transport);
      await user.click(screen.getByTestId('mobile-tab-home'));
      await screen.findByText('meeting-notes has a question');

      await user.click(screen.getByRole('button', { name: 'Open chat' }));

      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/session',
        search: { session: 'session-question-1' },
      });
    });

    it('holds the slot open long enough to show the receipt after the last Ask is answered', async () => {
      // Answering the only pending Ask used to unmount this whole slot the
      // instant the refetch came back empty, tearing the "You said no" receipt
      // away in the same frame it appeared.
      const user = userEvent.setup();
      mockState = quietFixture;
      const transport = createMockTransport();
      // An id of its own: an earlier case answers `q-1`, leaving a 1_200 ms
      // timer running that deletes `q-1` from the shared receipt store whenever
      // it lands.
      const held = aQuestion('q-held');
      transport.listPendingInteractions = vi
        .fn()
        .mockResolvedValueOnce({ interactions: [held] })
        .mockResolvedValue({ interactions: [] });
      renderLayout(null, transport);
      await user.click(screen.getByTestId('mobile-tab-home'));
      await screen.findByText('meeting-notes has a question');

      // **The clock from here on is the test's, not the machine's.** Only
      // `setTimeout` is faked, which is the one thing the hold uses.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
        await flushOnFakeTime(
          () => vi.mocked(transport.listPendingInteractions).mock.calls.length >= 2
        );

        expect(transport.submitAnswers).toHaveBeenCalledWith('session-question-1', 'q-held', {});
        expect(transport.listPendingInteractions).toHaveBeenCalledTimes(2);
        expect(screen.getByTestId('mobile-now-attention')).toBeInTheDocument();
        expect(screen.getByText('You said no')).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('says so loudly when the approval list cannot be read', async () => {
      mockState = quietFixture;
      const transport = createMockTransport();
      transport.listPendingApprovals = vi.fn().mockRejectedValue(new Error('offline'));
      renderLayout(null, transport);

      const notice = await screen.findByText(/Couldn’t check for approvals/i);
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
      expect(screen.queryByText(/Couldn’t check for approvals/i)).toBeNull();
    });

    it('reorders nothing by drag on a phone (R3)', () => {
      // Drag is off here — `SidebarDnd` never mounts a `DndContext` below 768px
      // — so the menu is the only way to move a row. "Every draggable row's
      // menu carries a move action" is asserted on the menu builders:
      // `AgentRowMenuItems.test.tsx` and `RoomRowMenuItems.test.tsx`.
      mockState = powerFixture;
      renderLayout();
      expect(document.querySelector('[data-dnd-context]')).toBeNull();
      expect(panel('home').querySelectorAll('[aria-roledescription="sortable"]')).toHaveLength(0);

      // …and the model really did mark rows draggable, so the absence above is
      // the phone rather than a fixture with nothing to drag.
      const draggable = buildSidebarModel(powerFixture)
        .sections.flatMap((section) => section.rows)
        .filter((row) => row.draggable);
      expect(draggable.length).toBeGreaterThan(0);
    });
  });
});
