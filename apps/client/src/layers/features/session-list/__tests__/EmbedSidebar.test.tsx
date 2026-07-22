/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function Wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const mockSetActiveSession = vi.fn();
const mockSetSidebarOpen = vi.fn();
let mockSessions: Array<{ id: string }> = [];

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
      selector({ selectedCwd: '/repo/a', setSidebarOpen: mockSetSidebarOpen }),
    useTransport: () => ({ forkSession: vi.fn() }),
  };
});

vi.mock('@/layers/entities/session', () => ({
  useSessions: () => ({ setActiveSession: mockSetActiveSession }),
  useAgentSessions: () => ({ sessions: mockSessions, activeSessionId: null }),
  useSessionListWarnings: () => [],
  useRenameSession: () => ({ mutate: vi.fn() }),
}));

vi.mock('@/layers/entities/agent', () => ({
  useCurrentAgent: () => ({ data: { displayName: 'Scout', name: 'scout' } }),
}));

// Keep the unit focused on EmbedSidebar's own chrome + wiring — the roster and
// promo surfaces have their own tests.
vi.mock('../ui/SessionsView', () => ({
  SessionsView: ({ groupedSessions }: { groupedSessions: Array<{ label: string }> }) => (
    <div data-testid="sessions-view">{groupedSessions.length} groups</div>
  ),
}));
vi.mock('@/layers/features/feature-promos', () => ({
  PromoSlot: () => null,
}));

import { EmbedSidebar } from '../ui/EmbedSidebar';

beforeEach(() => {
  vi.clearAllMocks();
  mockSessions = [];
});
afterEach(cleanup);

describe('EmbedSidebar', () => {
  it('renders the agent name and the roster', () => {
    render(<EmbedSidebar />, { wrapper: Wrapper });
    expect(screen.getByText('Scout')).toBeInTheDocument();
    expect(screen.getByTestId('sessions-view')).toBeInTheDocument();
  });

  it('starts a new session and closes the overlay when New is clicked', async () => {
    const user = userEvent.setup();
    render(<EmbedSidebar />, { wrapper: Wrapper });

    await user.click(screen.getByRole('button', { name: /new/i }));

    expect(mockSetActiveSession).toHaveBeenCalledTimes(1);
    expect(mockSetActiveSession.mock.calls[0][0]).toEqual(expect.any(String));
    expect(mockSetSidebarOpen).toHaveBeenCalledWith(false);
  });
});
