import { describe, it, expect, beforeEach } from 'vitest';
import { useRoomOpenThreadStore } from '../model/open-thread';

beforeEach(() => useRoomOpenThreadStore.setState({ open: {} }));

/** The store's state object, for comparing identity across a no-op write. */
function held() {
  return useRoomOpenThreadStore.getState().open;
}

describe('useRoomOpenThreadStore', () => {
  it('opens a thread beside its room', () => {
    useRoomOpenThreadStore.getState().openThread('room-1', 'root-1');

    expect(held()['room-1']).toEqual({ rootEntryId: 'root-1', focusComposer: false });
  });

  it('carries the caret request when the reader asked to write', () => {
    useRoomOpenThreadStore.getState().openThread('room-1', 'root-1', true);

    expect(held()['room-1']?.focusComposer).toBe(true);
  });

  it('switches rather than stacking', () => {
    // One value per room, which is what makes clicking another thread's reply
    // row a switch instead of a pile of panels.
    useRoomOpenThreadStore.getState().openThread('room-1', 'root-1');
    useRoomOpenThreadStore.getState().openThread('room-1', 'root-2');

    expect(held()['room-1']?.rootEntryId).toBe('root-2');
  });

  it('does nothing at all when the same thread is opened the same way twice', () => {
    // Clicking the row of the thread you are already reading. Returned
    // unchanged rather than as a fresh object, so it is not a re-render and not
    // a `replace` write to the URL — the mirror effect keys off this value.
    useRoomOpenThreadStore.getState().openThread('room-1', 'root-1');
    const before = held();

    useRoomOpenThreadStore.getState().openThread('room-1', 'root-1');

    expect(held()).toBe(before);
  });

  it('still moves when the same thread is opened to WRITE this time', () => {
    // Reading a thread and then pressing reply in it is a real change: the
    // composer takes the caret. Collapsing it into the no-op above would make
    // the reply button do nothing.
    useRoomOpenThreadStore.getState().openThread('room-1', 'root-1');
    const before = held();

    useRoomOpenThreadStore.getState().openThread('room-1', 'root-1', true);

    expect(held()).not.toBe(before);
    expect(held()['room-1']?.focusComposer).toBe(true);
  });

  it('closes a room’s panel, and says nothing twice', () => {
    useRoomOpenThreadStore.getState().openThread('room-1', 'root-1');
    useRoomOpenThreadStore.getState().closeThread('room-1');
    expect(held()['room-1']).toBeUndefined();

    const before = held();
    useRoomOpenThreadStore.getState().closeThread('room-1');
    expect(held()).toBe(before);
  });

  it('keeps each room’s panel to itself', () => {
    useRoomOpenThreadStore.getState().openThread('room-1', 'root-1');
    useRoomOpenThreadStore.getState().openThread('room-2', 'root-9');

    useRoomOpenThreadStore.getState().closeThread('room-1');

    expect(held()['room-2']?.rootEntryId).toBe('root-9');
  });
});
