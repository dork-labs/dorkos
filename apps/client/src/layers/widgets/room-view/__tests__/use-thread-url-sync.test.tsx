// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, cleanup, waitFor } from '@testing-library/react';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import { useRoomOpenThreadStore } from '@/layers/entities/room';
import { useThreadUrlSync, type ThreadUrlSync } from '../model/use-thread-url-sync';

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
// `useInPlaceNavigate` reads the router's current location to stamp the in-place
// base, so the mock provides a minimal `useRouter` alongside `useNavigate`.
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useRouter: () => ({ state: { location: { pathname: '/channels', search: { id: 'room-1' } } } }),
}));

afterEach(() => {
  cleanup();
  navigate.mockClear();
  useRoomOpenThreadStore.setState({ open: {} });
});

/** What `navigate` was last asked to make the search params. */
function lastSearch(): Record<string, unknown> {
  const call = navigate.mock.calls.at(-1)?.[0] as {
    search: (prev: Record<string, unknown>) => Record<string, unknown>;
  };
  return call.search({ id: 'room-1' });
}

/** A room entry; `rootId` makes it a reply hanging off that entry. */
function entry(id: string, rootId: string | null = null): RoomEntry {
  return {
    roomId: 'room-1',
    seq: 1,
    id,
    authorId: 'ana',
    kind: 'post',
    body: { text: id },
    mentions: [],
    sessionId: null,
    cascadeRoot: id,
    cascadeDepth: 0,
    parentEntryId: rootId,
    threadRootEntryId: rootId,
    signature: null,
    createdAt: '2026-07-30T10:00:00.000Z',
  } as RoomEntry;
}

/** Drive the hook the way the page does: the open thread comes from the store. */
function sync(urlThreadId: string | undefined, over: Partial<ThreadUrlSync> = {}) {
  return renderHook(
    ({ open }: { open: string | undefined }) =>
      useThreadUrlSync({
        roomId: 'room-1',
        route: '/channels',
        urlThreadId,
        openThreadId: open,
        entries: [],
        historyLoaded: true,
        ...over,
      }),
    { initialProps: { open: undefined as string | undefined } }
  );
}

