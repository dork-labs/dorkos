/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomFileEntry } from '@dorkos/shared/room-files';
import type { RoomRepoStatus } from '@dorkos/shared/room-repo';
import { TransportProvider } from '@/layers/shared/model';
import { roomKeys } from '@/layers/entities/room';
import { useFileExplorerStore } from '../model/file-explorer-store';
import { ROOM_FILES_REFRESH_INTERVAL_MS } from '../model/room-entry-watch';
import { RoomFilesSection } from '../ui/RoomFilesSection';

const ROOM_ID = 'room-1';
const COMMIT = { sha: 'abc1234', author: 'Kai', at: '2026-08-27T09:00:00.000Z', subject: 'Add it' };

function entry(overrides: Partial<RoomFileEntry> & { name: string }): RoomFileEntry {
  return {
    path: overrides.name,
    kind: 'file',
    size: 1,
    lastCommit: null,
    ...overrides,
  };
}

/** A room whose files answer with this listing at the root. */
function roomWithFiles(entries: RoomFileEntry[]): Transport {
  const transport = createMockTransport();
  transport.readRoomFiles = vi.fn(async (_id: string, path?: string) =>
    path === undefined
      ? { path: '', commit: 'head', entries }
      : { path, commit: 'head', entries: [] }
  );
  return transport;
}

/** A room with no files of its own — the answer nearly every room gives. */
function roomWithoutFiles(): Transport {
  const transport = createMockTransport();
  transport.readRoomFiles = vi.fn().mockRejectedValue(
    Object.assign(new Error('This room does not have files of its own.'), {
      code: 'ROOM_HAS_NO_REPO',
      status: 409,
    })
  );
  return transport;
}

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

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useFileExplorerStore.setState({
    showHidden: false,
    commands: null,
    scopeKey: null,
    expanded: {},
    selectedPath: null,
    scrollTop: 0,
  });
});

afterEach(() => cleanup());

