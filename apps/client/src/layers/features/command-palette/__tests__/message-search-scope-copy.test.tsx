// @vitest-environment jsdom
/**
 * The box says what it can and cannot see (`specs/message-search` **G4**,
 * §1.3, DOR-685).
 *
 * **This is a product commitment, so it gets assertions rather than a review
 * comment.** G4 says a person must be able to learn what search does not cover
 * without reading a spec, and there are two ways to be surprised by this
 * feature:
 *
 * 1. **Tool output is never indexed** — 71% of the corpus, and the thing people
 *    ask for by name ("the error the agent showed me").
 * 2. **Matching is by word, not by fragment.** `ogs` does not find `dogs`.
 *
 * All four sources registered with the index — rooms, Claude Code, Codex
 * (§2.2, DOR-683) and OpenCode (§2.3, Amendment 9, DOR-688), four entries over
 * three mechanisms per `registry.ts:268` — are covered as of DOR-1556, so the
 * runtime gap this file used to assert no longer exists.
 *
 * The strings are asserted LITERALLY, and that is deliberate rather than
 * brittle. Coverage moves, and a claim that quietly goes out of date is worse
 * than no claim at all: it is the product telling somebody their Codex history
 * is unsearchable after it became searchable, or the reverse. When a runtime's
 * coverage changes, this file goes red and the copy and the test move together
 * in that commit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import { createMockTransport } from '@dorkos/test-utils';
import { SEARCH_DEBOUNCE_MS } from '@dorkos/shared/search-schemas';
import type { SearchHit } from '@dorkos/shared/search-schemas';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { SEARCH_SCOPE_COVERED, SEARCH_SCOPE_GAPS } from '../model/message-search-scope';
import { MessageSearchDialog } from '../ui/MessageSearchDialog';

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('sonner', () => ({ toast: { info: vi.fn() } }));

const mockTransport = createMockTransport();

/** One hit, so the "there are results" states can be reached. */
const portHit: SearchHit = {
  source: 'rooms',
  container: 'room-1',
  containerPath: null,
  ordinal: 1,
  role: 'user',
  createdAt: '2026-08-24T10:00:00.000Z',
  excerpt: 'the <mark>port</mark> question',
};

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return (
    <QueryClientProvider client={client}>
      <TransportProvider transport={mockTransport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

function open() {
  const result = render(<MessageSearchDialog />, { wrapper: Wrapper });
  act(() => useAppStore.getState().setMessageSearchOpen(true));
  return result;
}

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
  vi.mocked(mockTransport.listRooms).mockResolvedValue([]);
  vi.mocked(mockTransport.search).mockResolvedValue({ results: [], warnings: [] });
  useAppStore.getState().setMessageSearchOpen(false);
});

afterEach(cleanup);

describe('the box states its own scope, before anything is typed', () => {
  it('names what it covers, and how current each one is', () => {
    open();

    expect(
      screen.getByText('Your DorkOS channels and direct messages, the moment they are posted.')
    ).toBeInTheDocument();
    // The five-minute lag on transcripts is stated rather than averaged away:
    // DorkOS owns the room write and indexes it on the spot, and a Claude Code,
    // Codex or OpenCode conversation is written by somebody else, picked up by
    // a sweep. All three runtimes are named together because all three share
    // that sweep (DOR-683, DOR-688).
    expect(
      screen.getByText(
        'Your Claude Code, Codex and OpenCode conversations, including the ones you ran outside DorkOS. A new message can take up to five minutes to show up here.'
      )
    ).toBeInTheDocument();
  });

  it('says tool output is never searched, and lists what that means', () => {
    open();

    expect(
      screen.getByText(
        'Tool output is never searched. No error messages, no stack traces, no file contents, no diffs. Search reads what you and your agents said to each other.'
      )
    ).toBeInTheDocument();
  });

  it('discloses the one query-syntax surprise, with the example', () => {
    // `porter unicode61` matches WORDS, so a fragment that is not a word finds
    // nothing. The spec names this as a product commitment rather than a
    // footnote, which is why it is on screen and asserted here.
    open();

    expect(
      screen.getByText(
        'Search matches whole words. Typing "ogs" will not find "dogs". Type "dog*" to match the start of a word instead.'
      )
    ).toBeInTheDocument();
  });

  it('heads the statement so it reads as an answer, not as an error', () => {
    open();
    expect(screen.getByText('What search covers')).toBeInTheDocument();
  });

  it('pins the LENGTH of both lists, not only their literal text', () => {
    // Literal-text assertions above only catch a REVERT — a claim that quietly
    // regresses back to "not covered". They stay green if a line is silently
    // ADDED instead: an over-claim (a fifth source nobody verified, say) would
    // render with nothing here going red. Pinning the count closes that gap in
    // the other direction, so growing either list is a deliberate, reviewed
    // edit to this file rather than a side effect nobody asserted against.
    expect(SEARCH_SCOPE_COVERED).toHaveLength(2);
    expect(SEARCH_SCOPE_GAPS).toHaveLength(2);
  });
});