describe('useThreadUrlSync', () => {
  it('opens the thread named in the URL, and leaves the URL alone doing it', async () => {
    // The regression this exists for: seeding used to run during render, so the
    // write effect read a store that had not been updated yet, decided the URL
    // disagreed, and stripped the very `?thread=` it had just read — a deep
    // link that killed itself on arrival.
    sync('root-1');

    await waitFor(() =>
      expect(useRoomOpenThreadStore.getState().open['room-1']?.rootEntryId).toBe('root-1')
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it('opens the THREAD when the link names one of its replies', async () => {
    // Copying a link off a reply is the ordinary way one gets shared, and the
    // id in it is then not a root. Taken literally it drew that reply as though
    // it headed a thread — with no replies under it, because nothing points at
    // a reply — and every send from its composer came back NESTED_THREAD 400.
    const history = [entry('root-1'), entry('reply-9', 'root-1')];
    const { rerender } = sync('reply-9', { entries: history });

    rerender({ open: 'reply-9' });

    await waitFor(() =>
      expect(useRoomOpenThreadStore.getState().open['room-1']?.rootEntryId).toBe('root-1')
    );
  });

  it('resolves the link once the history catches up with it', async () => {
    // The real order on a deep link: the panel is seeded from the URL long
    // before the room's entries land. The resolution has to happen on the load
    // that made it knowable, not only on the render that seeded it.
    const history = [entry('root-1'), entry('reply-9', 'root-1')];
    const { rerender } = renderHook(
      ({ entries, loaded }: { entries: RoomEntry[]; loaded: boolean }) =>
        useThreadUrlSync({
          roomId: 'room-1',
          route: '/channels',
          urlThreadId: 'reply-9',
          openThreadId: useRoomOpenThreadStore.getState().open['room-1']?.rootEntryId,
          entries,
          historyLoaded: loaded,
        }),
      { initialProps: { entries: [] as RoomEntry[], loaded: false } }
    );

    // Seeded, but nothing loaded yet — it stays exactly as the link said.
    await waitFor(() =>
      expect(useRoomOpenThreadStore.getState().open['room-1']?.rootEntryId).toBe('reply-9')
    );

    // Let the seeded id settle into a render FIRST, so that when the history
    // lands it is the only thing that changed. Without this the open id is
    // still moving on the same pass and would re-run the effect by itself,
    // which would let a missing `entries` dependency pass unnoticed.
    rerender({ entries: [], loaded: false });

    rerender({ entries: history, loaded: true });

    await waitFor(() =>
      expect(useRoomOpenThreadStore.getState().open['room-1']?.rootEntryId).toBe('root-1')
    );
  });

  it('leaves an id no loaded history knows alone, so an orphan stays an orphan', async () => {
    // The root paged out of the window. The panel already says the honest thing
    // about that; rewriting the id here would turn it into a different lie.
    const { rerender } = sync('gone-1', { entries: [entry('root-1')] });

    await waitFor(() =>
      expect(useRoomOpenThreadStore.getState().open['room-1']?.rootEntryId).toBe('gone-1')
    );
    rerender({ open: 'gone-1' });

    // Held exactly as it arrived, and the URL is left alone with it.
    expect(useRoomOpenThreadStore.getState().open['room-1']?.rootEntryId).toBe('gone-1');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('writes the open thread into the URL', async () => {
    renderHook(() =>
      useThreadUrlSync({
        roomId: 'room-1',
        route: '/channels',
        urlThreadId: undefined,
        openThreadId: 'root-1',
        entries: [],
        historyLoaded: true,
      })
    );

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(lastSearch()).toEqual({ id: 'room-1', thread: 'root-1' });
    expect(navigate.mock.calls.at(-1)?.[0]).toMatchObject({ to: '/channels' });
    // Reading a thread is not navigating: Back should leave the room, not walk
    // through every thread somebody glanced at.
    expect(navigate.mock.calls.at(-1)?.[0]).toMatchObject({ replace: true });
  });

  it('writes it into the address the room is being READ at, not always /channels', async () => {
    // Home IS the #team room (team-room-home spec D3.2). Mirroring its open
    // thread to `/channels` would carry the reader off the page they are on
    // every time they opened one.
    renderHook(() =>
      useThreadUrlSync({
        roomId: 'room-1',
        route: '/',
        urlThreadId: undefined,
        openThreadId: 'root-1',
        entries: [],
        historyLoaded: true,
      })
    );

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(navigate.mock.calls.at(-1)?.[0]).toMatchObject({ to: '/', replace: true });
    expect(lastSearch()).toMatchObject({ thread: 'root-1' });
  });

  it('clears the param when the panel closes', async () => {
    const { rerender } = renderHook(
      ({ open }: { open: string | undefined }) =>
        useThreadUrlSync({
          roomId: 'room-1',
          route: '/channels',
          urlThreadId: 'root-1',
          openThreadId: open,
          entries: [],
          historyLoaded: true,
        }),
      { initialProps: { open: 'root-1' as string | undefined } }
    );

    rerender({ open: undefined });

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(lastSearch()).toEqual({ id: 'room-1', thread: undefined });
  });

  it('does not re-open a thread the reader just closed', async () => {
    // The URL is read once per room on the way in. Without that, closing the
    // panel would be undone by the `?thread=` still sitting in the address bar
    // — the reader would press the close button and watch nothing happen.
    //
    // The props follow what the page actually feeds this hook: `openThreadId`
    // comes from the store, so it is `undefined` on the way in, becomes the
    // seeded thread, and goes back to `undefined` when the panel closes.
    const { rerender } = sync('root-1');

    await waitFor(() =>
      expect(useRoomOpenThreadStore.getState().open['room-1']?.rootEntryId).toBe('root-1')
    );
    rerender({ open: 'root-1' });

    useRoomOpenThreadStore.getState().closeThread('room-1');
    rerender({ open: undefined });

    // The param is cleared, and the store is NOT seeded a second time.
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(lastSearch()).toEqual({ id: 'room-1', thread: undefined });
    expect(useRoomOpenThreadStore.getState().open['room-1']).toBeUndefined();
  });

  it('says nothing at all when no room is open', () => {
    renderHook(() =>
      useThreadUrlSync({
        roomId: null,
        route: '/channels',
        urlThreadId: undefined,
        openThreadId: undefined,
        entries: [],
        historyLoaded: true,
      })
    );

    expect(navigate).not.toHaveBeenCalled();
  });
});
