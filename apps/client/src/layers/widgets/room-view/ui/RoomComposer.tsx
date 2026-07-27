import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { ChatInput } from '@/layers/features/chat';
import { roomDisplayTitle, usePostToRoom, type RoomWithRoster } from '@/layers/entities/room';

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
 * the post triggers — would ever see it. The field still empties the moment you
 * press Enter, the way session chat's does, so the next sentence can be typed
 * into an empty box while the first is in the air. A refusal puts the words
 * back rather than swallowing them.
 *
 * Mount one per room (`key={room.id}`). The draft and the in-flight latch are
 * local state, and a draft belongs to the room it was typed in.
 */
export function RoomComposer({ room }: RoomComposerProps) {
  const [text, setText] = useState('');
  const post = usePostToRoom();
  // What is in the air, not merely THAT something is. Both guards against a
  // double send — `post.isPending` and the cleared field — are state, and state
  // is a render behind: two Enters before that render both read the same stale
  // text and both post it. Measured; it sent the message twice.
  //
  // Holding the body rather than a boolean is what keeps this from swallowing a
  // real message: someone typing a second sentence while the first is still in
  // flight is sending something different, and a bare in-flight flag would drop
  // it with no toast, no clear and no send.
  const inFlightTextRef = useRef<string | null>(null);

  const handleSubmit = () => {
    const body = text.trim();
    if (body === '' || room.archived || body === inFlightTextRef.current) return;
    inFlightTextRef.current = body;
    // Empty the box now, not on the 202. Clearing on success wipes whatever is
    // in the field at THAT moment, which is the follow-up sentence typed during
    // the round trip, not the message that was sent.
    setText('');
    post.mutate(
      { roomId: room.id, text: body },
      {
        onError: (err) => {
          // Give the words back. If a follow-up is already in the box, put the
          // refused message above it rather than picking which of the two to
          // destroy — nothing typed here is ever thrown away by this composer.
          setText((current) => (current === '' ? body : `${body}\n${current}`));
          toast.error(err.message || 'Could not send that message');
        },
        onSettled: () => {
          if (inFlightTextRef.current === body) inFlightTextRef.current = null;
        },
      }
    );
  };

  return (
    <div className="border-t p-3">
      <ChatInput
        value={text}
        onChange={setText}
        onSubmit={handleSubmit}
        isStreaming={false}
        // Deliberately NOT gated on the post being in flight. Sending is a
        // fire-and-forget 202, and closing the submit path for its duration
        // would block the second sentence of anyone who types faster than the
        // network — silently, since a refused submit says nothing. The latch
        // above is what makes one Enter one message.
        canSubmit={!room.archived}
        canSubmitReason={
          room.archived
            ? 'This conversation is archived. You can read it, but not add to it.'
            : undefined
        }
        placeholder={`Message ${roomDisplayTitle(room)}…`}
      />
    </div>
  );
}