describe('the box keeps stating its scope wherever a person is asking why', () => {
  it('is still there when a query is too short to run', async () => {
    open();
    fireEvent.change(screen.getByTestId('message-search-input'), { target: { value: 'a' } });
    await pastDebounce();

    expect(screen.getByText('What search covers')).toBeInTheDocument();
  });

  it('is still there when nothing matched — the moment the question is loudest', async () => {
    open();
    fireEvent.change(screen.getByTestId('message-search-input'), { target: { value: 'ogs' } });
    await pastDebounce();

    expect(screen.getByText('What search covers')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Your Claude Code, Codex and OpenCode conversations, including the ones you ran outside DorkOS. A new message can take up to five minutes to show up here.'
      )
    ).toBeInTheDocument();
  });

  it('is back on a REOPEN, after a search that found something', async () => {
    // **The state that actually pins G4.** The box only draws the full
    // statement when there are no results, and TanStack keeps answering a
    // disabled query from its cache — so before this was gated, every open
    // after the first showed the last search's rows and no scope statement at
    // all. A person who searched once never saw the commitment again.
    vi.mocked(mockTransport.search).mockResolvedValue({ results: [portHit], warnings: [] });

    open();
    fireEvent.change(screen.getByTestId('message-search-input'), { target: { value: 'port' } });
    await pastDebounce();
    await screen.findByRole('option');
    expect(screen.queryByText('What search covers')).toBeNull();

    act(() => useAppStore.getState().setMessageSearchOpen(false));
    act(() => useAppStore.getState().setMessageSearchOpen(true));

    // Immediately, without waiting out a debounce: the box is empty, so it is
    // in the state that has to say what it covers.
    expect(screen.getByTestId('message-search-input')).toHaveValue('');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('What search covers')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Your Claude Code, Codex and OpenCode conversations, including the ones you ran outside DorkOS. A new message can take up to five minutes to show up here.'
      )
    ).toBeInTheDocument();
  });

  it('is back when the query is CLEARED, with the old rows gone', async () => {
    vi.mocked(mockTransport.search).mockResolvedValue({ results: [portHit], warnings: [] });

    open();
    fireEvent.change(screen.getByTestId('message-search-input'), { target: { value: 'port' } });
    await pastDebounce();
    await screen.findByRole('option');

    fireEvent.change(screen.getByTestId('message-search-input'), { target: { value: '' } });
    await pastDebounce();

    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('What search covers')).toBeInTheDocument();
    // And no "nothing matched" sentence: nothing was asked.
    expect(screen.queryByText(/No messages match/)).toBeNull();
  });

  it('is back when the query is deleted BACK below the floor', async () => {
    // The third face of the same bug. `p` is not searchable, so the rows for
    // `port` do not belong to what is in the box — and "too short" is the
    // sentence that fits, not a stale list.
    vi.mocked(mockTransport.search).mockResolvedValue({ results: [portHit], warnings: [] });

    open();
    fireEvent.change(screen.getByTestId('message-search-input'), { target: { value: 'port' } });
    await pastDebounce();
    await screen.findByRole('option');

    fireEvent.change(screen.getByTestId('message-search-input'), { target: { value: 'p' } });
    await pastDebounce();

    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText(/Type at least 2 letters/)).toBeInTheDocument();
    expect(screen.getByText('What search covers')).toBeInTheDocument();
  });

  it('shortens to one line once there are results to read', async () => {
    // The one state where the full list is not drawn: somebody reading hits has
    // what they came for. It never goes silent, though — the boundary is still
    // stated, in one quiet sentence under the list.
    vi.mocked(mockTransport.search).mockResolvedValue({ results: [portHit], warnings: [] });

    open();
    fireEvent.change(screen.getByTestId('message-search-input'), { target: { value: 'port' } });
    await pastDebounce();

    await screen.findByRole('option');
    expect(screen.queryByText('What search covers')).toBeNull();
    expect(
      screen.getByText(
        'Searches what was said in channels and direct messages, and in Claude Code, Codex and OpenCode conversations. Not tool output.'
      )
    ).toBeInTheDocument();
  });
});
