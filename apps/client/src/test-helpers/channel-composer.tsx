/**
 * A room's composer, wired the way a room wires it.
 *
 * `ChannelComposer` reads its target off `Conversation.Root` and takes the
 * staged files its host shares with that target, because the send has to upload
 * and clear the same batch it took. Both halves come from one call to
 * `useRoomTarget`, so a bench that built them separately would be testing a
 * shape the app never renders.
 *
 * Shared from here rather than duplicated in four suites: two of them live in
 * `widgets/room-view/__tests__` and one lives in the app's own, and all three
 * need the identical three lines.
 *
 * @module test-helpers/channel-composer
 */
import { Conversation } from '@/layers/features/conversation';
import type { RoomWithRoster } from '@/layers/entities/room';
import { ChannelComposer, ROOM_CAPABILITIES, useRoomTarget } from '@/layers/widgets/room-view';

/** What the bench needs to stand a room's composer up. */
interface ChannelComposerBenchProps {
  /** The room the composer writes into. */
  room: RoomWithRoster;
  /** The thread, when this is a thread panel's composer. */
  threadRootId?: string;
  /** Float "Jump back in" over the box while it is empty. */
  offerJumpBackIn?: boolean;
  /** Told when the caret enters and leaves the field. */
  onFocusChange?: (focused: boolean) => void;
  /** Take the caret as soon as the composer exists. */
  focusOnMount?: boolean;
}

/**
 * Mount a room's composer inside the conversation it belongs to.
 *
 * @param props - The room, and whatever the case under test varies.
 */
export function ChannelComposerBench({ room, threadRootId, ...props }: ChannelComposerBenchProps) {
  const { target, attachments } = useRoomTarget({
    room,
    ...(threadRootId === undefined ? {} : { threadRootId }),
  });
  return (
    <Conversation.Root
      surface={room.kind === 'dm' ? 'dm' : 'room'}
      capabilities={ROOM_CAPABILITIES}
      target={target}
      anchor="rail"
    >
      <ChannelComposer
        room={room}
        {...(threadRootId === undefined ? {} : { threadRootId })}
        attachments={attachments}
        {...props}
      />
    </Conversation.Root>
  );
}
