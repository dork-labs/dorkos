/**
 * @vitest-environment jsdom
 *
 * The dirty-main warning and its two operator actions (spec `project-rooms`
 * §3.10).
 *
 * What this pins is mostly about restraint: it draws nothing for a healthy
 * room, it never discards anything it was not handed by name, and it asks
 * before it destroys.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomMainStatus, RoomRepoStatus } from '@dorkos/shared/room-repo';
import { roomKeys } from '@/layers/entities/room';
import { TransportProvider } from '@/layers/shared/model';
import { RoomMainWarning } from '../ui/RoomMainWarning';

const ROOM_ID = 'room-1';

/** A status answer whose `main` half is the part under test. */
function statusWith(main: RoomMainStatus): RoomRepoStatus {
  return {
    mainCommit: 'a'.repeat(40),
    mainCommittedAt: '2026-08-29T09:00:00.000Z',
    main,
    branches: [],
    strandedWorktrees: [],
    size: { usedBytes: 10, maxRepoBytes: 500, maxFileBytes: 50 },
  };
}

/** A room whose own copy somebody has written in from outside DorkOS. */
function dirtyRoom(): Transport {
  const transport = createMockTransport();
  transport.readRoomRepoStatus = vi.fn().mockResolvedValue(
    statusWith({
      branch: 'main',
      dirty: true,
      strays: [
        { path: 'ROOM.md', kind: 'modified' },
        { path: 'notes/scratch.md', kind: 'untracked' },
      ],
      strayCount: 2,
    })
  );
  transport.repairRoomMain = vi
    .fn()
    .mockResolvedValue({ action: 'commit', commit: 'b'.repeat(40), paths: 2, clean: true });
  return transport;
}

