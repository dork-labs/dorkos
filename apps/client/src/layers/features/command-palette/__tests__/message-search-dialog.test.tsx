// @vitest-environment jsdom
/**
 * The message-search box, driven the way a person drives it
 * (`specs/message-search` §8, DOR-685).
 *
 * Nothing about search is stubbed except the wire: the debounce, the minimum
 * length, the excerpt rendering, the empty states and the navigation are all
 * the shipped ones, reached through a mock `Transport` via `TransportProvider`.
 * The app store is the real one, so "⌘K handed the words across" and "somebody
 * pressed ⌘⇧F" are the same two lines of state they are in the product.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import { createMockTransport } from '@dorkos/test-utils';
import type { SearchHit } from '@dorkos/shared/search-schemas';
import { SEARCH_DEBOUNCE_MS } from '@dorkos/shared/search-schemas';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { MessageSearchDialog } from '../ui/MessageSearchDialog';

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mockNavigate }));

const toastInfo = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { info: toastInfo } }));

// --- Fixtures ---

const roomHit: SearchHit = {
  source: 'rooms',
  container: 'room-1',
  containerPath: null,
  ordinal: 12,
  role: 'user',
  createdAt: '2026-08-24T10:00:00.000Z',
  excerpt: 'we settled the <mark>port</mark> question in here',
};

const sessionHit: SearchHit = {
  source: 'claude-code',
  container: 'sess-9',
  containerPath: '/work/api',
  ordinal: 3,
  role: 'assistant',
  createdAt: '2026-08-24T09:00:00.000Z',
  excerpt: 'the <mark>port</mark> is bound at boot',
};

const general: RoomSummary = {
  id: 'room-1',
  kind: 'channel',
  slug: 'general',
  title: 'General',
  topic: null,
  workspaceId: null,
  archived: false,
  ambientMaxEntries: 30,
  createdAt: '2026-08-24T08:00:00.000Z',
  lastActivityAt: '2026-08-24T10:00:00.000Z',
  unreadCount: null,
  participants: null,
};

/**
 * What `HttpTransport` throws for a refused request: an `Error` carrying the
 * response status, which is the only thing that tells "deleted" apart from
 * "refused".
 */
function refusal(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

const mockTransport = createMockTransport();

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return (
    <QueryClientProvider client={client}>
      <TransportProvider transport={mockTransport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

/** Mount the box already open, the way ⌘⇧F leaves it. */
function open(seed?: string) {
  const result = render(<MessageSearchDialog />, { wrapper: Wrapper });
  act(() => {
    if (seed === undefined) useAppStore.getState().setMessageSearchOpen(true);
    else useAppStore.getState().openMessageSearch(seed);
  });
  return result;
}

const input = () => screen.getByTestId('message-search-input');
const type = (value: string) => fireEvent.change(input(), { target: { value } });

/** Wait past the published debounce, plus room for the render that follows it. */
async function pastDebounce() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 60));
  });
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
  vi.mocked(mockTransport.listRooms).mockResolvedValue([general]);
  vi.mocked(mockTransport.search).mockResolvedValue({ results: [], warnings: [] });
  vi.mocked(mockTransport.browseDirectory).mockResolvedValue({
    path: '/work/api',
    entries: [],
  } as never);
  useAppStore.getState().setMessageSearchOpen(false);
});

afterEach(cleanup);

describe('what the box sends, and when', () => {
  it('sends nothing at all for a query below the minimum length', async () => {
    open();
    type('a');
    await pastDebounce();

    // Asserted on the CALL COUNT, never on the absence of rows: an empty result
    // list looks identical whether the request was skipped or answered with
    // nothing, so only this can tell the two apart.
    expect(mockTransport.search).not.toHaveBeenCalled();
  });

  it('counts the floor over WORDS, so punctuation is not two characters of search', async () => {
    // The same trap the route closed: `a,` and `%20a ` are two or more
    // characters and one letter of search, and each of them ran the most
    // expensive query there is while the check was a length on the raw string.
    open();
    type('a,');
    await pastDebounce();
    type('  a ');
    await pastDebounce();

    expect(mockTransport.search).not.toHaveBeenCalled();
  });

  it('waits out the debounce, then sends the settled query once', async () => {
    open();
    type('p');
    type('po');
    type('port');
    // Nothing yet: three keystrokes inside one debounce window are one question.
    expect(mockTransport.search).not.toHaveBeenCalled();

    await pastDebounce();

    expect(mockTransport.search).toHaveBeenCalledTimes(1);
    expect(mockTransport.search).toHaveBeenCalledWith({ q: 'port' });
  });

  it('searches nothing while the box is closed', async () => {
    render(<MessageSearchDialog />, { wrapper: Wrapper });
    await pastDebounce();
    expect(mockTransport.search).not.toHaveBeenCalled();
  });

  it('opens holding the words ⌘K handed across, and searches for them', async () => {
    open('port');
    await pastDebounce();

    expect(input()).toHaveValue('port');
    expect(mockTransport.search).toHaveBeenCalledWith({ q: 'port' });
  });
});

