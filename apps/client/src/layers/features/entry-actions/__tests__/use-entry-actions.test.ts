// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import type { AuthorRef, RoomEntry } from '@dorkos/shared/room-schemas';
import {
  threadDraftKey,
  useComposerFocusStore,
  useRoomDraftStore,
  useRoomOpenThreadStore,
} from '@/layers/entities/room';
import { useEntryActions } from '../model/use-entry-actions';

const VIEWER = 'author-you';

const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }));

afterEach(() => {
  cleanup();
  toastSuccess.mockClear();
  toastError.mockClear();
  useRoomDraftStore.setState({ drafts: {} });
  useComposerFocusStore.setState({ focusRequests: {} });
  useRoomOpenThreadStore.setState({ open: {} });
});

function entry(overrides: Partial<RoomEntry> = {}): RoomEntry {
  return {
    roomId: 'room-1',
    seq: 1,
    id: 'entry-1',
    authorId: 'ana',
    kind: 'post',
    body: { text: 'why is the build slow?' },
    mentions: [],
    sessionId: null,
    cascadeRoot: 'entry-1',
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: '2026-07-26T10:00:00.000Z',
    ...overrides,
  };
}

function author(overrides: Partial<AuthorRef> = {}): AuthorRef {
  return { id: 'ana', kind: 'agent', displayName: 'Ana', handle: 'ana', ...overrides };
}

/**
 * The actions one entry offers.
 *
 * `author` is a required key rather than a defaulted parameter: passing
 * `undefined` positionally would silently take a default instead, which is the
 * exact case the "has left the room" test is about.
 */
function actionsFor(
  target: RoomEntry,
  options: {
    author: AuthorRef | undefined;
    viewerAuthorId?: string;
    onViewProfile?: () => void;
  } = { author: author() }
) {
  const { result } = renderHook(() =>
    useEntryActions({
      roomId: 'room-1',
      entry: target,
      author: options.author,
      viewerAuthorId: options.viewerAuthorId ?? VIEWER,
      onViewProfile: options.onViewProfile,
    })
  );
  return result;
}

