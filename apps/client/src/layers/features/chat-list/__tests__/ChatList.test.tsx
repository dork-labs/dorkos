/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockSessionLimit, createMockTransport } from '@dorkos/test-utils';
import type { Session } from '@dorkos/shared/types';
import type { SessionActivity, SessionStatus } from '@dorkos/shared/session-stream';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { useSessionListStore } from '@/layers/entities/session';
import { ChatList, CHAT_LIST_ROW_SLOT } from '../index';

// `useAgentSessions` reaches `useSessionId`, which reads the URL. What the list
// needs from the router is one value, which chat is open, so that is stubbed.
let mockSearch: Record<string, unknown> = {};
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useRouter: () => ({ stores: {} }),
  useSearch: () => mockSearch,
  useNavigate: () => vi.fn(),
  useRouterState: () => '/session',
}));

// The fleet-wide prompt list rides the app's event stream; what the list reads
// from it is which chats have a prompt waiting, so that is what is stubbed.
let mockWaiting: { sessionId: string }[] = [];
vi.mock('@/layers/entities/attention', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/attention')>()),
  usePendingInteractions: () => ({ interactions: mockWaiting, isLoading: false, isError: false }),
}));

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
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.setPointerCapture = vi.fn();
});

const AGENT_PATH = '/agents/dorkos';
const HOUR = 60 * 60 * 1000;

/** An ISO time `hours` before now. */
function ago(hours: number): string {
  return new Date(Date.now() - hours * HOUR).toISOString();
}

function chat(id: string, title: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    title,
    createdAt: ago(48),
    updatedAt: ago(24),
    permissionMode: 'default',
    runtime: 'claude-code',
    cwd: AGENT_PATH,
    ...overrides,
  };
}

function spinOffOf(parentId: string, id: string, title: string, extra: Partial<Session> = {}) {
  return chat(id, title, {
    origin: 'agent',
    startedBy: { kind: 'chat', sessionId: parentId, title: null, reason: null, permission: null },
    ...extra,
  });
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
    limit: null,
    accountUsage: null,
    ...overrides,
  };
}

function setLifecycle(
  sessionId: string,
  lifecycle: SessionStatus['lifecycle'],
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

function renderList(
  sessions: Session[],
  props: Partial<React.ComponentProps<typeof ChatList>> = {}
) {
  mockTransport.listSessions = vi.fn().mockResolvedValue({ sessions });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOpenChat = props.onOpenChat ?? vi.fn();
  const onNewChat = props.onNewChat ?? vi.fn();
  const result = render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={mockTransport}>
        <TooltipProvider>
          <ChatList
            agentPath={AGENT_PATH}
            agentName="DorkOS"
            {...props}
            onOpenChat={onOpenChat}
            onNewChat={onNewChat}
          />
        </TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
  return { ...result, onOpenChat, onNewChat };
}

/** Every chat row on screen, in DOM order. */
function rows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`[data-slot="${CHAT_LIST_ROW_SLOT}"]`));
}

function rowTitles(): string[] {
  return rows().map((r) => r.querySelector('[data-slot="sidebar-row-title"]')?.textContent ?? '');
}

async function findRow(title: string): Promise<HTMLElement> {
  return await waitFor(() => {
    const match = rows().find((r) => r.textContent?.includes(title));
    if (match === undefined) throw new Error(`no row titled ${title}`);
    return match;
  });
}

function headings(): string[] {
  return Array.from(document.querySelectorAll('h3')).map((h) => h.textContent ?? '');
}

beforeEach(() => {
  mockSearch = {};
  useSessionListStore.setState({ sessions: {}, statuses: {}, statusCwds: {}, unseen: {} });
  mockWaiting = [];
  vi.clearAllMocks();
});

afterEach(cleanup);

