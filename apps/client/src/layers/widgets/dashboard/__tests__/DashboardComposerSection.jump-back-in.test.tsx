// @vitest-environment jsdom
/**
 * "Jump back in" on the home composer, driven through the REAL composer.
 *
 * The sibling suite stubs the composer down to callbacks, which is right for
 * the submit seam and wrong for this: every claim here is about keys and focus
 * — Enter, the arrows, Escape, and where the caret is while they land. A stub
 * would assert that the props were passed, not that the keyboard works.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport, createMockSession } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { DashboardComposerSection } from '../ui/DashboardComposerSection';

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mockNavigate }));

const REGISTERED_DIR = '/home/kai/.dork/agents/dorkbot';
vi.mock('@/layers/entities/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/config')>();
  return {
    ...actual,
    useDefaultAgentSession: () => ({
      startSession: vi.fn(),
      defaultAgentDir: REGISTERED_DIR,
      defaultAgentDisplayName: 'DorkBot',
      defaultAgentIdentity: {
        name: 'dorkbot',
        displayName: 'DorkBot',
        agentId: 'agent-ulid-1',
        runtime: 'claude-code',
      },
      isDefaultAgentResolved: true,
    }),
  };
});

/** A channel with a real history, so the recents model keeps it. */
const channel = (id: string, slug: string, lastActivityAt: string): RoomSummary => ({
  id,
  kind: 'channel',
  slug,
  title: slug,
  topic: 'Ship notes',
  workspaceId: null,
  archived: false,
  createdAt: '2026-07-01T00:00:00.000Z',
  lastActivityAt,
  unreadCount: 0,
  participants: null,
});

/** Two rooms and one session — most recent first: #general, the session, #releases. */
function transportWithThreads(): Transport {
  return createMockTransport({
    listRecentSessions: vi.fn().mockResolvedValue({
      sessions: [
        createMockSession({
          id: 'sess-1',
          title: 'Refactor auth middleware',
          cwd: '/code/api',
          updatedAt: '2026-08-01T11:00:00.000Z',
        }),
      ],
      agentActivity: {},
      warnings: [],
    }),
    listRooms: vi
      .fn()
      .mockResolvedValue([
        channel('c1', 'general', '2026-08-01T12:00:00.000Z'),
        channel('c2', 'releases', '2026-08-01T10:00:00.000Z'),
      ]),
  });
}

/** A cache that survives an unmount, so a second mount can start warm. */
function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderSection(transport: Transport, queryClient = makeQueryClient()) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return render(<DashboardComposerSection />, { wrapper });
}

/** The composer's text field — a combobox, the same as every palette host's. */
function field(): HTMLElement {
  return screen.getByRole('combobox');
}

