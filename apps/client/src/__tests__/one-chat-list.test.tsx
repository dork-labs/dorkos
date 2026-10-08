/**
 * @vitest-environment jsdom
 *
 * Profile → Sessions and Switch session draw the SAME chat list (spec
 * `your-activity-first` D11, the ticket's done-means for DOR-2789).
 *
 * Both surfaces used to keep their own list: the profile grouped by day, the
 * switcher by Live now / Recent / Automated, and the two disagreed about what
 * belonged where. The fix is one component, so the proof is that both surfaces
 * hand their agent to that one component and draw nothing of their own.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { MOCK_TEAM_ROSTER } from '@/dev/mock-samples';

const chatList = vi.hoisted(() => vi.fn());
vi.mock('@/layers/features/chat-list', () => ({
  ChatList: (props: { agentPath: string | null }) => {
    chatList(props);
    return <div data-testid="the-chat-list" />;
  },
}));

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useRouter: () => ({ stores: {} }),
  useSearch: () => ({}),
  useNavigate: () => vi.fn(),
  useRouterState: () => '/session',
}));

// Imported after the mocks, so both surfaces resolve the stubbed list.
const { SessionsPage } = await import('@/layers/features/profile/ui/pages/SessionsPage');
const { SessionSwitcher } = await import('@/layers/features/dashboard-sidebar');

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
});

afterEach(() => {
  cleanup();
  chatList.mockClear();
});

const WARDEN = MOCK_TEAM_ROSTER.find((member) => member.id === 'agent-warden') as TeamMember;
const PATH = WARDEN.agent!.projectPath;

function wrap(node: React.ReactNode) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <TransportProvider transport={createMockTransport()}>{node}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('one chat list', () => {
  it('Profile → Sessions draws the shared ChatList for its agent', () => {
    const { getByTestId } = render(
      wrap(<SessionsPage member={WARDEN} roster={[WARDEN]} onPush={vi.fn()} />)
    );
    expect(getByTestId('the-chat-list')).toBeInTheDocument();
    expect(chatList).toHaveBeenCalledWith(expect.objectContaining({ agentPath: PATH }));
  });

  it('Switch session draws the same ChatList for the same agent', () => {
    const { getByTestId } = render(
      wrap(
        <SessionSwitcher
          agentPath={PATH}
          agentName="Warden"
          agentVisual={{ color: '#6366f1', emoji: '🛡' }}
          open
          onOpenChange={vi.fn()}
          onSelectSession={vi.fn()}
          onNewSession={vi.fn()}
        />
      )
    );
    expect(getByTestId('the-chat-list')).toBeInTheDocument();
    expect(chatList).toHaveBeenCalledWith(expect.objectContaining({ agentPath: PATH }));
  });
});
