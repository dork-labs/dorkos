/**
 * The pinned triage header: what it draws, what it refuses to draw, and what a
 * decision answered inside it does to the page around it (spec
 * `team-room-home` D3.3).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect, useState } from 'react';
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import type { Transport } from '@dorkos/shared/transport';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import type { Session, Task } from '@dorkos/shared/types';
import type {
  ListNotificationsResponse,
  NotificationDTO,
} from '@dorkos/shared/notification-schemas';
import { createMockTransport } from '@dorkos/test-utils';

/**
 * The viewport, as a box a test can set. jsdom has no media queries worth
 * asking, and the condense rule turns on the answer.
 */
const { viewport } = vi.hoisted(() => ({ viewport: { mobile: false } }));

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useEventSubscription: vi.fn(), useIsMobile: () => viewport.mobile };
});

import { TransportProvider, useEventSubscription } from '@/layers/shared/model';
import { useSessionListStore } from '@/layers/entities/session';
import {
  discardPendingRejections,
  discardSettlingSchedules,
} from '@/layers/features/schedule-approval';
import { PinnedTriageHeader } from '../ui/PinnedTriageHeader';
import { PinnedTriageHeaderView, type TriagePresenceSlot } from '../ui/PinnedTriageHeaderView';

/** The header element itself, or `null` when it drew nothing at all. */
function header(): HTMLElement | null {
  return document.querySelector('[data-slot="pinned-triage-header"]');
}

/** The condensed one-line bar, or `null` when the header is drawing in full. */
function summaryBar(): HTMLElement | null {
  return document.querySelector('[data-slot="pinned-triage-summary"]');
}

/** The header's internal scroller — the box with the height cap on it. */
function scroller(): HTMLElement | null {
  return document.querySelector('[data-slot="pinned-triage-scroller"]');
}

/** The fade drawn over one edge, or `null` when nothing is behind that edge. */
function fade(edge: 'top' | 'bottom'): HTMLElement | null {
  return document.querySelector(`[data-slot="pinned-triage-fade-${edge}"]`);
}

/**
 * Tell the scroller how tall it is, because jsdom lays nothing out.
 *
 * Every metric a cue turns on reads zero in this environment, so the geometry is
 * stubbed and what is pinned here is the WIRING: the header asks its scroller,
 * and draws the cue the answer calls for.
 */
function stubMetrics(
  el: HTMLElement,
  metrics: { scrollHeight: number; clientHeight: number; scrollTop?: number }
) {
  Object.defineProperty(el, 'scrollHeight', { value: metrics.scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: metrics.clientHeight, configurable: true });
  el.scrollTop = metrics.scrollTop ?? 0;
}

/** Stub the scroller's geometry and tell the header somebody scrolled. */
function measureAs(
  el: HTMLElement,
  metrics: { scrollHeight: number; clientHeight: number; scrollTop?: number }
) {
  stubMetrics(el, metrics);
  fireEvent.scroll(el);
}

/** What the header is currently saying to a screen reader. */
function announcement(): string {
  return document.querySelector('[role="status"][aria-live="polite"]')?.textContent ?? '';
}

/** Build a pending approval, overriding only what a test cares about. */
function buildApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    approvalId: '01JZ0000000000000000000001',
    capabilityId: 'marketplace.uninstall',
    capabilityTitle: 'Uninstall a marketplace package',
    tier: 'destructive',
    summary: 'Uninstall "sentry-monitor"',
    requestedBy: '/Users/dev/agents/dorkbot',
    hasAgentPath: true,
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 8.5 * 60_000).toISOString(),
    ...overrides,
  };
}

/**
 * Frozen at module load rather than read per call, so every row in one run is
 * the same age and a suite that takes a minute cannot have its first fixture
 * age differently from its last.
 */
const LOADED_AT = Date.now();

/** One minute, in milliseconds. */
const MINUTE_MS = 60_000;

/**
 * An Inbox page holding one "agent stopped answering" row per name.
 *
 * The cheapest way to put one real Recent-Activity row on screen: those rows are
 * Inbox notifications now (DOR-1384), not a derivation over mesh liveness, so
 * one transport answer still does it and the row still owns the
 * `?detail=offline-agent` deep link.
 */
