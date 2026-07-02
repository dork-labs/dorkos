/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { Session } from '@dorkos/shared/types';
import { TooltipProvider } from '@/layers/shared/ui';
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
  return <TooltipProvider>{children}</TooltipProvider>;
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
});
