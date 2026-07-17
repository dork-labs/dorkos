/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Session } from '@dorkos/shared/types';
import { TooltipProvider } from '@/layers/shared/ui';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { useSessionChatStore, useSessionListStore } from '@/layers/entities/session';
import { SessionsView } from '../ui/SessionsView';

// Mock window.matchMedia for useIsMobile hook
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

  // Radix UI's @radix-ui/react-use-size calls ResizeObserver which jsdom doesn't provide.
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'abc12345-def6-7890-abcd-ef1234567890',
    title: 'Test conversation',
    createdAt: '2026-02-07T10:00:00Z',
    updatedAt: '2026-02-07T14:00:00Z',
    permissionMode: 'default',
    runtime: 'claude-code',
    ...overrides,
  };
}

function Wrapper({ children }: { children: React.ReactNode }) {
  // The rows render SessionContextGauge and the view renders FleetContextBar,
  // both resolving context health via useModels (transport). With an empty
  // session store the bar hides and every gauge sits in its muted "unknown"
  // state, so these assertions are unaffected.
  const transport = createMockTransport();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TooltipProvider>{children}</TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
}

describe('SessionsView', () => {
  beforeEach(() => {
    useSessionChatStore.setState({ sessions: {}, sessionAccessOrder: [] });
    useSessionListStore.setState({ sessions: {}, statuses: {}, statusCwds: {}, unseen: {} });
  });
  afterEach(cleanup);

  it('renders grouped session rows', () => {
    render(
      <SessionsView
        activeSessionId={null}
        groupedSessions={[{ label: 'Today', sessions: [makeSession()] }]}
        onSessionClick={() => {}}
      />,
      { wrapper: Wrapper }
    );
    expect(screen.getByText('Test conversation')).toBeDefined();
  });

  it('marks each row with its runtime', () => {
    render(
      <SessionsView
        activeSessionId={null}
        groupedSessions={[
          {
            label: 'Today',
            sessions: [
              makeSession({ id: 'a1b2c3d4-0000-0000-0000-000000000001', runtime: 'codex' }),
              makeSession({ id: 'a1b2c3d4-0000-0000-0000-000000000002', title: 'Claude session' }),
            ],
          },
        ]}
        onSessionClick={() => {}}
      />,
      { wrapper: Wrapper }
    );
    expect(screen.getByLabelText('Runtime: Codex')).toBeDefined();
    expect(screen.getByLabelText('Runtime: Claude Code')).toBeDefined();
  });

  it('shows the empty state when there are no sessions', () => {
    render(<SessionsView activeSessionId={null} groupedSessions={[]} onSessionClick={() => {}} />, {
      wrapper: Wrapper,
    });
    expect(screen.getByText('No conversations yet')).toBeDefined();
  });

  // Per-runtime listing degradations (ADR-0310) surface as a quiet,
  // runtime-named notice — never a blank or broken list (spec task 4.2).
  describe('per-runtime listing warnings', () => {
    it('renders a runtime-named notice with the server reason as its tooltip', () => {
      render(
        <SessionsView
          activeSessionId={null}
          groupedSessions={[{ label: 'Today', sessions: [makeSession()] }]}
          warnings={[{ runtime: 'opencode', message: 'OpenCode server is starting' }]}
          onSessionClick={() => {}}
        />,
        { wrapper: Wrapper }
      );
      const notice = screen.getByTestId('session-list-warning-opencode');
      expect(notice.textContent).toContain("Couldn't load OpenCode sessions");
      expect(notice.getAttribute('title')).toBe('OpenCode server is starting');
      // The rest of the list still renders — warnings are non-blocking.
      expect(screen.getByText('Test conversation')).toBeDefined();
    });

    it('renders one notice per degraded runtime', () => {
      render(
        <SessionsView
          activeSessionId={null}
          groupedSessions={[]}
          warnings={[
            { runtime: 'codex', message: 'listSessions timed out after 2000ms' },
            { runtime: 'opencode', message: 'OpenCode sidecar exited before ready' },
          ]}
          onSessionClick={() => {}}
        />,
        { wrapper: Wrapper }
      );
      expect(screen.getByTestId('session-list-warning-codex').textContent).toContain(
        "Couldn't load Codex sessions"
      );
      expect(screen.getByTestId('session-list-warning-opencode').textContent).toContain(
        "Couldn't load OpenCode sessions"
      );
      // The empty state still shows alongside the notices.
      expect(screen.getByText('No conversations yet')).toBeDefined();
    });

    it('renders no notice container when every runtime listed successfully', () => {
      render(
        <SessionsView
          activeSessionId={null}
          groupedSessions={[{ label: 'Today', sessions: [makeSession()] }]}
          warnings={[]}
          onSessionClick={() => {}}
        />,
        { wrapper: Wrapper }
      );
      expect(screen.queryByTestId('session-list-warnings')).toBeNull();
    });
  });
});
