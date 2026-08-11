/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Session } from '@dorkos/shared/types';
import type { SessionActivity, SessionStatus } from '@dorkos/shared/session-stream';
import { TransportProvider } from '@/layers/shared/model';
import { ORIGIN_GLYPH, TooltipProvider } from '@/layers/shared/ui';
import { useSessionListStore } from '@/layers/entities/session';
import { SessionSwitcher, SWITCHER_ROW_SLOT } from '../ui/SessionSwitcher';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// `useAgentSessions` reaches `useSessionId`, which reads the URL. Standing up a
// whole RouterProvider for a dialog buys nothing; what the switcher needs from
// the router is one value — which session is open — so that is what is stubbed.
let mockSearch: Record<string, unknown> = {};
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => mockSearch,
  useNavigate: () => vi.fn(),
  useRouterState: () => '/session',
}));

let mockIsMobile = false;
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useIsMobile: () => mockIsMobile };
});

vi.mock('@/layers/entities/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/agent')>();
  return {
    ...actual,
    AgentAvatar: ({ emoji }: { emoji: string }) => <span data-testid="agent-avatar">{emoji}</span>,
  };
});

// ---------------------------------------------------------------------------
// Browser API mocks
// ---------------------------------------------------------------------------

beforeAll(() => {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
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
  // vaul (the mobile drawer half of `ResponsiveDialog`) and Radix both reach for
  // these; jsdom has neither.
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.setPointerCapture = vi.fn();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AGENT_PATH = '/agents/dorkos';

function session(id: string, title: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    title,
    createdAt: '2026-08-09T10:00:00.000Z',
    updatedAt: '2026-08-09T10:00:00.000Z',
    permissionMode: 'default',
    runtime: 'claude-code',
    cwd: AGENT_PATH,
    ...overrides,
  };
}

function status(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return {
    contextUsage: null,
    cost: null,
    usage: null,
    cacheStats: null,
    model: null,
    permissionMode: 'default',
    todoCounts: null,
    runningSubagentCount: 0,
    lifecycle: 'idle',
    lastError: null,
    ...overrides,
  };
}

/** Put a session into the live fan-out the switcher reads lifecycle and verbs off. */
function goLive(
  sessionId: string,
  lifecycle: 'streaming' | 'blocked',
  activity?: SessionActivity
): void {
  useSessionListStore
    .getState()
    .setSessionStatus(
      sessionId,
      status(activity === undefined ? { lifecycle } : { lifecycle, activity }),
      AGENT_PATH
    );
}

const mockTransport = createMockTransport();

function renderSwitcher(
  sessions: Session[],
  props: Partial<React.ComponentProps<typeof SessionSwitcher>> = {}
) {
  mockTransport.listSessions = vi.fn().mockResolvedValue({ sessions });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSelectSession = props.onSelectSession ?? vi.fn();
  const onNewSession = props.onNewSession ?? vi.fn();
  const onOpenChange = props.onOpenChange ?? vi.fn();
  const result = render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={mockTransport}>
        <TooltipProvider>
          <SessionSwitcher
            agentPath={AGENT_PATH}
            agentName="DorkOS"
            agentVisual={{ color: '#6366f1', emoji: '🐙' }}
            open
            onOpenChange={onOpenChange}
            onSelectSession={onSelectSession}
            onNewSession={onNewSession}
          />
        </TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
  return { ...result, onSelectSession, onNewSession, onOpenChange, queryClient };
}

/** Every session row on screen, in DOM order — which is group order. */
function rows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`[data-slot="${SWITCHER_ROW_SLOT}"]`));
}

/** The group headings on screen, in DOM order. */
function groupHeadings(): string[] {
  return Array.from(document.querySelectorAll('h3')).map((h) => h.textContent ?? '');
}

async function findRow(title: string): Promise<HTMLElement> {
  return await waitFor(() => {
    const match = rows().find((r) => r.textContent?.includes(title));
    if (match === undefined) throw new Error(`no row titled ${title}`);
    return match;
  });
}

