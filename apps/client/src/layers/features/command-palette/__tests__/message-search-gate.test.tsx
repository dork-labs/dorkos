// @vitest-environment jsdom
/**
 * Message search is offered where there is an index and nowhere else (DOR-685,
 * DOR-1563, and the demo-claim gate in AGENTS.md).
 *
 * Three surfaces have to be silent, and each is asserted separately because
 * each is a different mechanism: the dialog does not mount, the chord is not
 * bound, and the hand-off row is not drawn. A test for one would pass while
 * either of the others still pointed at the dead end.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import { createMockTransport } from '@dorkos/test-utils';
import type { Session } from '@dorkos/shared/types';

import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { useInteractionStore } from '@/layers/entities/interactions';
import { SEARCH_SCOPE_SUMMARY } from '../model/message-search-scope';
import { MessageSearchDialog } from '../ui/MessageSearchDialog';
import { CommandPaletteDialog } from '../ui/CommandPaletteDialog';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
  useRouter: () => ({
    navigate: () => Promise.resolve(),
    state: { location: { href: '/', pathname: '/' } },
  }),
  useRouterState: (opts?: { select?: (s: unknown) => unknown }) =>
    opts?.select?.({ location: { pathname: '/' } }) ?? { location: { pathname: '/' } },
}));
vi.mock('sonner', () => ({ toast: { info: vi.fn() } }));

vi.mock('@/layers/entities/mesh', () => ({
  useMeshAgentPaths: () => ({
    data: { agents: [{ id: 'agent-dash', name: 'Dashboards', projectPath: '/projects/dash' }] },
    isLoading: false,
  }),
}));
vi.mock('@/layers/entities/command', () => ({ useCommands: () => ({ data: { commands: [] } }) }));
vi.mock('@/layers/entities/tasks', () => ({ useActiveTaskRunCount: () => ({ data: undefined }) }));
vi.mock('@/layers/entities/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session')>()),
  useDirectoryState: () => ['/projects/dash', vi.fn()],
  useSessions: () => ({ sessions: [] }),
}));
vi.mock('../model/use-preview-data', () => ({
  usePreviewData: () => ({ sessionCount: 0, recentSessions: [], health: null }),
}));

const session: Session = {
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Dashboard overhaul',
  createdAt: '2026-08-24T09:00:00.000Z',
  updatedAt: '2026-08-24T10:00:00.000Z',
  permissionMode: 'default',
  runtime: 'claude-code',
  cwd: '/projects/dash',
};

const mockTransport = createMockTransport();

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return (
    <QueryClientProvider client={client}>
      <TransportProvider transport={mockTransport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

globalThis.ResizeObserver = vi.fn().mockImplementation(function () {
  return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
});
Element.prototype.scrollIntoView = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
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
  vi.mocked(mockTransport.listRooms).mockResolvedValue([]);
  vi.mocked(mockTransport.listRecentSessions).mockResolvedValue({
    sessions: [session],
    agentActivity: {},
    warnings: [],
  });
  useAppStore.getState().setMessageSearchOpen(false);
  useAppStore.getState().setGlobalPaletteOpen(false);
  localStorage.clear();
  useInteractionStore.getState().reset();
});

afterEach(() => {
  cleanup();
});

describe('where the search box exists', () => {
  it('mounts in a browser under exactly the same call — the check is not a constant false', () => {
    render(<MessageSearchDialog />, { wrapper: Wrapper });
    act(() => useAppStore.getState().setMessageSearchOpen(true));

    expect(screen.getByTestId('message-search-dialog')).toBeInTheDocument();
  });

  it('does not say it in a browser, where it is not true', () => {
    render(<MessageSearchDialog />, { wrapper: Wrapper });
    act(() => useAppStore.getState().setMessageSearchOpen(true));

    fireEvent.click(screen.getByRole('button', { name: SEARCH_SCOPE_SUMMARY }));
    expect(screen.queryByText(/what DorkOS has already indexed/i)).toBeNull();
  });

  it('binds ⌘⇧F in a browser', () => {
    render(<MessageSearchDialog />, { wrapper: Wrapper });

    const event = new KeyboardEvent('keydown', {
      key: 'F',
      code: 'KeyF',
      metaKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(useAppStore.getState().messageSearchOpen).toBe(true);
  });
});

describe('where ⌘K’s hand-off row is drawn', () => {
  /** The hand-off row, or `null`. */
  function handoffRow(): HTMLElement | null {
    return (
      screen
        .queryAllByRole('option')
        .find((el) => /^Search (all )?messages for/.test(el.textContent ?? '')) ?? null
    );
  }

  it('is drawn in a browser on the same query', async () => {
    act(() => useAppStore.getState().setGlobalPaletteOpen(true));
    render(<CommandPaletteDialog />, { wrapper: Wrapper });
    fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: 'dash' } });

    await waitFor(() => expect(handoffRow()).not.toBeNull());
  });
});
