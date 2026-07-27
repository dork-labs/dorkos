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
 * the post triggers — would ever see it. Two consequences a person can feel:
 * the field clears only once the post is accepted, and a post that fails leaves
 * every word of it where they typed it.
 */
export function RoomComposer({ room }: RoomComposerProps) {
  const [text, setText] = useState('');
  const post = usePostToRoom();
  // The latch that actually stops a double send. `post.isPending` is state, and
  // state is a render behind: two Enters in the same tick both read it as false
  // and both post. Measured — it sent the message twice.
  const inFlightRef = useRef(false);

  const handleSubmit = () => {
    const body = text.trim();
    if (body === '' || room.archived || inFlightRef.current) return;
    inFlightRef.current = true;
    post.mutate(
      { roomId: room.id, text: body },
      {
        onSuccess: () => setText(''),
        // The draft stays put. Whatever the server refused for — an archived
        // room, a dropped connection — retyping the message is not part of it.
        onError: (err) => toast.error(err.message || 'Could not send that message'),
        onSettled: () => {
          inFlightRef.current = false;
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
        // Greys the Send button while the post is in flight; the latch above is
        // what makes one Enter one message. The text stays typeable throughout:
        // the round trip is short, and taking the field away mid-sentence would
        // cost keystrokes.
        canSubmit={!room.archived && !post.isPending}
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
