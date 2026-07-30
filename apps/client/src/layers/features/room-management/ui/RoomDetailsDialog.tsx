/**
 * The room sheet — one surface for everything about one room.
 *
 * @module features/room-management/ui/RoomDetailsDialog
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { RoomRosterEntry } from '@dorkos/shared/room-schemas';
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
} from '@/layers/shared/ui';
import { RoomLoudnessLine, roomDisplayTitle } from '@/layers/entities/room';
import type { RoomDetailsFocus, RoomDetailsRoom } from '../model/room-details';
import { useRoomDetailsView } from '../model/use-room-details-view';
import { useRoomDetailsWrites } from '../model/use-room-details-writes';
import { AddMembersRow } from './AddMembersRow';
import { RoomDetailsFooter } from './RoomDetailsFooter';
import { RoomDetailsHeader } from './RoomDetailsHeader';
import { RoomMemberList } from './RoomMemberList';
import { RoomMemberRow } from './RoomMemberRow';

interface RoomDetailsDialogProps {
  /** The room this sheet is about, as the caller already holds it. */
  room: RoomDetailsRoom;
  /** Whether the sheet is on screen. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Which entry point opened it, and so which part gets the cursor. */
  focus: RoomDetailsFocus;
}

/**
 * Everything about one room, in one sheet.
 *
 * Its name, its topic, how loud the room is, who is in it, how each agent
 * decides when to reply, how to add another, and how to retire it. All four
 * entry points spec §14.3 names land here — the sidebar row's "Members…", "Add
 * agents…" and "Edit topic…", the open room's header roster, and the empty
 * state that promises it — so there is one place to learn and one place a
 * change lands. It is also the only UI that touches the per-room `responseMode`
 * override, a field the schema has carried since R1 which until now was fixed
 * at join time and changeable only by editing the database.
 *
 * A modal rather than a popover: the sidebar is a drawer on a phone and has to
 * close for a popover anchored to it to be visible, so anything that is a task
 * rather than a glance uses the responsive modal (spec §14.5).
 *
 * **Two doors stay where they are, and that is a decision.** The sidebar row
 * keeps its inline rename, because that gesture already means "rename" there
 * for groups; and it keeps its archive alert, because archiving from a menu
 * over a list of rooms is where you archive the wrong one. This sheet ADDS a
 * second way to each rather than replacing the first. What it does replace
 * outright is the topic dialog: a modal holding one text field, opened from a
 * menu, over a room you are already looking at.
 *
 * **Only agents are managed here.** The room's human member is the person
 * reading — there is no verb for them (spec §15.2), and removing yourself from
 * a room you created would make it invisible with no route back, which is the
 * same reason there is no "Leave".
 */