describe('useEntryActions — the action set', () => {
  it('offers reply, copy and mention, in the order every rendering draws', () => {
    // Pins the order rather than just the membership, because the LEFTMOST
    // positions are reserved for reactions: they arrive by being prepended, and
    // this is what catches a change that reorders the three instead.
    //
    // Spelled out rather than compared against `ENTRY_ACTION_ORDER`. The hook now
    // BUILDS its output by mapping over that constant, so asserting against it
    // would compare the constant with itself and pass through any reordering.
    expect(actionsFor(entry()).current.map((a) => a.id)).toEqual(['reply', 'copy', 'mention']);
  });

  it('adds View profile LAST, so no finger already trained on this row moves', () => {
    // Position is the contract here, not just membership: `room-entry-actions`
    // walks this row with arrow keys and counts presses to reach Reply, and the
    // profile action arrived after every other command had been there for
    // months. It is also withheld entirely when the caller cannot name the
    // author to the roster — see `EntryActionsInput.onViewProfile`.
    const withProfile = actionsFor(entry(), { author: author(), onViewProfile: () => {} });

    expect(withProfile.current.map((a) => a.id)).toEqual(['reply', 'copy', 'mention', 'profile']);
    expect(withProfile.current.at(-1)?.label).toBe('View profile');
  });

  it('opens the thread panel on the entry itself when that entry heads its own thread', () => {
    actionsFor(entry({ id: 'root-1' })).current[0]!.run();

    expect(useRoomOpenThreadStore.getState().open['room-1']?.rootEntryId).toBe('root-1');
  });

  it('asks the panel’s composer for the caret, because reply means write', () => {
    // Both routes to the one composer, because it may or may not exist yet.
    // The flag on the open covers the press that MOUNTS the box; the focus
    // request covers the press made while the panel is already open — most
    // often on a reply inside it, where the open is a no-op and a request is
    // the only thing that can move the caret.
    actionsFor(entry({ id: 'root-1' })).current[0]!.run();

    expect(useRoomOpenThreadStore.getState().open['room-1']?.focusComposer).toBe(true);
    expect(useComposerFocusStore.getState().focusRequests[threadDraftKey('room-1', 'root-1')]).toBe(
      1
    );
    // And nothing asked the ROOM's composer for anything.
    expect(useComposerFocusStore.getState().focusRequests['room-1']).toBeUndefined();
  });

  it('still moves the caret when the panel is already open on that thread', () => {
    // Answering a reply from inside the panel: `openThread` returns unchanged
    // state, so the open cannot be what focuses — and without the request the
    // reader would press reply and watch nothing happen.
    const result = actionsFor(entry({ id: 'root-1' }));
    result.current[0]!.run();
    result.current[0]!.run();

    expect(useComposerFocusStore.getState().focusRequests[threadDraftKey('room-1', 'root-1')]).toBe(
      2
    );
  });

  it('aims a reply to a REPLY at the thread root, not at the reply', () => {
    // The server refuses a reply to a reply (NESTED_THREAD), and the timeline
    // only ever draws one level — so answering any line inside a thread has to
    // mean answering the thread. Nothing here may surface an error for it.
    actionsFor(
      entry({ id: 'reply-9', parentEntryId: 'root-1', threadRootEntryId: 'root-1' })
    ).current[0]!.run();

    expect(useRoomOpenThreadStore.getState().open['room-1']?.rootEntryId).toBe('root-1');
  });

  it('falls back to the parent pointer when only that one is set', () => {
    // The two pointers are written together, but that is not yet a database
    // constraint — a row carrying one without the other still has to land in
    // the right thread rather than starting a new one.
    actionsFor(entry({ id: 'reply-9', parentEntryId: 'root-1' })).current[0]!.run();

    expect(useRoomOpenThreadStore.getState().open['room-1']?.rootEntryId).toBe('root-1');
  });

  it('copies the message text, and says it did', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    actionsFor(entry({ body: { text: 'the cache is cold' } })).current[1]!.run();

    expect(writeText).toHaveBeenCalledWith('the cache is cold');
    // Two of the three ways to reach this close on the click, so the surface
    // itself has nowhere to show the answer — `useCopyFeedback`'s toast
    // fallback, the one pattern every such site uses.
    await vi.waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Copied'));
  });

  it('says so when the clipboard refuses', async () => {
    // A clipboard write can be denied outright by permissions. Swallowing that
    // leaves a reader who pressed Copy believing they have the text.
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    actionsFor(entry()).current[1]!.run();

    await vi.waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Couldn't copy to the clipboard")
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('writes the verified handle into the draft, not the display name', () => {
    // A display name routinely contains spaces, which the mention pattern
    // cannot span — inserting one would address nobody and say nothing about it.
    actionsFor(entry(), {
      author: author({ displayName: 'Ana Rivera', handle: 'ana-rivera' }),
    }).current[2]!.run();

    expect(useRoomDraftStore.getState().drafts['room-1']).toBe('@ana-rivera ');
  });

  it('keeps what is already typed and asks for the caret', () => {
    useRoomDraftStore.getState().set('room-1', 'good point');

    actionsFor(entry()).current[2]!.run();

    expect(useRoomDraftStore.getState().drafts['room-1']).toBe('good point @ana ');
    expect(useComposerFocusStore.getState().focusRequests['room-1']).toBe(1);
  });

  it('does not offer to mention an author no @ can reach', () => {
    const ids = actionsFor(entry(), { author: author({ handle: undefined }) }).current.map(
      (a) => a.id
    );

    expect(ids).toEqual(['reply', 'copy']);
  });

  it('does not offer to mention an author who has left the room', () => {
    expect(actionsFor(entry(), { author: undefined }).current.map((a) => a.id)).toEqual([
      'reply',
      'copy',
    ]);
  });

  it('does not offer the reader themselves', () => {
    const own = author({ id: VIEWER, displayName: 'You' });

    expect(
      actionsFor(entry({ authorId: VIEWER }), { author: own }).current.map((a) => a.id)
    ).toEqual(['reply', 'copy']);
  });

  it('still asks for the caret on a second reply press', () => {
    const result = actionsFor(entry());
    result.current[0]!.run();
    result.current[0]!.run();

    expect(useRoomOpenThreadStore.getState().open['room-1']?.focusComposer).toBe(true);
  });
});