describe('ChatList', () => {
  it('lists needs you, then running, then the rest by when you last used them', async () => {
    renderList([
      chat('old', 'Old notes', { lastTouchedByYouAt: ago(30) }),
      chat('fresh', 'Fresh plan', { lastTouchedByYouAt: ago(1) }),
      chat('busy', 'Busy build'),
      chat('stuck', 'Stuck deploy'),
    ]);
    setLifecycle('busy', 'streaming');
    setLifecycle('stuck', 'blocked');

    await findRow('Old notes');
    await waitFor(() => expect(headings()).toEqual(['Needs you', 'Running', 'Other chats']));
    expect(rowTitles()).toEqual(['Stuck deploy', 'Busy build', 'Fresh plan', 'Old notes']);
  });

  it('says why a row needs you, and gives a running row its live verb', async () => {
    renderList([chat('busy', 'Busy build'), chat('stuck', 'Stuck deploy'), chat('broke', 'Broke')]);
    setLifecycle('busy', 'streaming', {
      kind: 'tool',
      toolName: 'Edit',
      target: 'auth.ts',
    } as SessionActivity);
    setLifecycle('stuck', 'blocked');
    setLifecycle('broke', 'error');

    expect(await findRow('Stuck deploy')).toHaveTextContent('Needs you');
    expect(await findRow('Broke')).toHaveTextContent('Stopped with an error');
    const busy = await findRow('Busy build');
    await waitFor(() =>
      expect(busy.querySelector('[data-slot="chat-list-verb"]')?.textContent).not.toBe('')
    );
    expect(busy.querySelector('[data-status="running"]')).not.toBeNull();
  });

  it('lifts a chat whose account ran out, and leaves one you chose to let wait', async () => {
    renderList([
      chat('a', 'Ran out', { status: { lifecycle: 'idle', limit: createMockSessionLimit('ask') } }),
      chat('b', 'Waiting for reset', {
        lastTouchedByYouAt: ago(1),
        status: { lifecycle: 'idle', limit: createMockSessionLimit('waiting') },
      }),
    ]);
    const out = await findRow('Ran out');
    expect(out).toHaveTextContent('Out of usage');
    expect(headings()[0]).toBe('Needs you');
    expect(rowTitles()).toEqual(['Ran out', 'Waiting for reset']);
    expect(await findRow('Waiting for reset')).not.toHaveTextContent('Out of usage');
  });

  it('counts a waiting question from the fleet-wide list as needs you', async () => {
    mockWaiting = [{ sessionId: 'b' }];
    renderList([chat('a', 'Quiet'), chat('b', 'Asked')]);
    expect(await findRow('Asked')).toHaveTextContent('Needs you');
    expect(headings()[0]).toBe('Needs you');
  });

  it('shows when you last used a chat, and nothing for one you never did', async () => {
    renderList([
      chat('a', 'Used', { lastTouchedByYouAt: ago(2) }),
      chat('b', 'Never', { origin: 'task' }),
    ]);
    const used = await findRow('Used');
    expect(used.querySelector('[data-slot="chat-list-last-used"]')).toHaveTextContent('You · 2h');
    await userEvent.click(screen.getByRole('button', { name: /Automated/ }));
    const never = await findRow('Never');
    expect(never.querySelector('[data-slot="chat-list-last-used"]')).toBeNull();
  });

  it('marks the runtime only when the list mixes them', async () => {
    const { unmount } = renderList([chat('a', 'One'), chat('b', 'Two')]);
    await findRow('One');
    expect(screen.queryByLabelText(/^Runs on/)).toBeNull();
    unmount();

    renderList([chat('a', 'One'), chat('b', 'Two', { runtime: 'codex' })]);
    await findRow('Two');
    expect(screen.getAllByLabelText(/^Runs on/)).toHaveLength(2);
  });

  it('marks a chat a room or a schedule started with its origin', async () => {
    renderList([
      chat('a', 'From the room', {
        origin: 'room',
        originLabel: '#launch',
        lastTouchedByYouAt: ago(1),
      }),
    ]);
    const row = await findRow('From the room');
    expect(within(row).getByLabelText('Origin: #launch')).toBeInTheDocument();
  });

  it('draws no origin mark for a spin-off: its second line already says where it started', async () => {
    renderList([
      chat('p', 'Plan', { lastTouchedByYouAt: ago(1) }),
      spinOffOf('p', 's', 'Opened spin-off', { lastTouchedByYouAt: ago(2) }),
    ]);
    const row = await findRow('Opened spin-off');
    expect(row).toHaveTextContent('Started from Plan');
    expect(within(row).queryByLabelText(/^Origin:/)).toBeNull();
  });

  it('tags the chat open right now', async () => {
    mockSearch = { session: 'b' };
    renderList([chat('a', 'Other'), chat('b', 'Open one')]);
    const open = await findRow('Open one');
    expect(open.querySelector('[data-slot="chat-list-current"]')).not.toBeNull();
    expect((await findRow('Other')).querySelector('[data-slot="chat-list-current"]')).toBeNull();
  });

  describe('folding', () => {
    it('folds spin-offs under a closed toggle that opens to show their status', async () => {
      renderList([
        chat('p', 'Plan launch', { lastTouchedByYouAt: ago(1) }),
        spinOffOf('p', 's1', 'Draft copy'),
        spinOffOf('p', 's2', 'Check links', { updatedAt: ago(2) }),
      ]);
      setLifecycle('s2', 'streaming');
      await findRow('Plan launch');
      expect(rowTitles()).toEqual(['Plan launch']);

      const toggle = screen.getByRole('button', { name: '2 spin-offs from Plan launch' });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await userEvent.click(toggle);
      expect(rowTitles()).toEqual(['Plan launch', 'Check links', 'Draft copy']);
      expect(await findRow('Check links')).toHaveTextContent('Running');
      expect(await findRow('Draft copy')).toHaveTextContent('Done');
    });

    it('lifts a spin-off that needs you to the top, saying where it started', async () => {
      renderList([
        chat('p', 'Plan launch', { lastTouchedByYouAt: ago(1) }),
        spinOffOf('p', 's1', 'Draft copy'),
      ]);
      setLifecycle('s1', 'blocked');
      const lifted = await findRow('Draft copy');
      expect(rowTitles()).toEqual(['Draft copy', 'Plan launch']);
      expect(lifted).toHaveTextContent('Started from Plan launch');
      expect(screen.queryByRole('button', { name: /spin-off/ })).toBeNull();
    });

    it('keeps automated chats in one closed group with a count', async () => {
      renderList([
        chat('a', 'Mine', { lastTouchedByYouAt: ago(1) }),
        chat('t1', 'Daily digest', { origin: 'task' }),
        chat('t2', 'Room turn', { origin: 'room' }),
      ]);
      await findRow('Mine');
      const toggle = screen.getByRole('button', { name: /Automated/ });
      expect(toggle).toHaveTextContent('Automated2');
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(rowTitles()).toEqual(['Mine']);
      await userEvent.click(toggle);
      expect(rowTitles()).toEqual(['Mine', 'Daily digest', 'Room turn']);
    });
  });

  describe('sorting', () => {
    it('re-sorts by recent activity and by when chats started', async () => {
      renderList([
        chat('a', 'Started first', {
          createdAt: ago(50),
          updatedAt: ago(1),
          lastTouchedByYouAt: ago(40),
        }),
        chat('b', 'Started last', {
          createdAt: ago(5),
          updatedAt: ago(4),
          lastTouchedByYouAt: ago(3),
        }),
      ]);
      await findRow('Started first');
      expect(rowTitles()).toEqual(['Started last', 'Started first']);

      await userEvent.click(screen.getByRole('radio', { name: 'Recent activity' }));
      expect(rowTitles()).toEqual(['Started first', 'Started last']);

      await userEvent.click(screen.getByRole('radio', { name: 'Started' }));
      expect(rowTitles()).toEqual(['Started last', 'Started first']);
    });
  });

  describe('keys and actions', () => {
    it('New chat starts a chat', async () => {
      const { onNewChat } = renderList([chat('a', 'One')]);
      await findRow('One');
      await userEvent.click(screen.getByRole('button', { name: 'New chat' }));
      expect(onNewChat).toHaveBeenCalledTimes(1);
    });

    it('↵ on a row opens that chat', async () => {
      const { onOpenChat } = renderList([chat('a', 'One')]);
      (await findRow('One')).focus();
      await userEvent.keyboard('{Enter}');
      expect(onOpenChat).toHaveBeenCalledWith('a');
    });

    it('⌘↵ starts a new chat instead of opening the focused one', async () => {
      const { onOpenChat, onNewChat } = renderList([chat('a', 'One')]);
      (await findRow('One')).focus();
      await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
      expect(onNewChat).toHaveBeenCalledTimes(1);
      expect(onOpenChat).not.toHaveBeenCalled();
    });

    it('L-05: ⇧↵ forks the focused chat and opens the fork', async () => {
      mockTransport.forkSession = vi.fn().mockResolvedValue(chat('forked', 'Fork'));
      const { onOpenChat } = renderList([chat('a', 'One')]);
      (await findRow('One')).focus();
      await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
      await waitFor(() =>
        expect(mockTransport.forkSession).toHaveBeenCalledWith('a', undefined, AGENT_PATH)
      );
      await waitFor(() => expect(onOpenChat).toHaveBeenCalledWith('forked'));
      expect(onOpenChat).toHaveBeenCalledTimes(1);
    });

    it('↑ and ↓ walk the rows and the toggles', async () => {
      renderList([
        chat('a', 'First', { lastTouchedByYouAt: ago(1) }),
        chat('b', 'Second', { lastTouchedByYouAt: ago(2) }),
        chat('t', 'Scheduled', { origin: 'task' }),
      ]);
      const first = await findRow('First');
      first.focus();
      await userEvent.keyboard('{ArrowDown}');
      expect(document.activeElement).toBe(await findRow('Second'));
      await userEvent.keyboard('{ArrowDown}');
      expect(document.activeElement).toBe(screen.getByRole('button', { name: /Automated/ }));
      await userEvent.keyboard('{ArrowUp}{ArrowUp}');
      expect(document.activeElement).toBe(first);
    });

    it('offers rename and fork from the row menu', async () => {
      mockTransport.updateSession = vi.fn().mockResolvedValue(chat('a', 'Renamed'));
      renderList([chat('a', 'One')]);
      await findRow('One');
      await userEvent.click(screen.getByRole('button', { name: 'One actions' }));
      expect(await screen.findByRole('menuitem', { name: /Fork/ })).toBeInTheDocument();
      await userEvent.click(screen.getByRole('menuitem', { name: /Rename/ }));
      const field = await screen.findByRole('textbox', { name: 'Rename One' });
      await userEvent.clear(field);
      await userEvent.type(field, 'Renamed{Enter}');
      await waitFor(() =>
        expect(mockTransport.updateSession).toHaveBeenCalledWith(
          'a',
          { title: 'Renamed' },
          AGENT_PATH
        )
      );
    });
  });

  describe('search', () => {
    it('filters by title when searchable, and says when nothing matches', async () => {
      renderList([chat('a', 'Plan launch'), chat('b', 'Fix login')], { searchable: true });
      await findRow('Plan launch');
      await userEvent.type(screen.getByRole('textbox', { name: 'Search chats' }), 'login');
      expect(rowTitles()).toEqual(['Fix login']);
      await userEvent.type(screen.getByRole('textbox', { name: 'Search chats' }), 'zzz');
      expect(screen.getByText('No chat matches “loginzzz”.')).toBeInTheDocument();
    });

    it('has no search field unless asked', async () => {
      renderList([chat('a', 'Plan launch')]);
      await findRow('Plan launch');
      expect(screen.queryByRole('textbox', { name: 'Search chats' })).toBeNull();
    });
  });

  it('says so when the agent has no chats, and still offers New chat', async () => {
    renderList([]);
    expect(await screen.findByText('No chats with DorkOS yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New chat' })).toBeInTheDocument();
    expect(rows()).toHaveLength(0);
  });

  it('says it could not read the chats rather than that there are none', async () => {
    mockTransport.listSessions = vi.fn().mockRejectedValue(new Error('down'));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={mockTransport}>
          <ChatList
            agentPath={AGENT_PATH}
            agentName="DorkOS"
            onOpenChat={vi.fn()}
            onNewChat={vi.fn()}
          />
        </TransportProvider>
      </QueryClientProvider>
    );
    expect(await screen.findByText('Couldn’t read DorkOS’s chats.')).toBeInTheDocument();
  });
});