function renderSection(transport: Transport) {
  const queryErrors: unknown[] = [];
  const queryCache = new QueryCache({ onError: (error) => queryErrors.push(error) });
  const queryClient = new QueryClient({
    queryCache,
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <RoomFilesSection roomId={ROOM_ID} />
      </TransportProvider>
    </QueryClientProvider>
  );
  return { ...view, queryClient, queryErrors };
}

describe('RoomFilesSection', () => {
  it('shows nothing at all for a room with no files of its own', async () => {
    const transport = roomWithoutFiles();
    const { queryErrors } = renderSection(transport);

    await waitFor(() => expect(transport.readRoomFiles).toHaveBeenCalled());
    // Not an empty state, not an invitation: most rooms are conversations, and
    // a section explaining its own absence in every one of them is worse than
    // the absence.
    expect(screen.queryByRole('region', { name: 'Room files' })).not.toBeInTheDocument();
    expect(screen.queryByText('Files')).not.toBeInTheDocument();

    // And it does it QUIETLY. This is the ordinary answer for most rooms, so a
    // repo-less room must not register a query failure — that path logs and
    // drops a breadcrumb, which at any scale would mean a bug report full of
    // people opening ordinary rooms.
    await waitFor(() => expect(queryErrors).toHaveLength(0));
  });

  it('still reports a refusal that really is one', async () => {
    const transport = createMockTransport();
    transport.readRoomFiles = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('no git here'), { code: 'ROOM_REPO_GIT_UNAVAILABLE' })
      );
    const { queryErrors } = renderSection(transport);

    await screen.findByText("Couldn't load files.");
    // Reported, not swallowed — and the count is deliberately not pinned: the
    // tree mounts a second reader of the same cache entry, which refetches and
    // fails again. What matters is that this one reaches the error path at all,
    // where "no files of its own" must not.
    expect(queryErrors.length).toBeGreaterThan(0);
    expect((queryErrors[0] as { code?: string }).code).toBe('ROOM_REPO_GIT_UNAVAILABLE');
  });

  it('shows the room its files, with who last touched each one', async () => {
    renderSection(
      roomWithFiles([
        entry({ name: 'ROOM.md', lastCommit: COMMIT }),
        entry({ name: 'notes.md', lastCommit: null }),
      ])
    );

    await screen.findByRole('treeitem', { name: 'ROOM.md' });
    expect(screen.getByRole('region', { name: 'Room files' })).toBeInTheDocument();
    expect(screen.getByText(/^Kai · /)).toBeInTheDocument();
    // Nothing known is an em-dash, never the word "unknown".
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('puts ROOM.md at the top, above the folders', async () => {
    renderSection(
      roomWithFiles([
        entry({ name: 'docs', kind: 'dir', size: 0 }),
        entry({ name: 'zebra.md' }),
        entry({ name: 'ROOM.md' }),
      ])
    );

    await screen.findByRole('treeitem', { name: 'ROOM.md' });
    expect(screen.getAllByRole('treeitem').map((el) => el.getAttribute('aria-label'))).toEqual([
      'ROOM.md',
      'docs',
      'zebra.md',
    ]);
  });

  it('hides the plumbing by default and gives it back on the toggle', async () => {
    const transport = roomWithFiles([
      entry({ name: 'ROOM.md' }),
      entry({ name: '.claude', kind: 'dir', size: 0 }),
      entry({ name: '.env' }),
    ]);
    renderSection(transport);

    await screen.findByRole('treeitem', { name: 'ROOM.md' });
    expect(screen.queryByRole('treeitem', { name: '.claude' })).not.toBeInTheDocument();
    expect(screen.queryByRole('treeitem', { name: '.env' })).not.toBeInTheDocument();

    const before = (transport.readRoomFiles as ReturnType<typeof vi.fn>).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Show hidden files' }));
    expect(await screen.findByRole('treeitem', { name: '.claude' })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: '.env' })).toBeInTheDocument();

    // Without asking the server again. The room API serves its tree whole and
    // the pane does the filtering, so both answers are the same bytes — keying
    // the cache on the toggle would buy a round trip to be handed back what is
    // already in hand.
    expect((transport.readRoomFiles as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before);
  });

  it('gives the tree a definite height to scroll and virtualize within', async () => {
    renderSection(roomWithFiles([entry({ name: 'ROOM.md' })]));

    const tree = await screen.findByRole('tree');
    // The tree is the scroll container — that is where the saved offset is
    // restored to and where the virtualizer measures its window — and it sizes
    // itself with `height: 100%`, which computes to `auto` against an
    // auto-height containing block. So the box around it must have a DEFINITE
    // height: under `max-h-*` the tree grows to its full content height and
    // never scrolls, which silently renders all 300 rows past the
    // virtualization threshold and leaves a restored scroll offset nowhere to
    // land.
    //
    // Asserted on the class rather than on a measurement because jsdom has no
    // layout: `getBoundingClientRect` is all zeroes here, so a computed-height
    // check would pass for `max-h-72` too and prove nothing. Verified for real
    // in a browser; this pin is what stops the two characters drifting back.
    const box = tree.closest('[data-slot="room-files-body"]')!;
    expect(box.className).toContain('h-72');
    expect(box.className).not.toContain('max-h-');
  });

  it('offers nothing that would write to a commit', async () => {
    renderSection(roomWithFiles([entry({ name: 'ROOM.md' })]));

    const row = await screen.findByRole('treeitem', { name: 'ROOM.md' });
    // No drag handle and no context menu: an affordance that would always
    // refuse is worse than no affordance.
    expect(row).not.toHaveAttribute('draggable', 'true');
    fireEvent.contextMenu(row);
    expect(screen.queryByText('Rename')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
  });

  it('looks again when the room stream delivers something, at most once a window', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const transport = roomWithFiles([entry({ name: 'ROOM.md' })]);
    const { queryClient } = renderSection(transport);

    await screen.findByRole('treeitem', { name: 'ROOM.md' });
    const before = (transport.readRoomFiles as ReturnType<typeof vi.fn>).mock.calls.length;

    // What a merge looks like from here: the room's stream merges an entry into
    // the cached history, and this pane treats that as "the files may have moved".
    queryClient.setQueryData(roomKeys.entries(ROOM_ID), [{ seq: 1 }]);
    await vi.advanceTimersByTimeAsync(ROOM_FILES_REFRESH_INTERVAL_MS + 50);

    await waitFor(() =>
      expect(
        (transport.readRoomFiles as ReturnType<typeof vi.fn>).mock.calls.length
      ).toBeGreaterThan(before)
    );
    vi.useRealTimers();
  });

  describe('the pending-work badge (spec §3.9)', () => {
    /** A room's files with nothing unmerged unless a test says otherwise. */
    function repoStatus(overrides: Partial<RoomRepoStatus> = {}): RoomRepoStatus {
      return {
        mainCommit: 'abc1234',
        mainCommittedAt: '2026-08-28T09:00:00.000Z',
        branches: [],
        strandedWorktrees: [],
        size: { usedBytes: 10, maxRepoBytes: 100, maxFileBytes: 5 },
        ...overrides,
      };
    }

    /** The same room, answering a status read as well as a listing. */
    function withStatus(status: RoomRepoStatus): Transport {
      const transport = roomWithFiles([entry({ name: 'ROOM.md' })]);
      transport.readRoomRepoStatus = vi.fn().mockResolvedValue(status);
      return transport;
    }

    it('says nothing when everything is merged', async () => {
      // Quiet by default. A badge that is always there is a badge nobody reads,
      // and there is nothing for a person to do about a room that is in step.
      const transport = withStatus(repoStatus());
      renderSection(transport);

      await screen.findByRole('treeitem', { name: 'ROOM.md' });
      await waitFor(() => expect(transport.readRoomRepoStatus).toHaveBeenCalled());
      expect(screen.queryByText(/Not merged into the room yet/)).not.toBeInTheDocument();
    });

    it('names who is holding work the room has not got', async () => {
      const transport = withStatus(
        repoStatus({
          branches: [
            {
              slug: 'ana-1',
              branch: 'room/ana-1',
              agent: 'Ana',
              authorId: 'author-ana',
              mine: false,
              hasWorktree: true,
              ahead: 2,
              behind: 0,
              dirty: false,
              stranded: true,
            },
          ],
        })
      );
      renderSection(transport);

      const badge = await screen.findByText('Ana');
      expect(badge).toBeInTheDocument();
      // The detail a person needs to decide whether to go and ask, without a
      // second surface to open.
      expect(badge.closest('[data-slot="pending-work-badge"]')).toHaveAttribute(
        'title',
        'Ana: 2 commits not merged'
      );
      // And the same detail without a pointer. A `title` on a non-interactive
      // span is mouse-only, so the counts would otherwise be unreachable by
      // keyboard or screen reader.
      expect(
        screen.getByText('Not merged into the room yet. Ana: 2 commits not merged.')
      ).toBeInTheDocument();
    });

    it('looks again when the room stream delivers something', async () => {
      // A merge is announced in the room as an entry, and the badge is
      // describing the commit that merge produced — so it refreshes off the same
      // signal the tree does, at the same rate. Without this the badge would
      // keep naming somebody who merged twenty minutes ago.
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const transport = withStatus(repoStatus());
      const { queryClient } = renderSection(transport);

      await screen.findByRole('treeitem', { name: 'ROOM.md' });
      await waitFor(() => expect(transport.readRoomRepoStatus).toHaveBeenCalled());
      const before = (transport.readRoomRepoStatus as ReturnType<typeof vi.fn>).mock.calls.length;

      queryClient.setQueryData(roomKeys.entries(ROOM_ID), [{ seq: 1 }]);
      await vi.advanceTimersByTimeAsync(ROOM_FILES_REFRESH_INTERVAL_MS + 50);

      await waitFor(() =>
        expect(
          (transport.readRoomRepoStatus as ReturnType<typeof vi.fn>).mock.calls.length
        ).toBeGreaterThan(before)
      );
      vi.useRealTimers();
    });

    it('stays silent rather than red when the status cannot be read', async () => {
      // The explorer below is asking the same server about the same room and
      // reports a real failure loudly, with a retry. A badge going red for the
      // same cause would be one fault reported twice, in a header where nobody
      // can act on it — and it must never claim everything is merged, which is
      // why it renders nothing rather than a reassuring zero.
      const transport = roomWithFiles([entry({ name: 'ROOM.md' })]);
      transport.readRoomRepoStatus = vi.fn().mockRejectedValue(new Error('no git here'));
      const { queryErrors } = renderSection(transport);

      await screen.findByRole('treeitem', { name: 'ROOM.md' });
      await waitFor(() => expect(transport.readRoomRepoStatus).toHaveBeenCalled());
      expect(screen.queryByText(/Not merged into the room yet/)).not.toBeInTheDocument();
      expect(queryErrors).toHaveLength(0);
    });
  });

  it('says so plainly when the files could not be read for a real reason', async () => {
    const transport = createMockTransport();
    transport.readRoomFiles = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('no git here'), { code: 'ROOM_REPO_GIT_UNAVAILABLE' })
      );
    renderSection(transport);

    // A refusal that is NOT "this room has no files" is a real failure, and the
    // section stays to say so rather than vanishing and leaving a person to
    // wonder where the files went.
    expect(await screen.findByText("Couldn't load files.")).toBeInTheDocument();
  });
});

