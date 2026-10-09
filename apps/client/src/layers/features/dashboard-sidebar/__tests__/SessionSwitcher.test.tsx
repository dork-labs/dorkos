/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Session } from '@dorkos/shared/types';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { useSessionListStore } from '@/layers/entities/session';
import { CHAT_LIST_ROW_SLOT, CHAT_LIST_SLOT } from '@/layers/features/chat-list';
import { SessionSwitcher } from '../ui/SessionSwitcher';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// `useAgentSessions` reaches `useSessionId`, which reads the URL. Standing up a
// whole RouterProvider for a dialog buys nothing; what the switcher needs from
// the router is one value — which session is open — so that is what is stubbed.
let mockSearch: Record<string, unknown> = {};
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  // Present, because these cases render inside a routed cockpit. The safe-router
  // wrappers ask before reading route state (DOR-1444).
  useRouter: () => ({ stores: {} }),
  useSearch: () => mockSearch,
  useNavigate: () => vi.fn(),
  useRouterState: () => '/session',
}));

let mockIsMobile = false;
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useIsMobile: () => mockIsMobile };
});

// The fleet-wide prompt list rides the app's event stream, which a dialog test
// has no reason to stand up.
vi.mock('@/layers/entities/attention', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/attention')>()),
  usePendingInteractions: () => ({ interactions: [], isLoading: false, isError: false }),
}));

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
  return Array.from(document.querySelectorAll<HTMLElement>(`[data-slot="${CHAT_LIST_ROW_SLOT}"]`));
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

/**
 * The surface only. What the list inside it shows, and the keys it answers, are
 * `features/chat-list`'s tests: the switcher draws that same component.
 */
describe('SessionSwitcher', () => {
  it('draws the shared chat list under a heading naming the agent', async () => {
    renderSwitcher([session('a', 'Review feedback options')]);
    await findRow('Review feedback options');
    expect(screen.getByRole('heading', { name: /Chats with DorkOS/ })).toBeInTheDocument();
    expect(document.querySelector(`[data-slot="${CHAT_LIST_SLOT}"]`)).not.toBeNull();
  });

  it('opening a chat opens it and closes the surface', async () => {
    const { onSelectSession, onOpenChange } = renderSwitcher([
      session('recent-1', 'Review feedback options'),
    ]);
    const row = await findRow('Review feedback options');
    row.focus();
    await userEvent.keyboard('{Enter}');
    expect(onSelectSession).toHaveBeenCalledWith('recent-1');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('New chat starts one and closes the surface', async () => {
    const { onNewSession, onOpenChange } = renderSwitcher([session('a', 'One')]);
    await findRow('One');
    await userEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(onNewSession).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('puts focus on a row when it opens, so ↵ works straight away', async () => {
    renderSwitcher([session('a', 'One')]);
    const row = await findRow('One');
    await waitFor(() => expect(document.activeElement).toBe(row));
  });

  it('names all three keys in its footer', async () => {
    renderSwitcher([session('recent-1', 'Review feedback options')]);
    await findRow('Review feedback options');
    const footer = document.querySelector('footer')!;
    expect(footer).toHaveTextContent('↵ open');
    expect(footer).toHaveTextContent('⌘↵ new chat');
    expect(footer).toHaveTextContent('⇧↵ fork');
  });

  it('drops the key legend on a phone, where New chat is the button at the top', async () => {
    // The legend names keys, and a phone has none: `Kbd` hides itself there, so
    // a legend left in would read "open new chat fork".
    mockIsMobile = true;
    renderSwitcher([session('recent-1', 'Review feedback options')]);
    await findRow('Review feedback options');
    expect(document.querySelector('footer')).toBeNull();
    expect(screen.getByRole('button', { name: 'New chat' })).toBeInTheDocument();
  });

  it('asks for nothing while closed', () => {
    mockTransport.listSessions = vi.fn().mockResolvedValue({ sessions: [] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={mockTransport}>
          <SessionSwitcher
            agentPath={AGENT_PATH}
            agentName="DorkOS"
            agentVisual={{ color: '#6366f1', emoji: '🐙' }}
            open={false}
            onOpenChange={vi.fn()}
            onSelectSession={vi.fn()}
            onNewSession={vi.fn()}
          />
        </TransportProvider>
      </QueryClientProvider>
    );
    expect(mockTransport.listSessions).not.toHaveBeenCalled();
  });
});