function offlineAgents(...names: string[]) {
  return {
    notifications: names.map((name, i) => ({
      id: `01JZH000000000000000000${i}`,
      kind: 'agent.unreachable' as const,
      tier: 'quiet' as const,
      subject: { type: 'agent' as const, id: name },
      agentId: name,
      title: `${name} stopped answering`,
      // RELATIVE, never a literal date. The activity group only draws the last
      // 24 hours (`useActivityNotifications`), so a fixture pinned to a calendar
      // day is a test that passes until the wall clock walks past it and then
      // fails for a reason that has nothing to do with the code. This one did:
      // written at 22h old, red by the same afternoon.
      createdAt: new Date(LOADED_AT - MINUTE_MS).toISOString(),
    })),
    nextCursor: null,
    unreadCount: names.length,
  };
}

/** The one unread `report.daily` row this file seeds, overriding only what a test cares about. */
function shiftReportRow(overrides: Partial<NotificationDTO> = {}): NotificationDTO {
  return {
    id: '01JZR000000000000000000S1',
    kind: 'report.daily',
    tier: 'quiet',
    subject: { type: 'system', id: '2026-08-19' },
    title: 'While you were away: 3 runs finished, 1 run needs a look',
    body: '3 runs finished. 1 run needs a look.',
    createdAt: new Date(LOADED_AT - MINUTE_MS).toISOString(),
    ...overrides,
  };
}

/**
 * `listNotifications`, split by which lens is asking.
 *
 * `useActivityNotifications` and `useShiftReport` share the same transport
 * method but read different kinds through different lenses, so a flat
 * `mockResolvedValue` cannot answer both truthfully — whatever it returns
 * would land in BOTH caches (a bare-agent-unreachable fixture handed to the
 * `report.daily` lens renders as a fabricated Shift Report). This inspects
 * the query the way the real server route does: `activity` for anything else,
 * `report` rows only for a `report.daily` lens.
 */
function notificationsByLens(
  options: { activity?: ListNotificationsResponse; report?: NotificationDTO[] } = {}
) {
  const empty: ListNotificationsResponse = { notifications: [], nextCursor: null, unreadCount: 0 };
  return vi.fn().mockImplementation(
    (query?: { kind?: string[] }): Promise<ListNotificationsResponse> =>
      query?.kind?.includes('report.daily')
        ? Promise.resolve({
            notifications: options.report ?? [],
            nextCursor: null,
            unreadCount: options.report?.length ?? 0,
          })
        : Promise.resolve(options.activity ?? empty)
  );
}

/** A schedule an agent proposed and parked, waiting on a yes or a no. */
function parkedSchedule(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    name: 'nightly-sweep',
    displayName: 'Nightly sweep',
    description: null,
    prompt: 'Sweep the backlog.',
    cron: '0 3 * * *',
    timezone: 'UTC',
    agentId: null,
    enabled: false,
    maxRuntime: null,
    permissionMode: 'default',
    status: 'pending_approval',
    filePath: '/tmp/nightly-sweep/SKILL.md',
    createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    reason: null,
    proposedBySessionId: null,
    proposedByAgentPath: null,
    proposedByName: null,
    origin: null,
    nextRuns: [],
    ...overrides,
  };
}

/** A session row as the recent-sessions read answers with it. */
function sessionRow(id: string, title: string): Session {
  return {
    id,
    title,
    cwd: '/projects/alpha',
    createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    permissionMode: 'default',
    runtime: 'claude-code',
  };
}

/** Tell the global session store what each session is doing. */
function setLifecycles(entries: Record<string, 'blocked' | 'error'>) {
  act(() => {
    for (const [id, lifecycle] of Object.entries(entries)) {
      useSessionListStore.getState().setSessionStatus(id, { lifecycle } as never);
    }
  });
}

/**
 * Render the header inside a router, because the attention rows navigate and the
 * detail sheets read the URL they navigate to. The search schema is deliberately
 * permissive: this file pins the header's behaviour, and the real schema is the
 * app router's.
 */
function renderHeader(
  overrides: Partial<Transport> = {},
  props: {
    presence?: TriagePresenceSlot;
    composerFocused?: boolean;
    onExpand?: () => void;
  } = {}
) {
  const transport = createMockTransport(overrides);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  const rootRoute = createRootRoute({ staticData: { header: null }, component: () => <Outlet /> });
  const indexRoute = createRoute({
    staticData: { header: null },
    getParentRoute: () => rootRoute,
    path: '/',
    validateSearch: (search: Record<string, unknown>) => search,
    component: () => <PinnedTriageHeader {...props} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });

  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        {/* The test tree is not the app's registered router; the cast is only so
            the provider's generic accepts it. */}
        <RouterProvider router={router as never} />
      </TransportProvider>
    </QueryClientProvider>
  );

  return { transport, router };
}

