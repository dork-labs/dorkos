// @vitest-environment jsdom
/**
 * Message search is offered where there is an index and nowhere else (DOR-685,
 * DOR-1563, and the demo-claim gate in AGENTS.md).
 *
 * **`App.tsx` is the Obsidian embed's shell as well as the browser's.** The
 * plugin renders it directly (`apps/obsidian-plugin/src/components/ObsidianApp.tsx`
 * imports `App` from `@dorkos/client/App`), so anything mounted there is
 * mounted inside Obsidian too. That made the first cut of this feature ship a
 * search box into a surface with no index behind it: `DirectTransport.search`
 * rejects, every line of the coverage statement is false there, and the box
 * took two characters plus a debounce before it admitted any of it — while ⌘K's
 * last row advertised the way in.
 *
 * Three surfaces have to be silent, and each is asserted separately because
 * each is a different mechanism: the dialog does not mount, the chord is not
 * bound, and the hand-off row is not drawn. A test for one would pass while
 * either of the others still pointed at the dead end.
 *
 * **The gate is a capability now, not a shell.** Until DOR-1563 an embed could
 * not open the index, so `isEmbedded` and "cannot search" were the same fact and
 * the file only had to prove one direction. They have come apart: the Obsidian
 * plugin opens `~/.dork/dork.db` when there is one, and answers
 * `canSearchMessages` accordingly. So each case is asked THREE ways — an embed
 * with no index, an embed with one, and a browser — because a gate that reads
 * the shell instead of the capability passes the first and third and fails only
 * the second.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import { createMockTransport } from '@dorkos/test-utils';
import type { Session } from '@dorkos/shared/types';
import { setPlatformAdapter } from '@/layers/shared/lib';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { useInteractionStore } from '@/layers/entities/interactions';
import { SEARCH_SCOPE_SUMMARY } from '../model/message-search-scope';
import { MessageSearchDialog } from '../ui/MessageSearchDialog';
import { CommandPaletteDialog } from '../ui/CommandPaletteDialog';

// The router itself is stubbed rather than stood up: this file is about which
// surfaces exist in which shell, and the palette reaches route state through
// `useSafeSearch`/`useSafePathname` on its way to the deep-link hooks. Those
// short-circuit in the embed and do not in a browser, so the browser half needs
// real answers here.
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

/**
 * Put the app in the embed, the way the Obsidian view does at bootstrap.
 *
 * @param canSearchMessages - Whether this window opened a message index, which
 *   `CopilotView` settles before it sets the adapter.
 */
function enterEmbed(canSearchMessages = false) {
  setPlatformAdapter({ isEmbedded: true, canSearchMessages, openFile: async () => {} });
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
  // Back to the browser adapter, or every later file in this worker inherits
  // the embed.
  setPlatformAdapter({ isEmbedded: false, openFile: async () => {} });
});

