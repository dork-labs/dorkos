import { ChatInput } from '@/layers/features/chat';
import {
  roomDisplayTitle,
  useRoomDraft,
  useRoomDraftStore,
  usePostToRoom,
  type RoomWithRoster,
} from '@/layers/entities/room';

interface RoomComposerProps {
  /** The room on screen. Its archived flag decides whether posting is offered. */
  room: RoomWithRoster;
}

/**
 * Say something in a room.
 *
 * The same composer session chat uses, so Enter, Shift+Enter and the send
 * button all mean here what they mean there — and so a room does not acquire a
 * second, subtly different text box.
 *
 * The message round-trips: nothing is drawn until the server's copy arrives on
 * the room's stream, which is also the only way a second reader — or the agents
 * the post triggers — would ever see it. The box empties the moment you press
 * Enter, the way session chat's does, so the next sentence can be typed while
 * the first is still in the air.
 *
 * This component holds no draft of its own. The text belongs to the ROOM
 * (`useRoomDraft`), which is what lets it survive being navigated away from,
 * and lets a refused message find its way back to a composer that by then may
 * not exist.
 */
export function RoomComposer({ room }: RoomComposerProps) {
  const text = useRoomDraft(room.id);
  const post = usePostToRoom();

  const handleSubmit = () => {
    if (room.archived) return;
    // Read-and-clear straight from the store, never from `text` above. That
    // render closure is one render stale for a second Enter arriving in the
    // same tick, and would send the same sentence twice; the store has already
    // been emptied by then, so the second submit finds nothing and stops.
    const body = useRoomDraftStore.getState().take(room.id).trim();
    if (body === '') return;
    // No per-call callbacks: a refusal is handled by the mutation itself, which
    // still runs when this composer is gone. See `usePostToRoom`.
    post.mutate({ roomId: room.id, text: body });
  };

  return (
    <div className="border-t p-3">
      <ChatInput
        value={text}
        onChange={(next) => useRoomDraftStore.getState().set(room.id, next)}
        onSubmit={handleSubmit}
        isStreaming={false}
        // Deliberately NOT gated on a post being in flight. Sending is a
        // fire-and-forget 202, and closing the submit path for its duration
        // would block the second sentence of anyone who types faster than the
        // network — silently, since a refused submit says nothing.
        canSubmit={!room.archived}
        canSubmitReason={
          room.archived
            ? 'This conversation is archived. You can read it, but not add to it.'
            : undefined
        }
        // Ties the pending double-Escape wipe to this room, so an arm raised in
        // one conversation cannot clear the draft of the next one.
        contextKey={room.id}
        placeholder={`Message ${roomDisplayTitle(room)}…`}
      />
    </div>
  );
}