/** The header's own props, as this file swaps them. */
type HeaderProps = { composerFocused?: boolean; onExpand?: () => void };

/**
 * The same header with one approval waiting, and a way to change its props
 * afterwards — because the state machine is about the TRANSITIONS: the caret
 * arriving in the composer, and leaving it again.
 *
 * The route tree closes over its component, so the swap cannot come from
 * re-rendering the provider; a host holding the props in state is what makes
 * them movable.
 */
function renderHeaderRerenderable(initial: HeaderProps) {
  const transport = createMockTransport({
    listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  let apply: ((next: HeaderProps) => void) | null = null;

  function Host() {
    const [props, setProps] = useState(initial);
    // Published from an effect, never during render: assigning to an outer
    // binding while rendering is exactly the impurity the lint rule is for.
    useEffect(() => {
      apply = setProps;
      return () => {
        apply = null;
      };
    }, []);
    return <PinnedTriageHeader {...props} />;
  }

  const rootRoute = createRootRoute({ staticData: { header: null }, component: () => <Outlet /> });
  const indexRoute = createRoute({
    staticData: { header: null },
    getParentRoute: () => rootRoute,
    path: '/',
    validateSearch: (search: Record<string, unknown>) => search,
    component: Host,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });

  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <RouterProvider router={router as never} />
      </TransportProvider>
    </QueryClientProvider>
  );

  return {
    transport,
    rerender: (next: HeaderProps) => act(() => apply?.(next)),
  };
}

// The session store is a module singleton, so a lifecycle one case seeds would
// otherwise still be there for the next one.
beforeEach(() => {
  useSessionListStore.getState().resetStatuses();
});

/**
 * Getting out of the keyboard's way (spec task 2.7's browser gate).
 *
 * jsdom cannot measure a software keyboard, so what is pinned here is the STATE
 * MACHINE — when the header condenses, what the line says, and what tapping it
 * asks the host to do. The geometry that made this necessary (the composer 129px
 * behind the keyboard at 375×812 with one approval showing) is the browser
 * gate's to prove, and its recapture is where a regression would surface.
 */
describe('PinnedTriageHeader while the composer has the caret', () => {
  beforeEach(() => {
    vi.mocked(useEventSubscription).mockImplementation(() => {});
    viewport.mobile = true;
  });

  afterEach(() => {
    cleanup();
    discardPendingRejections();
    discardSettlingSchedules();
    viewport.mobile = false;
    vi.clearAllMocks();
  });

  it('condenses to one line of counts on a phone', async () => {
    renderHeader(
      {
        listPendingApprovals: vi.fn().mockResolvedValue({
          approvals: [
            buildApproval({ approvalId: '01JZ0000000000000000000001' }),
            buildApproval({ approvalId: '01JZ0000000000000000000002' }),
          ],
        }),
        listNotifications: notificationsByLens({ activity: offlineAgents('tangerines') }),
      },
      { composerFocused: true }
    );

    expect(await screen.findByText('2 waiting · 1 needs attention')).toBeInTheDocument();
    expect(summaryBar()).not.toBeNull();
    // The cards are gone, not merely shorter: that is the point — every pixel
    // they were taking goes back to the box being typed in.
    expect(header()).toBeNull();
    expect(document.querySelector('[data-slot="approval-card"]')).toBeNull();
  });

  it('asks the host to give the caret back when the line is tapped', async () => {
    // The header cannot dismiss the keyboard itself; the composer holding it is
    // a sibling. So it asks, and the host blurs.
    const onExpand = vi.fn();
    renderHeader(
      { listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }) },
      { composerFocused: true, onExpand }
    );

    await userEvent.click(await screen.findByRole('button', { name: /1 waiting/ }));

    expect(onExpand).toHaveBeenCalledOnce();
  });

  it('draws the whole header again the moment the caret leaves', async () => {
    // What the host's blur produces, one prop later: there is no second flag
    // for "expanded", so the two can never disagree.
    const { rerender } = renderHeaderRerenderable({ composerFocused: true });
    await screen.findByText('1 waiting');

    rerender({ composerFocused: false });

    expect(await screen.findByText('Waiting On You')).toBeInTheDocument();
    expect(summaryBar()).toBeNull();
  });

  it('leaves a wide screen alone: there is no keyboard eating the viewport', async () => {
    viewport.mobile = false;
    renderHeader(
      { listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }) },
      { composerFocused: true }
    );

    expect(await screen.findByText('Waiting On You')).toBeInTheDocument();
    expect(summaryBar()).toBeNull();
  });

  it('says the same thing to a screen reader, condensed or not', async () => {
    // Condensing is a visual condensation, not a content change: announcing it
    // again would report the header's shape as if it were news.
    const { rerender } = renderHeaderRerenderable({ composerFocused: false });
    await waitFor(() => expect(announcement()).toBe('1 request is waiting on you.'));

    rerender({ composerFocused: true });

    await screen.findByText('1 waiting');
    expect(announcement()).toBe('1 request is waiting on you.');
  });

  it('condenses to nothing rather than to an empty bar', async () => {
    // Held open by the presence strip alone, there are no counts to write. A
    // bar saying nothing is worse than no bar.
    const { transport } = renderHeader(
      {},
      {
        composerFocused: true,
        presence: { occupied: true, node: <p data-testid="presence-strip" /> },
      }
    );

    await waitFor(() => expect(transport.listPendingApprovals).toHaveBeenCalled());

    expect(summaryBar()).toBeNull();
    expect(header()).toBeNull();
  });
});