describe('where the search box exists', () => {
  it('does not mount, even when something asks it to open', () => {
    enterEmbed();
    render(<MessageSearchDialog />, { wrapper: Wrapper });
    act(() => useAppStore.getState().setMessageSearchOpen(true));

    expect(screen.queryByTestId('message-search-dialog')).toBeNull();
    expect(screen.queryByText(SEARCH_SCOPE_SUMMARY)).toBeNull();
    // And it never asked the transport, so nothing reached the rejecting stub.
    expect(mockTransport.search).not.toHaveBeenCalled();
  });

  it('mounts in a browser under exactly the same call — the check is not a constant false', () => {
    render(<MessageSearchDialog />, { wrapper: Wrapper });
    act(() => useAppStore.getState().setMessageSearchOpen(true));

    expect(screen.getByTestId('message-search-dialog')).toBeInTheDocument();
  });

  it('mounts in an embed that DID open an index', () => {
    // The direction the old gate could not express. Still the embed — same
    // shell, same `App.tsx` — but this window has something to search, so
    // refusing to draw the box would be hiding a working feature.
    enterEmbed(true);
    render(<MessageSearchDialog />, { wrapper: Wrapper });
    act(() => useAppStore.getState().setMessageSearchOpen(true));

    expect(screen.getByTestId('message-search-dialog')).toBeInTheDocument();
  });

  it('tells you, in the embed, that what it searches is only what DorkOS indexed', () => {
    // The honest half of the read-only trade. The embed reads an index it does
    // not keep current — it will not write to a file the DorkOS app may be
    // writing, nor spend the vault's own thread walking transcripts — so a
    // conversation held while only Obsidian was open is not findable here yet.
    // A box that returned less than the browser's for the same words and said
    // nothing is the exact surprise this whole statement exists to prevent.
    enterEmbed(true);
    render(<MessageSearchDialog />, { wrapper: Wrapper });
    act(() => useAppStore.getState().setMessageSearchOpen(true));

    // It lives with the rest of the fine print, one click behind the summary
    // line (DOR-1757) — reachable, which is what G4 asks for.
    fireEvent.click(screen.getByRole('button', { name: SEARCH_SCOPE_SUMMARY }));
    expect(screen.getByText(/what DorkOS has already indexed/i)).toBeInTheDocument();
  });

  it('does not say it in a browser, where it is not true', () => {
    render(<MessageSearchDialog />, { wrapper: Wrapper });
    act(() => useAppStore.getState().setMessageSearchOpen(true));

    fireEvent.click(screen.getByRole('button', { name: SEARCH_SCOPE_SUMMARY }));
    expect(screen.queryByText(/what DorkOS has already indexed/i)).toBeNull();
  });

  it('binds ⌘⇧F in an embed that DID open an index', () => {
    enterEmbed(true);
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

    expect(useAppStore.getState().messageSearchOpen).toBe(true);
  });

  it('does not bind ⌘⇧F', () => {
    enterEmbed();
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

    // Nothing took the keystroke, and nothing opened. Both, because the store
    // flag alone would also be false if the chord fired and the dialog refused.
    expect(event.defaultPrevented).toBe(false);
    expect(useAppStore.getState().messageSearchOpen).toBe(false);
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

describe("where ⌘K's hand-off row is drawn", () => {
  /** The hand-off row, or `null`. */
  function handoffRow(): HTMLElement | null {
    return (
      screen
        .queryAllByRole('option')
        .find((el) => /^Search (all )?messages for/.test(el.textContent ?? '')) ?? null
    );
  }

  it('is not drawn, so ⌘K never points at a surface that is not there', async () => {
    enterEmbed();
    act(() => useAppStore.getState().setGlobalPaletteOpen(true));
    render(<CommandPaletteDialog />, { wrapper: Wrapper });
    fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: 'dash' } });

    // The positive anchor: the palette itself works here, so the row's absence
    // is about the row.
    await waitFor(() => expect(screen.getByText('Dashboard overhaul')).toBeInTheDocument());
    expect(handoffRow()).toBeNull();
  });

  it('is drawn in an embed that DID open an index', async () => {
    // ⌘K and ⌘⇧F read one function, so this row appearing is the same decision
    // as the box mounting. Asserted anyway: they are two files, and the drift
    // this catches is a palette advertising a box that never opens.
    enterEmbed(true);
    act(() => useAppStore.getState().setGlobalPaletteOpen(true));
    render(<CommandPaletteDialog />, { wrapper: Wrapper });
    fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: 'dash' } });

    await waitFor(() => expect(handoffRow()).not.toBeNull());
  });

  it('is drawn in a browser on the same query', async () => {
    act(() => useAppStore.getState().setGlobalPaletteOpen(true));
    render(<CommandPaletteDialog />, { wrapper: Wrapper });
    fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: 'dash' } });

    await waitFor(() => expect(handoffRow()).not.toBeNull());
  });
});
