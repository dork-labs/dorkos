/**
 * The machinery `RoomThreadShowcases` shares — a `Transport` fixture and a
 * demo wrapper for `RoomThreadPanel`.
 *
 * `RoomThreadPanel` finds its own root and replies inside the `entries` prop
 * it is handed, so posting through the real composer only has to land the new
 * entry back into that array — there is no SSE stream to fake, because the
 * panel does not own one; whatever mounts it does. That is also why this
 * fixture, unlike `rooms-showcase-helpers`, keeps its mutable state in the
 * DEMO's React state rather than closed over inside the transport: the panel
 * re-renders off the `entries` prop, not off a query this fixture could
 * invalidate.
 *
 * @module dev/showcases/room-thread-showcase-helpers
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { PostToRoomResponse } from '@dorkos/shared/room-schemas';
import type { RoomEntry, RoomWithRoster } from '@/layers/entities/room';
import { TransportProvider } from '@/layers/shared/model';
import { Conversation } from '@/layers/features/conversation';
import { ROOM_CAPABILITIES, RoomThreadPanel } from '@/layers/widgets/room-view';
import { createPlaygroundTransport } from '../playground-transport';
import { threadEntry, THREAD_REACTION_FREQUENTS, THREAD_ROOM } from './room-thread-showcase-data';

/**
 * A transport that answers a thread panel's reads and writes against one
 * room held by the caller.
 *
 * @param room - The room `getRoom` answers with.
 * @param onEntryPosted - Called with the new entry whenever `postToRoom` or
 *   `replyInThread` is asked to send one — the caller decides where it lands.
 */
function createThreadFixtureTransport(
  room: RoomWithRoster,
  onEntryPosted: (entry: RoomEntry) => void
): Transport {
  const base = createPlaygroundTransport();

  const post = (
    authorId: string,
    text: string,
    threadRootId: string | null
  ): Promise<PostToRoomResponse> => {
    const entry = threadEntry(text, {
      authorId,
      parentEntryId: threadRootId,
      threadRootEntryId: threadRootId,
    });
    onEntryPosted(entry);
    return Promise.resolve({ accepted: true, entryId: entry.id, seq: entry.seq });
  };

  const handlers: Partial<Record<keyof Transport, unknown>> = {
    getRoom: () => Promise.resolve(structuredClone(room)),
    listRoomEntries: () => Promise.resolve([]),
    postToRoom: (_roomId: string, req: { text: string }) =>
      post(room.viewerAuthorId ?? 'author-you', req.text, null),
    replyInThread: (_roomId: string, req: { rootEntryId: string; text: string }) =>
      post(room.viewerAuthorId ?? 'author-you', req.text, req.rootEntryId),
  };

  return new Proxy(base, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop in handlers) return handlers[prop as keyof Transport];
      return Reflect.get(target, prop, receiver);
    },
  });
}

export interface ThreadPanelDemoProps {
  /** The entry `rootEntryId` names. Threaded straight through to the panel. */
  rootEntryId: string;
  /**
   * The room's whole loaded history — same contract as the real panel's
   * `entries` prop. Omit the root itself here (while still naming it in
   * `rootEntryId`) to produce the orphaned-thread state.
   */
  entries: RoomEntry[];
  /** The room to render the panel against. Defaults to the shared bench room. */
  room?: RoomWithRoster;
  /** True while this is the reply-focused open (the composer takes the caret). */
  focusComposer?: boolean;
  /** True when the room's live stream has given up. */
  streamStalled?: boolean;
  /** True for the mobile full-screen push framing. */
  pushed?: boolean;
  /**
   * Replies to append after mount, one array growth at a time — for demos that
   * land a reply from outside the composer (e.g. authored by an agent, to
   * exercise the hand-off arrival). Each entry present here that is not yet in
   * the panel's own state is appended once, in order.
   */
  injected?: RoomEntry[];
}

/**
 * One `RoomThreadPanel`, wired to a fixture so its composer really posts and
 * the reply that comes back really lands in the thread — the same shape
 * `RoomSheetDemo` uses for the room sheet.
 *
 * Bounded to a fixed height because the panel is a flex column meant to sit
 * inside a room's own height; unbounded, it would collapse in the playground's
 * document flow.
 */
export function ThreadPanelDemo({
  rootEntryId,
  entries: initialEntries,
  room = THREAD_ROOM,
  focusComposer = false,
  streamStalled,
  pushed = false,
  injected = [],
}: ThreadPanelDemoProps) {
  const [entries, setEntries] = useState<RoomEntry[]>(initialEntries);
  const transport = useMemo(
    () => createThreadFixtureTransport(room, (entry) => setEntries((prev) => [...prev, entry])),
    [room]
  );
  const client = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    []
  );

  // Appends whatever in `injected` is not yet in `entries`, in order — the
  // caller's own state decides WHEN a reply lands; this just relays it into
  // the panel the same way `postToRoom` above does.
  const landedIds = useRef(new Set<string>());
  useEffect(() => {
    const toLand = injected.filter((entry) => !landedIds.current.has(entry.id));
    if (toLand.length === 0) return;
    for (const entry of toLand) landedIds.current.add(entry.id);
    setEntries((prev) => [...prev, ...toLand]);
  }, [injected]);

  return (
    <TransportProvider transport={transport}>
      <QueryClientProvider client={client}>
        <div
          className="bg-background flex overflow-hidden rounded-md border"
          style={{ height: 480 }}
        >
          {/* The same conversation `RoomSurface` mounts around the panel. */}
          <Conversation.Root surface="room" capabilities={ROOM_CAPABILITIES} anchor="rail">
            <RoomThreadPanel
              room={room}
              rootEntryId={rootEntryId}
              focusComposer={focusComposer}
              entries={entries}
              reactionFrequents={THREAD_REACTION_FREQUENTS}
              streamStalled={streamStalled}
              pushed={pushed}
              historyLoaded
              onClose={() => {}}
            />
          </Conversation.Root>
        </div>
      </QueryClientProvider>
    </TransportProvider>
  );
}