describe('RoomFilesSection previews', () => {
  it('renders a markdown file in place', async () => {
    const transport = roomWithFiles([entry({ name: 'ROOM.md', lastCommit: COMMIT })]);
    transport.readRoomFileContent = vi.fn().mockResolvedValue({
      path: 'ROOM.md',
      commit: 'head',
      size: 20,
      lastCommit: COMMIT,
      body: { kind: 'text', encoding: 'utf-8', text: '# What we are doing' },
    });
    renderSection(transport);

    fireEvent.click(await screen.findByRole('treeitem', { name: 'ROOM.md' }));
    expect(await screen.findByText('What we are doing')).toBeInTheDocument();
  });

  it('says what a binary file is instead of decoding it', async () => {
    const transport = roomWithFiles([entry({ name: 'logo.png' })]);
    transport.readRoomFileContent = vi.fn().mockResolvedValue({
      path: 'logo.png',
      commit: 'head',
      size: 900,
      lastCommit: null,
      body: { kind: 'binary' },
    });
    renderSection(transport);

    fireEvent.click(await screen.findByRole('treeitem', { name: 'logo.png' }));
    expect(
      await screen.findByText("This isn't text, so there's nothing to show here.")
    ).toBeInTheDocument();
  });

  it('says how big is too big, with the ceiling that was applied', async () => {
    const transport = roomWithFiles([entry({ name: 'dump.json' })]);
    transport.readRoomFileContent = vi.fn().mockResolvedValue({
      path: 'dump.json',
      commit: 'head',
      size: 9_000_000,
      lastCommit: null,
      body: { kind: 'too-large', maxBytes: 5 * 1024 * 1024 },
    });
    renderSection(transport);

    fireEvent.click(await screen.findByRole('treeitem', { name: 'dump.json' }));
    expect(await screen.findByText(/larger than 5\.0 MB/)).toBeInTheDocument();
  });

  it('renders the API`s own sentence for a link it will not follow', async () => {
    const transport = roomWithFiles([entry({ name: 'link', kind: 'symlink', size: 9 })]);
    transport.readRoomFileContent = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('nope'), { code: 'ROOM_FILE_NOT_READABLE', status: 400 })
      );
    renderSection(transport);

    fireEvent.click(await screen.findByRole('treeitem', { name: 'link' }));
    expect(
      await screen.findByText("This isn't a file that can be shown here.")
    ).toBeInTheDocument();
  });
});

describe('the session pane, over the same component', () => {
  it('draws no provenance column, because a filesystem cannot answer it', async () => {
    // The column is a capability of the SOURCE, not of the pane: a directory on
    // disk knows when a file changed and not who changed it, so a session tree
    // must not sprout a row of em-dashes for a question nobody can answer.
    const { createSessionCwdSource } = await import('../model/session-cwd-source');
    const transport = createMockTransport();
    transport.readFileTree = vi.fn().mockResolvedValue({
      entries: [{ name: 'a.ts', path: 'a.ts', type: 'file', size: 1, mtime: 0, isSymlink: false }],
    });
    const source = createSessionCwdSource({ transport, cwd: '/repo' });
    expect(source.provenance).toBe(false);
    expect(source.writable).toBe(true);
    expect(source.preview).toBe('canvas');
    // And the key it caches under is the working directory verbatim — the key
    // the pane used before sources existed, so nobody's open tree was reset.
    expect(source.scopeKey).toBe('/repo');
  });
});