/**
 * More waiting than the header is allowed to be tall (DOR-1043).
 *
 * At its height cap the header cuts the last card mid-row, and a cut-off card
 * looks exactly like the end of the list — macOS draws no scrollbar until you
 * have already scrolled, so nothing at all said there was more. The fix is a
 * fade over whichever edge still has content behind it.
 */
describe('PinnedTriageHeader at its height cap', () => {
  beforeEach(() => {
    vi.mocked(useEventSubscription).mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    // The undo window is module-level on purpose (it has to survive the popover
    // unmounting), so `cleanup()` does not end it — a rejection left pending
    // here would fire its DELETE in the middle of a later, unrelated case.
    discardPendingRejections();
    discardSettlingSchedules();
    vi.clearAllMocks();
  });

  it('says there is more below when the list is taller than the cap', async () => {
    renderHeader({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
    });
    await screen.findByText('Waiting On You');

    act(() => {
      measureAs(scroller()!, { scrollHeight: 900, clientHeight: 300, scrollTop: 0 });
    });

    expect(fade('bottom')).not.toBeNull();
    // Nothing is hidden above yet, and a cue over content that is not there is
    // worse than no cue (ADR 260725-004456).
    expect(fade('top')).toBeNull();
  });

  it('draws no cue at all when everything already fits', async () => {
    renderHeader({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
    });
    await screen.findByText('Waiting On You');

    act(() => {
      measureAs(scroller()!, { scrollHeight: 300, clientHeight: 300 });
    });

    expect(fade('bottom')).toBeNull();
    expect(fade('top')).toBeNull();
  });

  it('swaps the cue to the top edge once the list is scrolled to its end', async () => {
    renderHeader({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
    });
    await screen.findByText('Waiting On You');

    act(() => {
      measureAs(scroller()!, { scrollHeight: 900, clientHeight: 300, scrollTop: 600 });
    });

    expect(fade('bottom')).toBeNull();
    expect(fade('top')).not.toBeNull();
  });

  it('keeps the cue out of the way of the cards it is drawn over', async () => {
    renderHeader({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
    });
    await screen.findByText('Waiting On You');

    act(() => {
      measureAs(scroller()!, { scrollHeight: 900, clientHeight: 300, scrollTop: 0 });
    });

    // Decoration only: it sits over an Allow button at the bottom edge, and a
    // click landing on the gradient instead of the button would be the defect.
    expect(fade('bottom')!.className).toContain('pointer-events-none');
    expect(fade('bottom')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('cues a list that GREW, with nobody scrolling', async () => {
    // The ticket's real trigger: an approval lands over the event stream, the
    // list gets longer, and no scroll event is fired because nobody touched it.
    // Drawn from props here so the growth is a plain re-render.
    function Host() {
      const [count, setCount] = useState(1);
      return (
        <>
          <button type="button" onClick={() => setCount(4)}>
            grow
          </button>
          <PinnedTriageHeaderView
            asks={[]}
            settlingAsks={[]}
            askAgentNames={{}}
            onOpenSession={() => {}}
            approvals={Array.from({ length: count }, (_, i) =>
              buildApproval({ approvalId: `01JZ00000000000000000000${i}` })
            )}
            approvalsUnavailable={false}
            onRetryApprovals={() => {}}
            scheduleApprovals={[]}
            errorSignals={[]}
            activityItems={[]}
            onOpenActivity={() => {}}
          />
        </>
      );
    }

    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <TransportProvider transport={createMockTransport()}>
          <Host />
        </TransportProvider>
      </QueryClientProvider>
    );
    await screen.findByText('Waiting On You');

    act(() => {
      measureAs(scroller()!, { scrollHeight: 300, clientHeight: 300 });
    });
    expect(fade('bottom')).toBeNull();

    // The cards arrive, and the box they are in stays exactly the size it was.
    stubMetrics(scroller()!, { scrollHeight: 900, clientHeight: 300 });
    await userEvent.click(screen.getByRole('button', { name: 'grow' }));

    expect(fade('bottom')).not.toBeNull();
  });

  it('has no scroller to cue while the header is condensed to one line', async () => {
    // One line of counts cannot overflow, and a fade across it would be a
    // smudge on the only thing there is to read.
    viewport.mobile = true;
    renderHeader(
      { listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }) },
      { composerFocused: true }
    );
    await screen.findByText('1 waiting');

    expect(scroller()).toBeNull();
    expect(fade('bottom')).toBeNull();
    expect(fade('top')).toBeNull();
    viewport.mobile = false;
  });
});

