/**
 * The room sheet — one surface for everything about one room.
 *
 * @module features/room-management/ui/RoomDetailsDialog
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { RoomRosterEntry } from '@dorkos/shared/room-schemas';
import {
  Button,
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
} from '@/layers/shared/ui';
import { useAgentCreationStore, useIsTouchOnly, useProfileDeepLink } from '@/layers/shared/model';
import { RoomLoudnessLine, roomDisplayTitle, type LoudnessPreview } from '@/layers/entities/room';
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
 * reading, so there is still no per-row verb for them in this roster — a
 * "Remove yourself" button beside your own name would ask you to confirm
 * something a menu already does. "Leave" DOES exist now (DOR-1233): it lives
 * in the sidebar row's own menu, one level up from this sheet, which is where
 * the person already goes to archive a room — the two destructive room-level
 * acts share a door rather than this one growing a second.
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
    roomTitle: title,
    agentPathOf: view.agentPathOf,
  });

  const { open: openProfile } = useProfileDeepLink();
  /**
   * What one member's row does when its face and name are pressed, or
   * `undefined` for a member whose profile this client cannot address.
   *
   * The handler is minted here rather than in the row so the row never has to
   * know what a profile is — and so the id it opens on comes from the one join
   * the sheet already holds (`view.profileMemberIdOf`), not from the author id
   * the row happens to be carrying, which belongs to a different id space
   * entirely for an agent.
   */
  const viewProfileHandler = (member: RoomRosterEntry): (() => void) | undefined => {
    const memberId = view.profileMemberIdOf(member);
    return memberId === undefined ? undefined : () => openProfile(memberId);
  };

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
   * The rung the reader is pointing at without having committed it, and whose.
   *
   * Held here because the room line is here: pointing at a rung is a question
   * about one member and the answer is about the whole room, and this is the
   * only thing on screen holding both. Only one scale is open at a time, so one
   * slot is one preview.
   */
  const [preview, setPreview] = useState<LoudnessPreview | null>(null);
  /**
   * Whether the picker at the foot of the roster has been opened in place.
   *
   * "Add agents…" opens it already open, which is the whole difference between
   * that door and "Members…" — both land on one sheet, and only the state it
   * opens in says which one was pressed.
   */
  const [addExpanded, setAddExpanded] = useState(focus === 'add');
  /**
   * A room with no agents in it opens the picker itself.
   *
   * This is the sheet's most consequential moment and it used to be one grey
   * line: a channel with nobody in it does nothing, and the only useful act on
   * this surface is putting somebody in it. Opened rather than offered, because
   * an empty room is not a state anybody chose to be in.
   *
   * Written during render rather than from an effect, the same way
   * `AgentChipPicker` drops a chip whose agent has left: an effect paints one
   * frame of the collapsed row first. It converges — the branch is false on the
   * re-render it causes — and it is one-way, so adding the first agent does not
   * shut the picker again.
   *
   * The archived term looks redundant, because an archived room renders no add
   * row for this to open. It is deliberate: without it an empty archived room
   * arms the picker invisibly, and bringing the room back from the footer would
   * then spring it open on a reader who only asked for the room back.
   */
  if (view.room !== null && !detail.archived && view.agentCount === 0 && !addExpanded)
    setAddExpanded(true);
  /**
   * The banner that says why an archived room's roster and settings are on
   * hold. Every dormant scale points at it, so the sentence is written once and
   * read by whoever needs it rather than repeated on each row.
   */
  const dormantReasonId = useId();
  // Not viewport width: a narrow desktop window is still a desktop, and what is
  // being asked is whether a software keyboard would pop. See `useIsTouchOnly`.
  const isTouchOnly = useIsTouchOnly();
  const searchRef = useRef<HTMLInputElement>(null);
  const topicRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLElement | null>(null);
  /** Whether the search field has already been handed the cursor. Once only. */
  const searchFocused = useRef(false);

  /**
   * Give the search field the cursor as soon as there IS a field, whoever asked
   * for it.
   *
   * Three paths lead here and one effect serves all of them, because they are
   * the same request. "Add agents…" opens the picker already expanded, and
   * `onOpenAutoFocus` fires once — before the fleet has been read on a cold
   * start, so the field it wants does not exist yet. Pressing the add row
   * expands it later, and the field usually appears in that same commit. And a
   * room that turns out to hold no agents opens the picker on its own.
   *
   * **The cursor is only claimed when nobody is on a real control.** The guard
   * exists so a reader who has already gone somewhere else does not have it
   * yanked back mid-keystroke. `<body>` is not somewhere: expanding the row
   * unmounts the button that was pressed and drops focus there, so there is
   * nothing to take away from anybody. Neither is the dialog's own content
   * element, which is where `onOpenAutoFocus` parks the cursor when the door
   * that opened this sheet named no field.
   *
   * That distinction is what stops the third path stealing from the second: a
   * sheet opened at the topic of an empty room expands the picker AND has a
   * live editor holding the cursor, and the editor wins — the reader asked for
   * the topic and would otherwise find themselves typing into "Search agents".
   *
   * **None of it happens where touch is the only pointer.** Not one of the three
   * paths is somebody tapping a text field: they are a menu item, a row, and a
   * room that turned out to be empty. Taking the cursor there pops the software
   * keyboard over the list the reader came to read — the same rule the composer
   * holds to in `focusUnlessTouch`, for the same reason. The field is still
   * there, still the first thing under the heading, and still one tap away; what
   * a touch reader does not get is a keyboard they did not ask for.
   */
  useEffect(() => {
    if (!addExpanded || searchFocused.current || isTouchOnly) return;
    const field = searchRef.current;
    if (!field) return;
    const active = document.activeElement;
    if (active === field) {
      searchFocused.current = true;
      return;
    }
    const content = contentRef.current;
    if (content !== null && active !== document.body && active !== content) return;
    searchFocused.current = true;
    field.focus();
  }, [addExpanded, isTouchOnly, view.agents.isLoading, view.agents.isError]);

  const confirmRemoval = (member: RoomRosterEntry) => {
    setPendingRemoval(null);
    writes.removeMember(member);
  };

  /**
   * Leave for the place agents are made — the same store the sidebar, the
   * command palette and the "+" menu all open.
   *
   * The sheet closes first, and that is the decision rather than an omission.
   * The creation dialog is a modal of its own, and a modal over this one closes
   * BOTH when it is answered: the inner one's dismissal reaches the outer as an
   * interaction from outside it (see `RemoveMemberConfirm`). There is also
   * nothing here worth keeping — this button only exists on a fleet with
   * nobody in it, so the roster behind it is the reader and no one else.
   */
  const startAgentCreation = () => {
    onOpenChange(false);
    useAgentCreationStore.getState().open();
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
    // "Add agents…" asks for the picker, not for a keyboard — see the effect
    // above. "Edit topic…" names one text field and is answered even on touch.
    if (focus === 'add') return isTouchOnly ? null : searchRef.current;
    if (focus === 'topic') return topicRef.current;
    return null;
  };

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        // Capped, the way every other dialog in this app is capped. Neither
        // shell caps itself: a drawer is `bottom-0` with `h-auto`, so a roster
        // of eight agents grows its top off the screen and takes the room's
        // name with it, and a centred dialog does the same at both ends. The
        // body is the one scrolling region inside, so the cap is what turns it
        // into one.
        className="max-h-[85vh] sm:max-w-md"
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
              the sentence has to work as a description of one of them.

              It names the ROSTER as well as the settings, because both are
              held: see the add row and `RoomMemberRow`'s removal verbs below. */}
          {detail.archived ? (
            <p
              id={dormantReasonId}
              className="bg-muted/50 text-muted-foreground rounded-lg px-3 py-2.5 text-xs"
            >
              Nobody is triggered in an archived room, so its members and their settings are on
              hold. Bring it back to change them.
            </p>
          ) : (
            // Only once there is a roster: an empty one is a real answer here
            // — "There is nobody here to answer you" — so drawing this during
            // the read would state something false and then correct itself.
            view.room !== null && (
              <RoomLoudnessLine members={view.members} roomKind={detail.kind} preview={preview} />
            )
          )}

          <RoomMemberList
            members={view.members}
            isLoading={view.isLoading}
            isError={view.isError}
            onRetry={view.retry}
          >
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
                onViewProfile={viewProfileHandler(member)}
                lastSpokeAt={view.lastSpokeByAuthor.get(member.authorId) ?? null}
                expanded={expandedMember === member.authorId}
                onExpandedChange={(next) => setExpandedMember(next ? member.authorId : null)}
                onRungChange={(rung) => writes.setRung(member, rung)}
                onRungPreview={(rung) =>
                  setPreview(rung === null ? null : { authorId: member.authorId, rung })
                }
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

          {/* Not drawn at all in an archived room. Adding names no
              `responseMode`, so the server seeds one — `engaged` for a channel
              — which means remove-then-add here would rewrite a deliberate
              `Silent` into an agent that answers, in the very room the banner
              above says nothing can be changed in. A surface that refuses to
              let you CHANGE a setting must not let you SET one. */}
          {!detail.archived && (
            <AddMembersRow
              expanded={addExpanded}
              onExpand={() => setAddExpanded(true)}
              roster={view.agents}
              exclude={view.isAlreadyIn}
              onSubmit={writes.addAgents}
              // "Add one to put it in here" used to follow the first sentence.
              // The button below says that now, and says it as something you
              // can press rather than as an instruction to go and find it.
              emptyRosterMessage={
                view.agents.candidates.length === 0
                  ? 'You have not added any agents yet.'
                  : 'Every agent you have is already in here.'
              }
              // Only for the empty fleet, which is the one of those two
              // sentences a person can act on — "everyone is already in here"
              // is a finished job, not a dead end.
              emptyRosterAction={
                view.agents.candidates.length === 0 ? (
                  <Button type="button" size="sm" variant="outline" onClick={startAgentCreation}>
                    Create agent
                  </Button>
                ) : undefined
              }
              allChosenMessage="Every agent you have is already in here."
              // Only a one-to-one turns into something else by gaining somebody.
              // A conversation that already holds two is already a group, and a
              // channel is a channel however many agents are in it. The wording
              // is the one the "+" beside Direct messages already uses.
              note={
                detail.kind === 'dm' && view.agentCount === 1
                  ? 'Adding a second agent turns this into a group conversation.'
                  : null
              }
              isSubmitting={writes.isAdding}
              inputRef={searchRef}
            />
          )}
        </ResponsiveDialogBody>

        <RoomDetailsFooter room={detail} />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