export function RoomDetailsDialog({ room, open, onOpenChange, focus }: RoomDetailsDialogProps) {
  const view = useRoomDetailsView(room.id, open);
  /**
   * The room as freshly as it is known. The prop is what the caller already had
   * — a sidebar summary, or the open room — so the header draws before the read
   * lands and never flickers through a room with no topic and no age. The read
   * then wins, which is what redraws the badge in front of whoever archived it.
   */
  const detail: RoomDetailsRoom = view.room ?? room;
  const title = roomDisplayTitle(detail);
  const writes = useRoomDetailsWrites({
    roomId: room.id,
    roomKind: detail.kind,
    roomTitle: title,
    agentPathOf: view.agentPathOf,
  });

  /** The member whose removal is waiting to be confirmed, by author id. */
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);
  /**
   * The one member whose loudness scale is open, by author id.
   *
   * One at a time: four expanded rungs plus their consequences is most of a
   * phone screen, and a sheet that can grow to four of them is one nobody can
   * find the bottom of.
   */
  const [expandedMember, setExpandedMember] = useState<string | null>(null);
  /**
   * Whether the picker at the foot of the roster has been opened in place.
   *
   * "Add agents…" opens it already open, which is the whole difference between
   * that door and "Members…" — both land on one sheet, and only the state it
   * opens in says which one was pressed.
   */
  const [addExpanded, setAddExpanded] = useState(focus === 'add');
  /**
   * The banner that says why an archived room's loudness settings are on hold.
   * Every dormant scale points at it, so the sentence is written once and read
   * by whoever needs it rather than repeated on each row.
   */
  const dormantReasonId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const topicRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLElement | null>(null);
  /** Whether the search field has already been handed the cursor. Once only. */
  const searchFocused = useRef(false);

  /**
   * Give the search field the cursor as soon as there IS a field, whoever asked
   * for it.
   *
   * Two paths lead here and one effect serves both, because they are the same
   * request. "Add agents…" opens the picker already expanded, and
   * `onOpenAutoFocus` fires once — before the fleet has been read on a cold
   * start, so the field it wants does not exist yet. Pressing the add row
   * expands it later, and the field usually appears in that same commit.
   *
   * **The `<body>` case is not a slip.** The guard exists so a reader who has
   * already tabbed to something else does not have the cursor yanked back
   * mid-keystroke — and that means somewhere REAL. Expanding the row unmounts
   * the button that was pressed, which drops focus to `<body>`: nobody is
   * anywhere, so there is nothing to take away from them.
   */
  useEffect(() => {
    if (!addExpanded || searchFocused.current) return;
    const field = searchRef.current;
    if (!field) return;
    const content = contentRef.current;
    const active = document.activeElement;
    if (content && active !== document.body && !content.contains(active)) return;
    searchFocused.current = true;
    field.focus();
  }, [addExpanded, view.agents.isLoading, view.agents.isError]);

  const confirmRemoval = (member: RoomRosterEntry) => {
    setPendingRemoval(null);
    writes.removeMember(member);
  };

  /**
   * Escape answers the confirmation first, and only closes the sheet once there
   * is no confirmation to answer.
   *
   * It has to be handled here, on the dialog, rather than on the confirmation
   * itself: Radix listens for Escape on the document in the CAPTURE phase, so
   * it has already decided to close by the time a React handler further down
   * the tree runs, and `stopPropagation` there is too late to matter.
   */
  const handleEscapeKeyDown = (event: globalThis.KeyboardEvent) => {
    if (pendingRemoval === null) return;
    event.preventDefault();
    setPendingRemoval(null);
  };

  /** The field the entry point named, if it named one and it exists yet. */
  const entryPointField = (): HTMLElement | null => {
    if (focus === 'add') return searchRef.current;
    if (focus === 'topic') return topicRef.current;
    return null;
  };

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        className="sm:max-w-md"
        // Focus follows the entry point, and this is the only place that can
        // place it. Radix's default — the first tabbable element, which is the
        // room's own name — is wrong for all four doors.
        //
        // It has to happen HERE and not inside the field. The menu that opened
        // this sheet closes a commit later and restores focus to its own
        // trigger, so any focus a child set on mount is simply overwritten and
        // the reader is left typing into the sidebar. Focus placed by the
        // dialog is inside its focus scope, which Radix defends. The search
        // field may not exist yet on a cold fleet read; the effect above
        // finishes that one.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const content = event.currentTarget as HTMLElement;
          contentRef.current = content;
          (entryPointField() ?? content).focus();
        }}
        onEscapeKeyDown={handleEscapeKeyDown}
        // Nothing here describes the sheet as a whole. Its parts — the room
        // line, each member's row — say what they are where they are, and a
        // sentence at the top summarising a surface the reader is already
        // looking at is the help text this sheet was designed not to need.
        // Radix asks to be told that on purpose rather than assumed.
        aria-describedby={undefined}
      >
        <RoomDetailsHeader
          room={detail}
          participants={view.participants}
          visuals={view.roomVisuals}
          startTopicEditing={focus === 'topic'}
          topicRef={topicRef}
        />

        <ResponsiveDialogBody className="space-y-4">
          {/* An archived room triggers nobody, so the loudness sentence would
              be false there — "Two agents will answer you here" of a room that
              answers nothing. It says the true thing instead, and it is also
              the reason each dormant scale below hands to a screen reader, so
              the sentence has to work as a description of one of them. */}
          {detail.archived ? (
            <p
              id={dormantReasonId}
              className="bg-muted/50 text-muted-foreground rounded-lg px-3 py-2.5 text-xs"
            >
              Nobody is triggered in an archived room, so these settings are on hold. Bring it back
              to change them.
            </p>
          ) : (
            // Only once there is a roster: an empty one is a real answer here
            // — "There is nobody here to answer you" — so drawing this during
            // the read would state something false and then correct itself.
            view.room !== null && <RoomLoudnessLine members={view.members} roomKind={detail.kind} />
          )}

          <RoomMemberList members={view.members} isLoading={view.isLoading} isError={view.isError}>
            {(member) => (
              <RoomMemberRow
                member={member}
                roomKind={detail.kind}
                isReader={member.authorId === view.room?.viewerAuthorId}
                visual={
                  member.author.agentRef
                    ? (view.facesByRef.get(member.author.agentRef) ?? null)
                    : null
                }
                presence={view.working.find((agent) => agent.authorId === member.authorId) ?? null}
                lastSpokeAt={view.lastSpokeByAuthor.get(member.authorId) ?? null}
                expanded={expandedMember === member.authorId}
                onExpandedChange={(next) => setExpandedMember(next ? member.authorId : null)}
                onRungChange={(rung) => writes.setRung(member, rung)}
                savingRung={writes.savingRungFor === member.authorId}
                rungError={
                  writes.rungFailure?.authorId === member.authorId
                    ? writes.rungFailure.message
                    : null
                }
                roomTitle={title}
                // The confirmation lives in the ROW rather than here, because
                // the row is what owns the "…" menu — and where the keyboard
                // lands when that menu closes is a decision only the menu can
                // make. See `RoomMemberRow`.
                onRemoveRequested={() => setPendingRemoval(member.authorId)}
                confirmingRemoval={pendingRemoval === member.authorId}
                onConfirmRemoval={() => confirmRemoval(member)}
                onCancelRemoval={() => setPendingRemoval(null)}
                engagedWindow={view.engagedWindow}
                dormantReasonId={detail.archived ? dormantReasonId : null}
              />
            )}
          </RoomMemberList>

          <AddMembersRow
            expanded={addExpanded}
            onExpand={() => setAddExpanded(true)}
            roster={view.agents}
            exclude={view.isAlreadyIn}
            onSubmit={writes.addAgents}
            emptyRosterMessage={
              view.agents.candidates.length === 0
                ? 'You have not added any agents yet. Add one to put it in here.'
                : 'Every agent you have is already in here.'
            }
            allChosenMessage="Every agent you have is already in here."
            isSubmitting={writes.isAdding}
            inputRef={searchRef}
          />
        </ResponsiveDialogBody>

        <RoomDetailsFooter room={detail} />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
