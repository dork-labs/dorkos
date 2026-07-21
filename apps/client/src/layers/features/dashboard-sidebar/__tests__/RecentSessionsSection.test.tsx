// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createMockSession } from '@dorkos/test-utils';
import type { Session } from '@dorkos/shared/types';
import { TooltipProvider } from '@/layers/shared/ui';
import { RecentSessionsSection } from '../ui/RecentSessionsSection';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/layers/entities/config', () => ({
  useSidebarPrefs: () => ({ recentsCollapsed: false }),
  useUpdateSidebarPrefs: () => ({
    update: vi.fn(),
    updateAsync: vi.fn(),
    isPending: false,
    isError: false,
  }),
  setRecentsCollapsed: (prev: unknown) => prev,
}));

beforeAll(() => {
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

afterEach(cleanup);

function Wrapper({ children }: { children: React.ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>;
}

function renderSection(
  sessions: Session[],
  overrides: Partial<Parameters<typeof RecentSessionsSection>[0]> = {}
) {
  return render(
    <RecentSessionsSection
      sessions={sessions}
      isLoading={false}
      agents={{}}
      displayNames={{}}
      onSelectSession={vi.fn()}
      {...overrides}
    />,
    { wrapper: Wrapper }
  );
}

describe('RecentSessionsSection', () => {
  it('shows only conversations (user-origin sessions) in the initial rows', () => {
    const sessions = [
      createMockSession({ id: 'u1', title: 'User session 1' }),
      createMockSession({ id: 'a1', title: 'Agent session', origin: 'agent' }),
      createMockSession({ id: 'u2', title: 'User session 2' }),
    ];
    renderSection(sessions);
    expect(screen.getByText('User session 1')).toBeInTheDocument();
    expect(screen.getByText('User session 2')).toBeInTheDocument();
    expect(screen.queryByText('Agent session')).not.toBeInTheDocument();
  });

  it('caps conversations at MAX_RECENT_ROWS (5)', () => {
    const sessions = Array.from({ length: 7 }, (_, i) =>
      createMockSession({ id: `u${i}`, title: `Session ${i}` })
    );
    renderSection(sessions);
    expect(screen.getByText('Session 0')).toBeInTheDocument();
    expect(screen.getByText('Session 4')).toBeInTheDocument();
    expect(screen.queryByText('Session 5')).not.toBeInTheDocument();
  });

  it('renders a + N automated reveal row and toggles automated sessions into view', () => {
    const sessions = [
      createMockSession({ id: 'u1', title: 'User session 1' }),
      createMockSession({
        id: 'c1',
        title: 'Channel session',
        origin: 'channel',
        originLabel: 'Telegram',
      }),
    ];
    renderSection(sessions);
    expect(screen.queryByText('Channel session')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('+ 1 automated'));
    expect(screen.getByText('Channel session')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Hide'));
    expect(screen.queryByText('Channel session')).not.toBeInTheDocument();
  });

  it('hides the reveal row when there are no automated sessions', () => {
    renderSection([createMockSession({ id: 'u1', title: 'User session 1' })]);
    expect(screen.queryByText(/automated/)).not.toBeInTheDocument();
  });

  it('shows the reveal row when conversations are empty but automated sessions exist', () => {
    const sessions = [createMockSession({ id: 't1', title: 'Task session', origin: 'task' })];
    renderSection(sessions);
    expect(screen.getByText('+ 1 automated')).toBeInTheDocument();
  });
});