beforeEach(() => {
  mockSearch = {};
  mockIsMobile = false;
  useSessionListStore.setState({ sessions: {}, statuses: {}, statusCwds: {}, unseen: {} });
  vi.clearAllMocks();
});

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionSwitcher', () => {
  it('renders the three groups in order: Live now, Recent, Automated', async () => {
    goLive('live-1', 'streaming');
    renderSwitcher([
      session('live-1', 'Dashboard overhaul'),
      session('recent-1', 'Review feedback options'),
      session('auto-1', 'Nightly sweep', { origin: 'task' }),
    ]);

    await findRow('Dashboard overhaul');
    expect(groupHeadings()).toEqual(['Live now', 'Recent', 'Automated']);
  });

  it('omits a group that has nothing in it', async () => {
    renderSwitcher([session('recent-1', 'Review feedback options')]);

    await findRow('Review feedback options');
    expect(groupHeadings()).toEqual(['Recent']);
  });

  it('gives an agent with three concurrent live sessions three rows, not a rollup', async () => {
    goLive('live-1', 'streaming');
    goLive('live-2', 'streaming');
    goLive('live-3', 'blocked');
    renderSwitcher([
      session('live-1', 'Dashboard overhaul'),
      session('live-2', 'Release notes draft'),
      session('live-3', 'Flaky sidebar spec'),
    ]);

    const liveGroup = await waitFor(() => screen.getByRole('region', { name: 'Live now' }));
    const liveRows = within(liveGroup).getAllByRole('button');
    expect(liveRows).toHaveLength(3);
    expect(liveGroup.textContent).toContain('Dashboard overhaul');
    expect(liveGroup.textContent).toContain('Release notes draft');
    expect(liveGroup.textContent).toContain('Flaky sidebar spec');
    // The failure this guards is a summary line replacing the rows.
    expect(liveGroup.textContent).not.toMatch(/3 sessions|3 live/);
  });

  it('carries each live row its own verb, off the activity fan-out', async () => {
    goLive('live-1', 'streaming', { toolName: 'Edit', target: 'RoomRow.tsx' });
    goLive('live-2', 'blocked');
    renderSwitcher([
      session('live-1', 'Dashboard overhaul'),
      session('live-2', 'Release notes draft'),
    ]);

    const editing = await findRow('Dashboard overhaul');
    expect(editing).toHaveTextContent('RoomRow.tsx');
    expect(await findRow('Release notes draft')).toHaveTextContent('waiting on you');
  });

  it('gives a recent row its one-line outcome and no verb', async () => {
    renderSwitcher([
      session('recent-1', 'Review feedback options', {
        lastMessagePreview: 'Settled on a two-tier submit flow',
      }),
    ]);

    const row = await findRow('Review feedback options');
    expect(row).toHaveTextContent('Settled on a two-tier submit flow');
    expect(row).not.toHaveTextContent('working');
  });

  it('keeps Automated collapsed until it is asked for', async () => {
    renderSwitcher([
      session('recent-1', 'Review feedback options'),
      session('auto-1', 'Nightly sweep', { origin: 'task' }),
      session('auto-2', 'Telegram · Dorian', { origin: 'channel' }),
    ]);

    const reveal = await screen.findByRole('button', { name: '+ 2 automated' });
    expect(reveal).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Nightly sweep')).not.toBeInTheDocument();

    await userEvent.click(reveal);
    expect(screen.getByText('Nightly sweep')).toBeInTheDocument();
    expect(screen.getByText('Telegram · Dorian')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.queryByText('Nightly sweep')).not.toBeInTheDocument();
  });

  it('tags the session that is currently open, and only that one', async () => {
    mockSearch = { session: 'recent-2' };
    renderSwitcher([
      session('recent-1', 'Review feedback options'),
      session('recent-2', 'Fix flaky sidebar test'),
    ]);

    await findRow('Fix flaky sidebar test');
    const tags = document.querySelectorAll('[data-slot="session-switcher-current"]');
    expect(tags).toHaveLength(1);
    expect(tags[0].closest(`[data-slot="${SWITCHER_ROW_SLOT}"]`)).toHaveTextContent(
      'Fix flaky sidebar test'
    );
    expect(tags[0]).toHaveTextContent('current');
  });

  // --- BC-26: origin marks come from the one registry ---

  it('marks an automated row with the glyph the shared registry names for its origin', async () => {
    renderSwitcher([
      session('auto-1', 'Nightly sweep', { origin: 'task' }),
      session('auto-2', 'Telegram · Dorian', { origin: 'channel' }),
    ]);

    await userEvent.click(await screen.findByRole('button', { name: '+ 2 automated' }));

    // The registry's own glyph, rendered here for comparison — so this asserts
    // "the switcher draws what ORIGIN_GLYPH says", not "the switcher draws a
    // calendar". Change the registry and both sides move; stop reading the
    // registry and only one does.
    const reference = render(
      <>
        <ORIGIN_GLYPH.task data-testid="ref-task" />
        <ORIGIN_GLYPH.channel data-testid="ref-channel" />
      </>
    );
    const taskClass = reference.getByTestId('ref-task').getAttribute('class');
    const channelClass = reference.getByTestId('ref-channel').getAttribute('class');
    expect(taskClass).not.toBe(channelClass);

    const taskRow = await findRow('Nightly sweep');
    const channelRow = await findRow('Telegram · Dorian');
    expect(taskRow.querySelector('svg')?.getAttribute('class')).toContain(taskClass);
    expect(channelRow.querySelector('svg')?.getAttribute('class')).toContain(channelClass);
  });

  // --- Footer hints: each key does what it says ---

  it('↵ on a row continues that session and closes the surface', async () => {
    const { onSelectSession, onOpenChange } = renderSwitcher([
      session('recent-1', 'Review feedback options'),
    ]);

    const row = await findRow('Review feedback options');
    row.focus();
    await userEvent.keyboard('{Enter}');
    expect(onSelectSession).toHaveBeenCalledWith('recent-1');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('⌘↵ starts a new session instead of continuing the focused one', async () => {
    const { onSelectSession, onNewSession } = renderSwitcher([
      session('recent-1', 'Review feedback options'),
    ]);

    const row = await findRow('Review feedback options');
    row.focus();
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
    expect(onNewSession).toHaveBeenCalledTimes(1);
    // The whole point of intercepting the keydown: the browser would otherwise
    // have activated the focused button as well.
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it('⇧↵ forks the focused session and lands in the fork', async () => {
    mockTransport.forkSession = vi.fn().mockResolvedValue(session('forked-1', 'Fork'));
    const { onSelectSession } = renderSwitcher([session('recent-1', 'Review feedback options')]);

    const row = await findRow('Review feedback options');
    row.focus();
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
    await waitFor(() =>
      expect(mockTransport.forkSession).toHaveBeenCalledWith('recent-1', undefined, AGENT_PATH)
    );
    await waitFor(() => expect(onSelectSession).toHaveBeenCalledWith('forked-1'));
    // Forking is not continuing: the original must not also have been opened.
    expect(onSelectSession).toHaveBeenCalledTimes(1);
  });

  it('names all three keys in its footer', async () => {
    renderSwitcher([session('recent-1', 'Review feedback options')]);
    await findRow('Review feedback options');
    const footer = document.querySelector('footer')!;
    expect(footer).toHaveTextContent('↵ continue');
    expect(footer).toHaveTextContent('⌘↵ new session');
    expect(footer).toHaveTextContent('⇧↵ fork');
    // The desktop surface offers the keys and nothing else — the button below
    // is the phone's stand-in for them, not a second copy of the same action.
    expect(screen.queryByRole('button', { name: 'New session' })).not.toBeInTheDocument();
  });

  it('trades the key legend for a real button on a phone', async () => {
    // A browser caught this: `Kbd` is `hidden md:inline-flex`, so on a phone the
    // legend kept its three verbs and lost its three glyphs — a footer reading
    // "continue new session fork". The legend names keys; a phone has none.
    mockIsMobile = true;
    const { onNewSession } = renderSwitcher([session('recent-1', 'Review feedback options')]);
    await findRow('Review feedback options');

    expect(document.querySelector('footer')).toBeNull();
    const newSession = screen.getByRole('button', { name: 'New session' });
    await userEvent.click(newSession);
    expect(onNewSession).toHaveBeenCalledTimes(1);
  });

  // --- Nothing to show ---

  it('says so, and points at the key that fixes it, when the agent has no sessions', async () => {
    renderSwitcher([]);
    expect(await screen.findByText(/No conversations yet/)).toBeInTheDocument();
    expect(rows()).toHaveLength(0);
  });
});