/** Take focus away, then put it back the way a person would: by clicking. */
async function refocusComposer(user: ReturnType<typeof userEvent.setup>) {
  await user.click(document.body);
  await user.click(field());
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('DashboardComposerSection — Jump back in', () => {
  it('stays closed on the composer’s own mount focus, with the list already in hand', async () => {
    const user = userEvent.setup();
    const transport = transportWithThreads();
    // One cache across both mounts. The FIRST one loads the rows; the second
    // therefore has them on its very first render, which is the only way this
    // claim can be made honestly — with a cold cache the panel would have
    // nothing to draw yet and would stay down whether or not the rule exists.
    const queryClient = makeQueryClient();

    const first = renderSection(transport, queryClient);
    await refocusComposer(user);
    await screen.findByRole('listbox');
    first.unmount();

    renderSection(transport, queryClient);

    // The composer takes the caret on mount, and the rows are right there —
    // and still nothing floats up. Landing on home is not a request for a panel
    // over the page.
    expect(document.activeElement).toBe(field());
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(field()).toHaveAttribute('aria-expanded', 'false');
  });

  // The gesture the whole feature is named for, and the one the suite used to
  // miss: every other test here defocuses first, so every one of them opened the
  // panel with a FOCUS event. On the real home surface the composer already
  // holds the caret, a click dispatches no focus event at all, and the primary
  // gesture did nothing whatsoever.
  it('opens when the person clicks the composer it already had the caret in', async () => {
    const user = userEvent.setup();
    const transport = transportWithThreads();
    renderSection(transport);

    await waitFor(() => expect(transport.listRooms).toHaveBeenCalled());
    expect(document.activeElement).toBe(field());

    await user.click(field());

    expect(await screen.findByRole('listbox', { name: 'Jump back in' })).toBeInTheDocument();
    expect(document.activeElement).toBe(field());
  });

  it('opens when the person focuses the empty composer, listing recent threads', async () => {
    const user = userEvent.setup();
    renderSection(transportWithThreads());

    await refocusComposer(user);

    const listbox = await screen.findByRole('listbox', { name: 'Jump back in' });
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining('general'),
      expect.stringContaining('Refactor auth middleware'),
      expect.stringContaining('releases'),
    ]);
    // The panel is the composer's, announced through it: focus never moves.
    expect(document.activeElement).toBe(field());
    expect(field()).toHaveAttribute('aria-expanded', 'true');
    expect(field()).toHaveAttribute('aria-controls', listbox.id);
  });

  it('closes as soon as there is anything in the box', async () => {
    const user = userEvent.setup();
    renderSection(transportWithThreads());

    await refocusComposer(user);
    expect(await screen.findByRole('listbox')).toBeInTheDocument();

    await user.keyboard('h');

    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  });

  it('arrows move the highlight without moving the caret, and Enter opens that thread', async () => {
    const user = userEvent.setup();
    renderSection(transportWithThreads());

    await refocusComposer(user);
    await screen.findByRole('listbox');

    await user.keyboard('{ArrowDown}{ArrowDown}');

    // Third row: #releases. The highlight is published through the composer,
    // which still holds the caret.
    const options = screen.getAllByRole('option');
    expect(options[2]).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(field());
    expect(field()).toHaveAttribute('aria-activedescendant', options[2]!.id);

    await user.keyboard('{Enter}');

    expect(mockNavigate).toHaveBeenCalledWith({ to: '/channels', search: { id: 'c2' } });
  });

  it('opens a session with the dir and id the sidebar rows use', async () => {
    const user = userEvent.setup();
    renderSection(transportWithThreads());

    await refocusComposer(user);
    await screen.findByRole('listbox');

    await user.keyboard('{ArrowDown}{Enter}');

    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: { dir: '/code/api', session: 'sess-1' },
    });
  });

  it('clicking a row opens it', async () => {
    const user = userEvent.setup();
    renderSection(transportWithThreads());

    await refocusComposer(user);
    await screen.findByRole('listbox');

    await user.click(screen.getAllByRole('option')[0]!);

    expect(mockNavigate).toHaveBeenCalledWith({ to: '/channels', search: { id: 'c1' } });
  });

  it('Escape closes it, navigates nowhere, and leaves a plain composer', async () => {
    const user = userEvent.setup();
    renderSection(transportWithThreads());

    await refocusComposer(user);
    await screen.findByRole('listbox');

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field());
    expect(field()).toHaveAttribute('aria-expanded', 'false');

    // Still typeable, and Enter still sends rather than picking a row.
    await user.keyboard('hello');
    expect(field()).toHaveValue('hello');
  });

  it('stays closed for the rest of the visit after Escape, and reopens on a fresh focus', async () => {
    const user = userEvent.setup();
    renderSection(transportWithThreads());

    await refocusComposer(user);
    await screen.findByRole('listbox');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());

    await refocusComposer(user);

    expect(await screen.findByRole('listbox')).toBeInTheDocument();
  });

  // The composer's palette ladder makes Tab a second pick key, which is right
  // for a picker you asked for by typing `@` and wrong for a panel that arrives
  // because you put the caret somewhere. Without the guard, tabbing on from an
  // empty composer opened whatever thread happened to be lit.
  it('Tab still means Tab: it moves on rather than opening the lit thread', async () => {
    const user = userEvent.setup();
    renderSection(transportWithThreads());

    await refocusComposer(user);
    await screen.findByRole('listbox');

    await user.tab();

    expect(mockNavigate).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(document.activeElement).not.toBe(field());
  });

  // Typing is the clearest statement that somebody came here to write. Deleting
  // it again put the panel straight back up over a caret mid-sentence, which is
  // the panel interrupting the very thing it exists to stay out of the way of.
  it('stays down after typing, even once the box is empty again', async () => {
    const user = userEvent.setup();
    renderSection(transportWithThreads());

    await refocusComposer(user);
    await screen.findByRole('listbox');

    await user.keyboard('hello');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    await user.keyboard('{Backspace>5/}');
    expect(field()).toHaveValue('');

    // Still empty, still focused — and still down. A click in place does not
    // re-ask either: the caret never left.
    expect(screen.queryByRole('listbox')).toBeNull();
    await user.click(field());
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('offers again when the caret leaves and comes back', async () => {
    const user = userEvent.setup();
    renderSection(transportWithThreads());

    await refocusComposer(user);
    await screen.findByRole('listbox');
    await user.keyboard('hello');
    await user.keyboard('{Backspace>5/}');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());

    await refocusComposer(user);

    expect(await screen.findByRole('listbox')).toBeInTheDocument();
  });

  it('draws nothing at all when there is nothing to jump back into', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    renderSection(transport);

    await waitFor(() => expect(transport.listRooms).toHaveBeenCalled());
    await refocusComposer(user);
    await user.click(field());

    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(field()).toHaveAttribute('aria-expanded', 'false');
  });
});
