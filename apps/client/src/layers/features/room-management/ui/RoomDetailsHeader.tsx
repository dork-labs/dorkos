/**
 * The room panel's masthead — its mark, its name, what it is about.
 *
 * @module features/room-management/ui/RoomDetailsHeader
 */
import type { AuthorRef } from '@dorkos/shared/room-schemas';
import type { AgentVisual } from '@/layers/shared/lib';
import { RoomAvatar, useRenameRoom, useSetRoomTopic } from '@/layers/entities/room';
import type { RoomDetailsRoom } from '../model/room-details';
import { InlineTextField } from './InlineTextField';

/** Longest room name the server accepts (`UpdateRoomRequestSchema.title`). */
const MAX_NAME = 200;

/** Longest topic the server accepts (`UpdateRoomRequestSchema.topic`). */
const MAX_TOPIC = 500;

export interface RoomDetailsHeaderProps {
  /** The room this panel is about. */
  room: RoomDetailsRoom;
  /** The roster's authors, when it has been read — only a DM's mark reads them. */
  participants: readonly AuthorRef[] | null;
  /** The faces of the agents in a DM, so its mark is a face and not a letter. */
  visuals: readonly AgentVisual[] | null;
  /**
   * Open the topic straight into its editor — the entry point that used to
   * raise a modal for this one field.
   *
   * Read on mount only, which is what it means for an edit to BEGIN. The panel
   * remounts this header for each press of "Edit topic…" (see `topicEdits` in
   * {@link RoomPanelBody}); the field then takes the cursor itself.
   */
  startTopicEditing: boolean;
}

/**
 * The room's mark, its name and its topic — all three editable in place.
 *
 * **The topic has no dialog of its own any more.** A modal holding one text
 * field, opened from a menu, over a room you are already looking at, is
 * scaffolding: the field belongs on the line that shows the topic. Clearing it
 * removes the topic, because the column is nullable and `""` would be an empty
 * topic the room header then draws as a blank line.
 *
 * **A direct message has no topic and is offered none.** Only a channel is about
 * a subject; a DM is about who is in it (spec `rooms` §14.4), which is also why
 * a DM has no slug.
 *
 * **The surface is named one level up, not by this line.** The visible name is a
 * *control* — its name has to say what pressing it does — so it never named the
 * surface it sits in. In the modal that meant an sr-only title beside it; in the
 * panel it means nothing at all, because the panel's own "Room" tab is what
 * names it.
 *
 * The visible name is the stored `title` rather than the `#slug` the sidebar
 * draws, because this is the field that edits it: a line reading `general` that
 * opens an editor holding `General` is a control lying about its own value. The
 * `#` beside it still says which kind of room this is.
 */
export function RoomDetailsHeader({
  room,
  participants,
  visuals,
  startTopicEditing,
}: RoomDetailsHeaderProps) {
  const renameRoom = useRenameRoom();
  const setTopic = useSetRoomTopic();

  return (
    // Left-aligned at every width, deliberately: a centred field jumps sideways
    // the moment its text changes, and this whole line is a control.
    <div className="text-left">
      <div className="flex min-w-0 items-start gap-3">
        <RoomAvatar
          room={room}
          participants={participants}
          visuals={visuals}
          size="md"
          className="mt-2 md:mt-0.5"
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <InlineTextField
              value={room.title}
              onCommit={(title) => renameRoom.mutate({ roomId: room.id, title })}
              maxLength={MAX_NAME}
              label="Room name"
              // Unreachable today — the server refuses a room with no title —
              // and stated anyway, because the field renders whatever it is
              // handed and a blank line would read as a failure to load.
              placeholder="Untitled"
              className="min-w-0 flex-1 text-lg font-semibold tracking-tight"
            />
            {room.archived && (
              <span className="text-muted-foreground bg-muted shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium">
                Archived
              </span>
            )}
          </div>
          {room.kind === 'channel' && (
            <InlineTextField
              value={room.topic ?? ''}
              onCommit={(topic) =>
                setTopic.mutate({ roomId: room.id, topic: topic === '' ? null : topic })
              }
              maxLength={MAX_TOPIC}
              label="Topic"
              placeholder="Add a topic"
              commitEmpty
              startEditing={startTopicEditing}
              className="text-muted-foreground text-sm"
            />
          )}
          {/* Only drawn when it says something the room's own name does not
              already say. A rename here never reaches Telegram's side (spec
              §3.4, `room-service.ts:317-321`), so this is what keeps that gap
              from being a SILENT one — it shows what the chat is actually
              called over there, without claiming to track it live. */}
          {room.kind === 'channel' &&
            room.bridge?.platformTitle &&
            room.bridge.platformTitle !== room.title && (
              <p className="text-muted-foreground truncate text-xs">
                Telegram calls this chat &ldquo;{room.bridge.platformTitle}&rdquo;
              </p>
            )}
        </div>
      </div>
    </div>
  );
}