describe('PinnedTriageHeader', () => {
  beforeEach(() => {
    vi.mocked(useEventSubscription).mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    // The undo window is module-level on purpose (it has to survive the popover
    // unmounting), so `cleanup()` does not end it — a rejection left pending
    // here would fire its DELETE in the middle of a later, unrelated case.
    discardPendingRejections();
    discardSettlingSchedules();
    vi.clearAllMocks();
  });

  it('draws nothing at all when nothing is waiting and nothing is wrong', async () => {
    const { transport } = renderHeader();

    // Wait for the reads to land: asserting absence before they resolve would
    // pass against a header that simply had not been told anything yet.
    await waitFor(() => expect(transport.listPendingApprovals).toHaveBeenCalled());
    await waitFor(() => expect(transport.listNotifications).toHaveBeenCalled());

    expect(header()).toBeNull();
    expect(screen.queryByText('Waiting On You')).not.toBeInTheDocument();
    expect(screen.queryByText('Needs Attention')).not.toBeInTheDocument();
    expect(screen.queryByText('Recent Activity')).not.toBeInTheDocument();
    // The live region stays — always mounted, and silent.
    expect(announcement()).toBe('');
  });

  it('stays on screen for the presence slot alone, with neither group drawn', async () => {
    renderHeader(
      {},
      { presence: { occupied: true, node: <p data-testid="presence-strip">Nobody is working</p> } }
    );

    expect(await screen.findByTestId('presence-strip')).toBeInTheDocument();
    expect(header()).not.toBeNull();
    expect(screen.queryByText('Waiting On You')).not.toBeInTheDocument();
    expect(screen.queryByText('Needs Attention')).not.toBeInTheDocument();
  });

  it('draws no header for a presence slot that says it has nothing to draw', async () => {
    // The slot carries its own occupancy precisely so a strip standing down
    // cannot leave an empty bordered box pinned to the top of the screen.
    const { transport } = renderHeader(
      {},
      { presence: { occupied: false, node: <p data-testid="presence-strip" /> } }
    );

    await waitFor(() => expect(transport.listPendingApprovals).toHaveBeenCalled());
    await waitFor(() => expect(transport.listNotifications).toHaveBeenCalled());

    expect(header()).toBeNull();
    expect(screen.queryByTestId('presence-strip')).not.toBeInTheDocument();
  });

  it('announces what arrived, by count rather than by card', async () => {
    renderHeader({
      listPendingApprovals: vi.fn().mockResolvedValue({
        approvals: [
          buildApproval({ approvalId: '01JZ0000000000000000000001' }),
          buildApproval({ approvalId: '01JZ0000000000000000000002' }),
        ],
      }),
      listNotifications: notificationsByLens({ activity: offlineAgents('tangerines') }),
    });

    await waitFor(() =>
      expect(announcement()).toBe('2 requests are waiting on you. 1 thing needs attention.')
    );
  });

  it('holds its own height rather than being squeezed by the feed under it', async () => {
    renderHeader({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
    });

    await screen.findByText('Uninstall a marketplace package');
    // It is a flex sibling ABOVE the room's scroller, not a sticky element
    // inside it (`RoomSurfaceProps.aboveTimeline` explains why that placement
    // is the whole point). `shrink-0` is what that placement needs: without it
    // a flex row this tall is compressed by the feed beside it.
    expect(header()?.className).toContain('shrink-0');
    expect(header()?.className).not.toContain('sticky');
  });

  it('shows an approval waiting on a decision', async () => {
    renderHeader({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
    });

    expect(await screen.findByText('Waiting On You')).toBeInTheDocument();
    expect(screen.getByText('Uninstall a marketplace package')).toBeInTheDocument();
  });

  it('answers an approval in place: the card retires, the header shrinks, the page stays put', async () => {
    const listPendingApprovals = vi.fn().mockResolvedValue({ approvals: [buildApproval()] });
    // Held open on purpose. The point of the checkmark is that it lands BEFORE
    // the server answers, and a mock that resolves instantly cannot tell that
    // apart from one that lands after — the refetch would race the assertion.
    let settle: () => void = () => {};
    const grantApproval = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = () =>
            resolve({ ok: true, approvalId: '01JZ0000000000000000000001', outcome: 'granted' });
        })
    );
    const { router } = renderHeader({ listPendingApprovals, grantApproval });

    await screen.findByText('Uninstall a marketplace package');

    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));

    expect(grantApproval).toHaveBeenCalledWith('01JZ0000000000000000000001', undefined);
    // Confirmed on the card while the request is still in flight.
    expect(await screen.findByText('Allowed')).toBeInTheDocument();

    listPendingApprovals.mockResolvedValue({ approvals: [] });
    settle();
    await waitFor(() => expect(document.querySelector('[data-slot="approval-card"]')).toBeNull());
    // The last thing waiting was answered, so the header goes with it.
    await waitFor(() => expect(header()).toBeNull());
    // Answering is not navigating: the feed underneath must not move.
    expect(router.state.location.pathname).toBe('/');
  });

  it('says so when the approval list cannot be read, rather than looking like silence', async () => {
    // A failed read and "nothing waiting" are the same empty space on screen,
    // and the difference is an agent blocked while nobody knows to answer it.
    renderHeader({ listPendingApprovals: vi.fn().mockRejectedValue(new Error('offline')) });

    expect(
      await screen.findByText(/could not check whether anything is waiting/i)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('re-reads the approval list when Try again is clicked', async () => {
    const listPendingApprovals = vi.fn().mockRejectedValue(new Error('offline'));
    renderHeader({ listPendingApprovals });

    const button = await screen.findByRole('button', { name: 'Try again' });
    listPendingApprovals.mockResolvedValue({ approvals: [buildApproval()] });
    await userEvent.click(button);

    expect(await screen.findByText('Uninstall a marketplace package')).toBeInTheDocument();
  });

  it('shows what recently went wrong, under its own quiet heading', async () => {
    // Agents nobody can reach is not a thing WAITING on a person — nothing is
    // blocked on an answer — so it draws under Recent Activity rather than
    // spending the header's amber on it.
    renderHeader({
      listNotifications: notificationsByLens({ activity: offlineAgents('tangerines') }),
    });

    expect(await screen.findByText('Recent Activity')).toBeInTheDocument();
    expect(screen.getByText('tangerines stopped answering')).toBeInTheDocument();
    expect(screen.queryByText('Needs Attention')).not.toBeInTheDocument();
  });

  it('keeps the activity row deep link, and opens the sheet it addresses', async () => {
    const { router } = renderHeader({
      listNotifications: notificationsByLens({ activity: offlineAgents('tangerines') }),
    });

    // The row IS the button now — clicking it marks the notification read and
    // travels, where the old row carried a separate "View →".
    await userEvent.click(await screen.findByText('tangerines stopped answering'));

    await waitFor(() =>
      expect(router.state.location.search).toEqual(
        expect.objectContaining({ detail: 'offline-agent', itemId: 'tangerines' })
      )
    );
    expect(await screen.findByText('Offline Agents')).toBeInTheDocument();
  });

  it('draws both groups at once when both have something to say', async () => {
    renderHeader({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
      listNotifications: notificationsByLens({ activity: offlineAgents('tangerines') }),
    });

    expect(await screen.findByText('Waiting On You')).toBeInTheDocument();
    expect(await screen.findByText('Recent Activity')).toBeInTheDocument();
    expect(header()).not.toBeNull();
  });

  it('puts a schedule an agent parked under Waiting On You, as a card with all three answers', async () => {
    // The event that most deserved a signal and had none: an agent proposes a
    // scheduled run, it parks because nothing arms itself, and until now the
    // only way to find it was to wander into the Tasks page.
    //
    // It sits in Waiting On You rather than Needs Attention since DOR-1398: a
    // proposal IS a decision waiting on a person, and the group below is a
    // dense row box built for things that already broke. Seeded defect: put the
    // card back under `showsAttention` and the group heading assertion reds.
    renderHeader({ listTasks: vi.fn().mockResolvedValue([parkedSchedule()]) });

    expect(await screen.findByText('Waiting On You')).toBeInTheDocument();
    expect(screen.queryByText('Needs Attention')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve Nightly sweep' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject Nightly sweep' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run Nightly sweep once' })).toBeInTheDocument();
    expect(screen.getByText(/At 03:00 AM/i)).toBeInTheDocument();
  });

  it('says nothing about a schedule that is already running', async () => {
    // The discriminating half: without the `pending_approval` filter, every
    // schedule anybody ever made would pile into the header.
    const { transport } = renderHeader({
      listTasks: vi.fn().mockResolvedValue([parkedSchedule({ status: 'active', enabled: true })]),
    });

    await waitFor(() => expect(transport.listTasks).toHaveBeenCalled());
    await waitFor(() => expect(transport.listNotifications).toHaveBeenCalled());
    expect(screen.queryByText('Waiting On You')).not.toBeInTheDocument();
    expect(screen.queryByText('Needs Attention')).not.toBeInTheDocument();
  });

  it('approves a parked schedule in place', async () => {
    const updateTask = vi.fn().mockResolvedValue(parkedSchedule({ status: 'active' }));
    renderHeader({ listTasks: vi.fn().mockResolvedValue([parkedSchedule()]), updateTask });

    await userEvent.click(await screen.findByRole('button', { name: 'Approve Nightly sweep' }));

    // The Tasks page's own mutation, unchanged: arming it is a status AND an
    // enabled flag, and sending only one of them leaves a schedule that is
    // approved but never fires.
    expect(updateTask).toHaveBeenCalledWith('task-1', { status: 'active', enabled: true });
  });

  it('rejects a parked schedule into a receipt, sending no delete yet', async () => {
    // Rejecting DELETES a schedule, and a delete has no server-side undo — so
    // the card offers the undo by simply not sending the request yet. What this
    // pins is that the header's copy of the card is wired to that machinery at
    // all: a rejection here produces a receipt and a live offer rather than an
    // immediate, irreversible DELETE. The clock-crossing half (the delete DOES
    // fire when the window closes, and Undo stops it) is proven against the
    // scheduler itself, in `deferred-rejection.test.ts`, where the timers are
    // fake from the first line.
    const deleteTask = vi.fn().mockResolvedValue(undefined);
    renderHeader({ listTasks: vi.fn().mockResolvedValue([parkedSchedule()]), deleteTask });

    await userEvent.click(await screen.findByRole('button', { name: 'Reject Nightly sweep' }));

    expect(await screen.findByText('Rejected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(deleteTask).not.toHaveBeenCalled();
  });

  it('puts the answers back when a rejection is undone', async () => {
    const deleteTask = vi.fn().mockResolvedValue(undefined);
    renderHeader({ listTasks: vi.fn().mockResolvedValue([parkedSchedule()]), deleteTask });

    await userEvent.click(await screen.findByRole('button', { name: 'Reject Nightly sweep' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));

    // Answerable again, and still nothing sent — an undo that left the card
    // saying "Rejected" would be a button that did nothing.
    expect(await screen.findByRole('button', { name: 'Reject Nightly sweep' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve Nightly sweep' })).toBeInTheDocument();
    expect(deleteTask).not.toHaveBeenCalled();
  });

  it('draws an agent waiting on you ONCE — the card, never a second row below it', async () => {
    // Both sessions raise a signal from the one engine: `blocked` becomes a
    // permission prompt, `error` becomes a wedge. Only the wedge belongs in
    // Needs Attention — a blocked agent already has a card in Waiting On You,
    // and the same fact twice in one header is how a person learns to read
    // neither. Seeded defect: pass every blocking kind through and there are
    // two rows here instead of one.
    renderHeader({
      listRecentSessions: vi.fn().mockResolvedValue({
        sessions: [
          sessionRow('ses-blocked', 'Ship the parser'),
          sessionRow('ses-wedged', 'Wedged'),
        ],
        agentActivity: {},
      }),
    });
    setLifecycles({ 'ses-blocked': 'blocked', 'ses-wedged': 'error' });

    expect(await screen.findByText('Needs Attention')).toBeInTheDocument();
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="attention-signal-row"]')).toHaveLength(1)
    );
    expect(document.querySelector('[data-slot="attention-signal-row"]')?.textContent).toContain(
      'Stopped with an error'
    );
  });

  it('keeps the group open while an answered prompt is still saying how it ended', async () => {
    // Answering the LAST thing waiting used to unmount the group around its own
    // receipt — the card was gone inside a second with nothing said. Seeded
    // defect: drop `settlingAsks` from `showsWaiting` and the group vanishes
    // even though a receipt is on screen.
    const settling = [
      {
        sessionId: 'session-1',
        cwd: '/projects/meeting-notes',
        interaction: {
          type: 'approval' as const,
          id: 'tc-settling',
          startedAt: Date.now(),
          remainingMs: 600_000,
          timeoutMs: 600_000,
          toolName: 'Write',
          input: '{}',
          hasSuggestions: false,
        },
      },
    ];

    // The list answers through the transport, so the view needs the same
    // providers the app gives it.
    const transport = createMockTransport();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <PinnedTriageHeaderView
            asks={[]}
            settlingAsks={settling}
            askAgentNames={{}}
            onOpenSession={() => {}}
            approvals={[]}
            approvalsUnavailable={false}
            onRetryApprovals={() => {}}
            scheduleApprovals={[]}
            errorSignals={[]}
            activityItems={[]}
            onOpenActivity={() => {}}
          />
        </TransportProvider>
      </QueryClientProvider>
    );

    expect(screen.getByText('Waiting On You')).toBeInTheDocument();
  });

  describe('the daily Shift Report card', () => {
    it('renders above Recent Activity from a seeded unread row', async () => {
      renderHeader({
        listNotifications: notificationsByLens({
          report: [shiftReportRow()],
        }),
      });

      const card = await screen.findByText(/While you were away/);
      expect(card).toBeInTheDocument();
      expect(header()).not.toBeNull();
    });

    it('keeps the header on screen for the card alone, with no other group drawn', async () => {
      // Nothing is waiting and nothing broke — the one thing this header has to
      // say is what agents did overnight, and it must not need a second reason
      // to stay on screen.
      renderHeader({
        listNotifications: notificationsByLens({ report: [shiftReportRow()] }),
      });

      await screen.findByText(/While you were away/);
      expect(header()).not.toBeNull();
      expect(screen.queryByText('Waiting On You')).not.toBeInTheDocument();
      expect(screen.queryByText('Needs Attention')).not.toBeInTheDocument();
      expect(screen.queryByText('Recent Activity')).not.toBeInTheDocument();
    });

    it('is absent when there is nothing unread to report', async () => {
      const { transport } = renderHeader({
        listNotifications: notificationsByLens({ report: [] }),
      });

      await waitFor(() => expect(transport.listNotifications).toHaveBeenCalled());
      expect(screen.queryByText(/While you were away/)).not.toBeInTheDocument();
      expect(header()).toBeNull();
    });

    it('dismissing the card marks it read, and it disappears', async () => {
      const markNotificationRead = vi
        .fn()
        .mockResolvedValue({ ok: true, marked: 1, unreadCount: 0 });
      renderHeader({
        listNotifications: notificationsByLens({ report: [shiftReportRow()] }),
        markNotificationRead,
      });

      await screen.findByText(/While you were away/);
      await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

      expect(markNotificationRead).toHaveBeenCalledWith(shiftReportRow().id);
      // The optimistic cache write is what makes it vanish — the mock above
      // still answers the same unread row if re-fetched, so a card that
      // survives this proves the dismiss reads it rather than merely calling
      // the mutation.
      await waitFor(() =>
        expect(screen.queryByText(/While you were away/)).not.toBeInTheDocument()
      );
    });
  });
});
