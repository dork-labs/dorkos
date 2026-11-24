/**
 * The router state the ChannelsPage tests drive, kept in a module with no
 * imports so a `vi.mock` factory can read it without an import cycle.
 */
export const route = {
  /** The `?id=` the page reads, swapped between renders to change rooms. */
  roomId: 'room-1',
  /** The `?entry=` the page reads: a search hit's seq, or nothing. */
  entrySeq: undefined as number | undefined,
  /** Whether the viewport is a phone (below 768px, coarse pointer). */
  phone: false,
};
