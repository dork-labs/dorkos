// @vitest-environment jsdom
/**
 * The phone cockpit: three destinations, no drawer, and Home drawing the same list the desktop
 * panel draws.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import type { InteractionPendingEvent } from '@dorkos/shared/interaction-events';

// ── The global event stream ──────────────────────────────────────────────── The Home tab now
// reads the approval queue (P4 AC-5), and that query keeps itself live off the SSE fan-out.
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
import type { SidebarState } from '@/layers/features/dashboard-sidebar/model/sidebar-state';
import {
  appsState,
  pinnedApp,
  busyFixture,
  quietFixture,
} from '@/layers/features/dashboard-sidebar/model/fixtures';
import { clearAskReceipts } from '@/layers/entities/attention';
import { LIVE_REGION_DEBOUNCE_MS } from '../model/use-live-region-text';

// ── Router ────────────────────────────────────────────────────────────────── **The subscription
// is the seam under test, so the mock is a real one.** `commitNavigation()` fires every
// `onBeforeLoad` listener exactly as TanStack does on a committed load — INCLUDING one that lands
// on the URL already showing, which is the case the layout used to miss (review B1) and the case
let mockHref = '/';
const mockNavigate = vi.fn();
const beforeLoadListeners = new Set<() => void>();
/** Commit a navigation to `href`, defaulting to the URL already showing. */
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
// A settled panel: these cases are about what each destination draws, not about the boot gate,
// whose own behaviour is covered in the sidebar feature's `model/boot/__tests__` (spec
// `sidebar-simplification` D6).
vi.mock('@/layers/features/dashboard-sidebar/model/boot/use-boot-state', () => ({
  useBootState: () => ({ phase: 'settled', settled: true, fleetKnown: true, startedWarm: false }),
}));
vi.mock('@/layers/features/dashboard-sidebar/model/use-legacy-pin-migration', () => ({
  useLegacyPinMigration: () => {},
}));

// The two pieces of chrome the panels borrow are covered by their own suites; here they only need
// to be findable, so the assertions are about WHERE the layout puts them rather than about what
// they contain.
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

// ── The viewport ─────────────────────────────────────────────────────────── jsdom has none, and
// `useIsMobile` is a `matchMedia` question — so the touch half of this file (P4.2) sets it and
// the rest runs at the pointer default, exactly as the components do.
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

/** One question an agent is parked on, shaped as the fleet-wide stream sends it. */
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

/** Run a promise chain to completion while the fake clock barely moves. */
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
  // The Ask receipt store is module-level, shared by every card `AskList` draws anywhere in the
  // app — a "You said no" from one test's answered question would otherwise still be showing when
  // the next test's fixture reuses its interaction id.
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

    it('marks exactly one destination current once a panel is up', async () => {
      const user = userEvent.setup();
      renderLayout();
      await user.click(screen.getByTestId('mobile-tab-home'));
      expect(screen.getByTestId('mobile-tab-home')).toHaveAttribute('aria-current', 'page');
      expect(document.querySelectorAll('[data-mobile-tab][aria-current]')).toHaveLength(1);
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

    it('announces the count from OUTSIDE the panels, where nothing is inert (P4.2)', async () => {
      // **The badge is `aria-hidden` because something else says the number.** A region inside a
      // panel would be `inert` whenever it is put away — so for every moment the operator was in
      // a conversation the count would be announced by nobody at all.
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
  });

  describe('what each destination holds', () => {
    it('draws the whole list in Home: the top items, Channels, Direct messages', () => {
      renderLayout();
      expect(sectionsIn('home')).toEqual(['top', 'channels', 'dms']);
    });

    it('lists pinned apps under Home’s Apps door, and only there', () => {
      useExtensionRegistry.getState().register('pages', {
        id: 'flow:',
        extensionId: 'flow',
        path: '',
        component: () => null,
        title: 'Flow',
        menu: true,
      });
      mockState = { ...busyFixture, apps: appsState({ pinned: [pinnedApp('flow', 'Flow')] }) };
      try {
        renderLayout();

        const pins = within(panel('home')).getByRole('group', { name: 'Pinned apps' });
        expect(within(pins).getByRole('button', { name: 'Flow' })).toBeInTheDocument();
        expect(
          within(panel('you')).queryByRole('button', { name: 'Flow' })
        ).not.toBeInTheDocument();
      } finally {
        useExtensionRegistry.setState({ slots: createInitialSlots() });
      }
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

  // ───────────────────────────────────────────────────────────────────────── Touch (P4.2).
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

    it('holds the slot open long enough to show the receipt after the last Ask is answered', async () => {
      // Answering the only pending Ask used to unmount this whole slot the instant the refetch
      // came back empty, tearing the "You said no" receipt away in the same frame it appeared.
      const user = userEvent.setup();
      mockState = quietFixture;
      const transport = createMockTransport();
      // An id of its own: an earlier case answers `q-1`, leaving a 1_200 ms timer running that
      // deletes `q-1` from the shared receipt store whenever it lands.
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
  });
});