describe('what the box shows', () => {
  it('draws a hit with its match marked, its place and who said it', async () => {
    vi.mocked(mockTransport.search).mockResolvedValue({ results: [roomHit], warnings: [] });
    const { container } = open('port');
    await pastDebounce();

    const row = await screen.findByRole('option');
    expect(row).toHaveTextContent('we settled the port question in here');
    // The room is named the way a person would type it, not by its id.
    expect(row).toHaveTextContent('#general');
    expect(row).toHaveTextContent('You');
    // The match is a real element, built from the markers.
    const marks = container.ownerDocument.querySelectorAll('[role="option"] mark');
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe('port');
  });

  it('renders a hostile excerpt as characters, building no elements from it', async () => {
    // The end-to-end half of `ui/__tests__/SearchExcerpt.test.tsx`: an excerpt
    // is arbitrary text all the way from the route to the screen, and a room
    // full of pasted markup must not become markup here.
    vi.mocked(mockTransport.search).mockResolvedValue({
      results: [
        {
          ...roomHit,
          excerpt: '<script>alert(1)</script><img src=x onerror=alert(2)> the <mark>port</mark>',
        },
      ],
      warnings: [],
    });
    open('port');
    await pastDebounce();

    const row = await screen.findByRole('option');
    expect(row.querySelector('script')).toBeNull();
    expect(row.querySelector('img')).toBeNull();
    expect(row).toHaveTextContent('<script>alert(1)</script>');
  });

  it('says a source is behind in one quiet line, not a pile of them', async () => {
    vi.mocked(mockTransport.search).mockResolvedValue({
      results: [roomHit],
      warnings: [{ source: 'claude-code', message: 'Some conversations are still being read.' }],
    });
    open('port');
    await pastDebounce();

    await screen.findByRole('option');
    expect(screen.getAllByText('Some conversations are still being read.')).toHaveLength(1);
    // The results are still there. A warning qualifies an answer; it does not
    // replace one.
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('tells "too short to search" apart from "nothing matched"', async () => {
    // Two different facts that produce the same empty list, which is exactly
    // why each gets its own sentence.
    open();
    type('a');
    await pastDebounce();
    expect(screen.getByText(/Type at least 2 letters/)).toBeInTheDocument();
    expect(screen.queryByText(/No messages match/)).toBeNull();

    type('port');
    await pastDebounce();
    await waitFor(() => expect(screen.getByText(/No messages match/)).toBeInTheDocument());
    expect(screen.queryByText(/Type at least 2 letters/)).toBeNull();
  });

  it('says what went wrong when the search itself fails', async () => {
    // A failed search is drawn, never swallowed. Both transports reject rather
    // than answering emptily when they cannot search at all — an empty list
    // would say "your history holds no mention of this" about a word somebody
    // knows they wrote, which is the one answer neither may give.
    vi.mocked(mockTransport.search).mockRejectedValue(
      new Error('Search needs a word of at least 2 letters to look for.')
    );
    open('port');
    await pastDebounce();

    await waitFor(() =>
      expect(
        screen.getByText('Search needs a word of at least 2 letters to look for.')
      ).toBeInTheDocument()
    );
  });
});

describe('what the box does when a hit is chosen', () => {
  it('lands on the message a room hit names, not merely in the channel', async () => {
    vi.mocked(mockTransport.search).mockResolvedValue({ results: [roomHit], warnings: [] });
    open('port');
    await pastDebounce();

    fireEvent.click(await screen.findByRole('option'));

    // The destination, not merely "a navigation happened" — a no-op navigation
    // satisfies the weaker form. `entry` is the hit's own `seq`, which is what
    // the room route reads to open on the message rather than at the bottom.
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/channels',
      search: { id: 'room-1', entry: 12 },
    });
    expect(useAppStore.getState().messageSearchOpen).toBe(false);
  });

  it('opens the conversation a transcript hit was said in, with its directory', async () => {
    vi.mocked(mockTransport.search).mockResolvedValue({ results: [sessionHit], warnings: [] });
    open('port');
    await pastDebounce();

    fireEvent.click(await screen.findByRole('option'));

    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: { session: 'sess-9', dir: '/work/api' },
    });
  });

  it('lands on the message a conversation hit names when it carries an id', async () => {
    // The end of the wire for DOR-1579: an id the server returned has to reach
    // the route as `message`, or nothing downstream of it can work. Red if the
    // dialog drops it, or if the field never reaches the transport's response
    // type.
    vi.mocked(mockTransport.search).mockResolvedValue({
      results: [{ ...sessionHit, messageId: 'uuid-9' }],
      warnings: [],
    });
    open('port');
    await pastDebounce();

    fireEvent.click(await screen.findByRole('option'));

    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: { session: 'sess-9', dir: '/work/api', message: 'uuid-9' },
    });
  });

  it('opens a conversation whose folder is gone, and says the folder is gone', async () => {
    // §6.4's decided behaviour. The transcript is on disk and "what did we
    // decide in that worktree" is precisely the question this feature exists to
    // answer — so the hit opens, and the report is a line of explanation rather
    // than a failure.
    vi.mocked(mockTransport.search).mockResolvedValue({
      results: [{ ...sessionHit, containerPath: '/removed/worktree' }],
      warnings: [],
    });
    vi.mocked(mockTransport.browseDirectory).mockRejectedValue(refusal(404, 'Directory not found'));
    open('port');
    await pastDebounce();

    const row = await screen.findByRole('option');
    // The row shows the directory, so a person can tell two similarly named
    // projects apart before they open either.
    expect(row).toHaveTextContent('/removed/worktree');
    fireEvent.click(row);

    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: { session: 'sess-9', dir: '/removed/worktree' },
    });
    await waitFor(() =>
      expect(toastInfo).toHaveBeenCalledWith(
        'That folder is gone',
        expect.objectContaining({
          description: expect.stringContaining('/removed/worktree') as string,
        })
      )
    );
  });

  it('does NOT claim a folder is gone when the server merely refused it', async () => {
    // A `403` is the boundary or a permissions error, not a deletion — and both
    // halves of the "gone" sentence are false for it. The folder is there, and
    // *you can still read this conversation* is exactly what is NOT true, since
    // the boundary that refused this probe refuses the session stream too. It
    // is reachable: a `/private/tmp` working directory sits outside a normal
    // boundary, and nine of the thirty-three vanished paths the spec measured
    // were temp directories.
    vi.mocked(mockTransport.search).mockResolvedValue({
      results: [{ ...sessionHit, containerPath: '/private/tmp/scratch' }],
      warnings: [],
    });
    vi.mocked(mockTransport.browseDirectory).mockRejectedValue(refusal(403, 'Permission denied'));
    open('port');
    await pastDebounce();

    fireEvent.click(await screen.findByRole('option'));

    await waitFor(() => expect(toastInfo).toHaveBeenCalled());
    expect(toastInfo).toHaveBeenCalledWith(
      'DorkOS could not open that folder',
      expect.objectContaining({
        description: expect.stringContaining('/private/tmp/scratch') as string,
      })
    );
    // The claim that must not be made.
    expect(toastInfo).not.toHaveBeenCalledWith('That folder is gone', expect.anything());
  });

  it('falls to the narrow sentence when there is no status to read at all', async () => {
    // A network failure, or a transport that does not carry statuses. Nothing
    // is known, so nothing is claimed.
    vi.mocked(mockTransport.search).mockResolvedValue({ results: [sessionHit], warnings: [] });
    vi.mocked(mockTransport.browseDirectory).mockRejectedValue(new Error('Failed to fetch'));
    open('port');
    await pastDebounce();

    fireEvent.click(await screen.findByRole('option'));

    await waitFor(() => expect(toastInfo).toHaveBeenCalled());
    expect(toastInfo).toHaveBeenCalledWith('DorkOS could not open that folder', expect.anything());
  });

  it('says nothing about a folder that is still there', async () => {
    // The positive control. Without it the test above passes against a box that
    // reports every conversation as gone.
    vi.mocked(mockTransport.search).mockResolvedValue({ results: [sessionHit], warnings: [] });
    open('port');
    await pastDebounce();

    fireEvent.click(await screen.findByRole('option'));

    await waitFor(() => expect(mockTransport.browseDirectory).toHaveBeenCalledWith('/work/api'));
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it('never asks about a folder for a room, which has none', async () => {
    vi.mocked(mockTransport.search).mockResolvedValue({ results: [roomHit], warnings: [] });
    open('port');
    await pastDebounce();

    fireEvent.click(await screen.findByRole('option'));

    expect(mockTransport.browseDirectory).not.toHaveBeenCalled();
  });
});