function renderWarning(transport: Transport) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <RoomMainWarning roomId={ROOM_ID} />
      </TransportProvider>
    </QueryClientProvider>
  );
  // Handed back so a test can make the room answer differently while the panel
  // is open, which is the one thing this component cannot cause for itself.
  return queryClient;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('the warning', () => {
  it('draws nothing for a room whose files are as DorkOS left them', async () => {
    const transport = createMockTransport();
    transport.readRoomRepoStatus = vi
      .fn()
      .mockResolvedValue(statusWith({ branch: 'main', dirty: false, strays: [], strayCount: 0 }));
    renderWarning(transport);

    await waitFor(() => expect(transport.readRoomRepoStatus).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('draws nothing for a room with no files of its own', async () => {
    // Most rooms are conversations. The default mock refuses with
    // ROOM_HAS_NO_REPO, which is an answer rather than a failure — nothing is
    // drawn, and nothing is retried or logged.
    renderWarning(createMockTransport());

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says so when it could not find out, rather than drawing the same nothing as a clean room', async () => {
    const transport = createMockTransport();
    transport.readRoomRepoStatus = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('no git here'), { code: 'ROOM_REPO_GIT_UNAVAILABLE', status: 409 })
      );
    renderWarning(transport);

    // Drawing nothing would be indistinguishable from "everything is fine" —
    // and a save refused MAIN_CHECKOUT_DIRTY tells a person in so many words
    // that "the warning above the files says how", which would be pointing at
    // an empty space.
    expect(
      await screen.findByText(/couldn’t check whether this room’s files are in order/)
    ).toBeInTheDocument();
  });

  it('names the changes it found, so a person can recognise them', async () => {
    renderWarning(dirtyRoom());

    expect(
      await screen.findByText(/Somebody changed this room's files outside DorkOS/)
    ).toBeInTheDocument();
    expect(screen.getByText('ROOM.md')).toBeInTheDocument();
    expect(screen.getByText('notes/scratch.md')).toBeInTheDocument();
    expect(screen.getByText(/Nobody can save a file here/)).toBeInTheDocument();
  });

  it('says how many it is not showing when there are more than it lists', async () => {
    const transport = createMockTransport();
    transport.readRoomRepoStatus = vi.fn().mockResolvedValue(
      statusWith({
        branch: 'main',
        dirty: true,
        strays: [{ path: 'ROOM.md', kind: 'modified' }],
        strayCount: 4_000,
      })
    );
    renderWarning(transport);

    expect(await screen.findByText(/and 3,?999 more/)).toBeInTheDocument();
  });

  it('offers no repair for a checkout somebody left on another branch', async () => {
    const transport = createMockTransport();
    transport.readRoomRepoStatus = vi
      .fn()
      .mockResolvedValue(statusWith({ branch: 'wip', dirty: true, strays: [], strayCount: 0 }));
    renderWarning(transport);

    // DorkOS does not check out over a branch it did not move, in case there is
    // work on it — so the warning says what happened and offers no button that
    // would be refused.
    expect(await screen.findByText(/on wip instead of main/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Keep them all' })).not.toBeInTheDocument();
  });
});

describe('the two ways out', () => {
  it('keeps everything without being handed a list', async () => {
    const transport = dirtyRoom();
    renderWarning(transport);

    fireEvent.click(await screen.findByRole('button', { name: 'Keep them all' }));

    await waitFor(() =>
      expect(transport.repairRoomMain).toHaveBeenCalledWith(ROOM_ID, { action: 'commit' })
    );
  });

  it('discards nothing until something is ticked', async () => {
    renderWarning(dirtyRoom());

    // The irreversible action is the one that has to be aimed. Nothing ticked
    // is not "discard everything"; it is not an action at all.
    expect(await screen.findByRole('button', { name: 'Discard…' })).toBeDisabled();
  });

  it('asks before discarding, and then names exactly the files that were ticked', async () => {
    const transport = dirtyRoom();
    transport.repairRoomMain = vi
      .fn()
      .mockResolvedValue({ action: 'discard', commit: null, paths: 1, clean: false });
    renderWarning(transport);

    fireEvent.click(await screen.findByLabelText('notes/scratch.md'));
    fireEvent.click(screen.getByRole('button', { name: 'Discard 1' }));

    expect(await screen.findByText(/cannot be brought back/)).toBeInTheDocument();
    expect(transport.repairRoomMain).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Yes, discard' }));
    await waitFor(() =>
      expect(transport.repairRoomMain).toHaveBeenCalledWith(ROOM_ID, {
        action: 'discard',
        paths: ['notes/scratch.md'],
      })
    );
  });

  it('takes the question away when the change it was about is gone', async () => {
    const transport = dirtyRoom();
    const queryClient = renderWarning(transport);

    fireEvent.click(await screen.findByLabelText('notes/scratch.md'));
    fireEvent.click(screen.getByRole('button', { name: 'Discard 1' }));
    expect(await screen.findByText(/cannot be brought back/)).toBeInTheDocument();

    // The list is re-read while this panel is open — somebody fixes their own
    // terminal edit, a merge lands — and the change this question was about is
    // no longer one of them. Left standing over nothing, the button sent
    // `paths: []`, which the schema refuses as a 400 nobody wrote copy for.
    transport.readRoomRepoStatus = vi.fn().mockResolvedValue(
      statusWith({
        branch: 'main',
        dirty: true,
        strays: [{ path: 'ROOM.md', kind: 'modified' }],
        strayCount: 1,
      })
    );
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: roomKeys.repoStatus(ROOM_ID) });
    });

    await waitFor(() =>
      expect(screen.queryByText(/cannot be brought back/)).not.toBeInTheDocument()
    );
    expect(screen.queryByRole('button', { name: 'Yes, discard' })).not.toBeInTheDocument();
  });

  it('says who may do it when this person may not', async () => {
    const transport = dirtyRoom();
    transport.repairRoomMain = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('Only you can decide'), { code: 'OPERATOR_ONLY', status: 403 })
      );
    renderWarning(transport);

    fireEvent.click(await screen.findByRole('button', { name: 'Keep them all' }));

    expect(
      await screen.findByText(/Only the person who owns this DorkOS can decide/)
    ).toBeInTheDocument();
  });
});
