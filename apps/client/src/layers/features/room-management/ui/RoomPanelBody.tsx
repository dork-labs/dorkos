/**
 * One room, whole, in the side panel — its name, its topic, who is in it, and
 * how loud each of them is.
 *
 * @module features/room-management/ui/RoomPanelBody
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { RoomRosterEntry } from '@dorkos/shared/room-schemas';
import { Button, Skeleton } from '@/layers/shared/ui';
import { useAgentCreationStore, useIsTouchOnly, useProfileDeepLink } from '@/layers/shared/model';
import { RoomLoudnessLine, roomDisplayTitle, type LoudnessPreview } from '@/layers/entities/room';
import { useRoomDetailsView } from '../model/use-room-details-view';
import { useRoomDetailsWrites } from '../model/use-room-details-writes';
import { useRoomPanelFocusStore, type RoomPanelFocusRequest } from '../model/room-panel-focus';
import { AddMembersRow } from './AddMembersRow';
import { RoomDetailsFooter } from './RoomDetailsFooter';
import { RoomDetailsHeader } from './RoomDetailsHeader';
import { RoomLimitsSection } from './RoomLimitsSection';
import { RoomMemberList } from './RoomMemberList';
import { RoomMemberRow } from './RoomMemberRow';
import { RoomPanelNotice } from './RoomPanelNotice';

/**
 * What the keyboard can land on inside the roster.
 *
 * A member row's own controls — its profile button, its loudness pill — so
 * tabbing carries on through the people the reader came to see.
 */
const FOCUSABLE = 'button, [href], input, [tabindex="0"]';

/** Which field a pending focus request is owed, and how firmly. */
type PendingSearchFocus =
  /** A press named the picker — take the cursor whatever else has it. */
  | 'asked'
  /** The room turned out to be empty — take it only if nobody is anywhere. */
  | 'offered'
  | null;

interface RoomPanelBodyProps {
  /** The room the route is showing. */
  roomId: string;
}

/**
 * Everything about one room, in the panel beside it.
 *
 * This is the room sheet's composition, re-hosted (spec `one-bar-header` §3.6).
 * What changed is the shape and what that shape makes possible: the panel stays
 * open beside the room, so the roster is readable WHILE you are reading the
 * conversation it belongs to, and every entry point that used to raise a modal
 * over the room now points here ({@link openRoomPanel}).
 *
 * **Only agents are managed here.** The room's human member is the person
 * reading, so there is still no per-row verb for them in this roster. "Leave"
 * lives in the sidebar row's own menu beside "Archive", where the two
 * destructive room-level acts share a door (DOR-1233).
 *
 * Mounted per room by {@link RoomPanel}, which keys it on the id — so switching
 * rooms starts with a clean roster rather than the last room's expanded scale
 * and half-typed search.
 *
 * @param props - The room this panel is about.
 */
export function RoomPanelBody({ roomId }: RoomPanelBodyProps) {
  const view = useRoomDetailsView(roomId, true);
  const detail = view.room;
  /**
   * The room the way it is spoken — `#general`, not `General`.
   *
   * What every sentence ABOUT the room uses: the removal confirmation, the
   * toasts the writes raise. The header is the exception and edits the stored
   * `title` itself, because a line reading `general` that opens an editor
   * holding `General` is a control lying about its own value.
   */
  const spokenTitle = detail === null ? '' : roomDisplayTitle(detail);
  const writes = useRoomDetailsWrites({
    roomId,
    roomTitle: spokenTitle,
    agentPathOf: view.agentPathOf,
  });

  const { open: openProfile } = useProfileDeepLink();
  /**
   * What one member's row does when its face and name are pressed, or
   * `undefined` for a member whose profile this client cannot address.
   *
   * The handler is minted here rather than in the row so the row never has to
   * know what a profile is — and so the id it opens on comes from the one join
   * the panel already holds (`view.profileMemberIdOf`), not from the author id
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
   * phone screen, and a panel that can grow to four of them is one nobody can
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
  /** Whether the picker at the foot of the roster has been opened in place. */
  const [addExpanded, setAddExpanded] = useState(false);
  /**
   * How many times the topic has been asked for.
   *
   * The inline field starts an edit on MOUNT, which is all a modal ever needed —
   * it was mounted by the press. This panel outlives the press, so "Edit topic…"
   * pressed a second time has to produce a second editor, and the count is what
   * remounts the header to give it one.
   */
  const [topicEdits, setTopicEdits] = useState(0);

  /**
   * A room with no agents in it opens the picker itself.
   *
   * A channel with nobody in it does nothing, and the only useful act on this
   * surface is putting somebody in it. Opened rather than offered, because an
   * empty room is not a state anybody chose to be in.
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
  const wantSearchFocus = useRef<PendingSearchFocus>(null);
  const [pickerOpenedItself, setPickerOpenedItself] = useState(false);
  if (detail !== null && !detail.archived && view.agentCount === 0 && !addExpanded) {
    setAddExpanded(true);
    setPickerOpenedItself(true);
  }
  // The cursor half of the same decision, in an effect because a ref may not be
  // written during render. `??=`: a door that ASKED for the picker outranks a
  // picker that opened itself, and this must not quietly downgrade it.
  useEffect(() => {
    if (pickerOpenedItself) wantSearchFocus.current ??= 'offered';
  }, [pickerOpenedItself]);
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const rosterRef = useRef<HTMLDivElement>(null);

  /**
   * Answer whichever part of the panel the press named.
   *
   * The request is taken as it is answered, so a remount — switching rooms and
   * back — does not act on a press from five minutes ago.
   *
   * Subscribed to rather than selected into a render: the panel never DRAWS a
   * request, it acts on one, and an external system's events belong in a
   * subscription. The value present at mount is answered too, since a press
   * usually lands before the panel it names has mounted.
   */
  const wantRosterFocus = useRef(false);
  useEffect(() => {
    const answer = (request: RoomPanelFocusRequest | null) => {
      // A request names its room, so the panel a sidebar press is navigating AWAY
      // from leaves it alone and the one arriving answers it.
      if (request === null || request.roomId !== roomId) return;
      useRoomPanelFocusStore.getState().consume();
      if (request.focus === 'add') {
        setAddExpanded(true);
        // Asked for, so it outranks whatever holds the cursor — the press came
        // from a menu that is about to restore focus to its own trigger.
        wantSearchFocus.current = 'asked';
        return;
      }
      if (request.focus === 'topic') {
        setTopicEdits((edits) => edits + 1);
        return;
      }
      // **"Members" moves the keyboard, not only the eye.** The press is often a
      // keyboard one — the chip is in the bar's tab order — and a panel that
      // opens off to the right with focus left behind on the chip is a door only
      // a mouse can walk through. Answered below, once there is something to land
      // on: the press usually arrives before the roster has been read.
      wantRosterFocus.current = true;
    };
    answer(useRoomPanelFocusStore.getState().request);
    return useRoomPanelFocusStore.subscribe((state) => answer(state.request));
  }, [roomId]);

  /**
   * Put the keyboard in the roster for the press that asked for it.
   *
   * The first control in it, so tabbing carries on through the people the
   * reader came to see. Waited for while the read is still in flight, because a
   * roster with no rows yet has nothing to land on — and answered anyway once
   * the read has landed, on the region itself (`tabIndex={-1}`, never a tab
   * stop of its own), which is the honest place for a room with nobody in it.
   *
   * `preventScroll` because the scroll is the next line's job, and doing both
   * at once fights.
   *
   * No dependency list, for the same reason as the search field below: the
   * control this waits for is mounted by a read landing, not by a prop here
   * changing.
   */
  useEffect(() => {
    if (!wantRosterFocus.current) return;
    const roster = rosterRef.current;
    if (roster === null) return;
    const first = roster.querySelector<HTMLElement>(FOCUSABLE);
    if (first === null && view.isLoading) return;
    wantRosterFocus.current = false;
    // A frame late, for the reason the search field is (below): the sidebar's
    // "Members…" is a menu item, and Radix hands focus back to the menu's own
    // trigger a commit after the press. Measured in a browser, where the bar's
    // chip landed in the roster and the sidebar's menu landed on `<body>`.
    //
    // The row is re-read inside the frame rather than captured: a roster that
    // lands in that frame — or a removal that takes the row with it — replaces
    // the node, and focusing the one this closure saw would focus something no
    // longer on screen.
    requestAnimationFrame(() => {
      const node = rosterRef.current;
      if (node === null) return;
      const target = node.querySelector<HTMLElement>(FOCUSABLE) ?? node;
      target.focus({ preventScroll: true });
    });
    roster.scrollIntoView({ block: 'nearest' });
  });

  /**
   * Give the search field the cursor as soon as there IS a field, when
   * something asked for it.
   *
   * Three paths lead here and one effect serves all of them. "Add agents…"
   * opens the picker already expanded — before the fleet has been read on a
   * cold start, so the field it wants does not exist yet, and this runs again
   * when it does. Pressing the add row expands it later. And a room that turns
   * out to hold no agents opens the picker on its own.
   *
   * **Only the first of those is `'asked'`, and only `'asked'` takes the cursor
   * from a real control.** A picker that opened because the room turned out to
   * be empty is not a request for a keyboard: a reader who is already editing
   * the topic — the other thing a door can ask for — keeps it.
   *
   * **None of it happens where touch is the only pointer.** Not one of the doors
   * is somebody tapping a text field, and taking the cursor there pops the
   * software keyboard over the list the reader came to read — the same rule the
   * composer holds to in `focusUnlessTouch`.
   */
  useEffect(() => {
    const want = wantSearchFocus.current;
    if (want === null || !addExpanded) return;
    if (isTouchOnly) {
      wantSearchFocus.current = null;
      return;
    }
    const field = searchRef.current;
    if (!field) return;
    if (want === 'offered') {
      // A topic edit is somebody, even in the frame before the editor has
      // claimed the cursor for itself — it takes it a frame late, and this
      // would otherwise get there first and win a race it should lose.
      const active = document.activeElement;
      const nowhere = active === null || active === document.body || active === scrollRef.current;
      if (topicEdits > 0 || !nowhere) {
        wantSearchFocus.current = null;
        return;
      }
    }
    wantSearchFocus.current = null;
    if (want === 'offered') {
      field.focus();
    } else {
      // **`'asked'` lands a frame late, and that is what makes it land at all.**
      // Two of the three doors are menu items. Radix closes the menu a commit
      // AFTER the press and then restores focus to its own trigger, so a cursor
      // placed in this commit is handed straight back and the reader is left on
      // the sidebar with an open picker they cannot type into — measured in a
      // browser, where `document.activeElement` came back `<body>`. A frame's
      // deferral puts this after the restore. The field is re-read inside the
      // frame because a fleet landing between the two can replace the node.
      requestAnimationFrame(() => searchRef.current?.focus());
    }
    // **No dependency list, deliberately.** The field this is waiting for is
    // not mounted by a render this component controls: the picker's search box
    // arrives with cmdk's own first commit, one tick after the fleet lands and
    // with no prop or state here changing to mark it. A dependency list was
    // therefore a guess about when to look, and it looked one commit too early
    // every time — the request stayed pending and the reader was left with an
    // open picker and nowhere to type. Running after every render costs one ref
    // read while a request is pending, and nothing at all otherwise.
  });

  /**
   * Escape answers the confirmation first.
   *
   * On a phone the panel is a slide-over, and Radix would take one Escape to
   * mean "close all of this" — dismissing the panel and the question in it
   * together. Captured at the document so it is decided before the layer sees
   * it, which is the only phase early enough: Radix listens on the document too,
   * and a React handler further down the tree runs after both.
   */
  useEffect(() => {
    if (pendingRemoval === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setPendingRemoval(null);
    };
    document.addEventListener('keydown', onKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [pendingRemoval]);

  const confirmRemoval = (member: RoomRosterEntry) => {
    setPendingRemoval(null);
    writes.removeMember(member);
  };

  /**
   * A room that cannot be read is a room, not a roster.
   *
   * The modal could say "couldn't read who is in here", because it was handed a
   * room by whoever opened it and so always had a name at the top. The panel is
   * addressed by id: when that read fails there is no room on this surface at
   * all, and the roster's own error would be describing the wrong thing while
   * the name above it stayed a skeleton forever. So the whole panel says the
   * true thing, and offers the same way out.
   *
   * It covers a deleted room and an `?id=` that was never right, which is what
   * `GET /api/rooms/:id` answers 404 to — the case spec §5.6 gives the PAGE a
   * sentence for, said again here rather than left blank.
   */
  if (view.isError) {
    return (
      <RoomPanelNotice
        title="That room isn't here"
        body="It may have been deleted, or the link may be out of date."
        action={
          <Button type="button" size="sm" variant="outline" onClick={view.retry}>
            Try again
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={scrollRef}
        data-slot="room-panel-scroll"
        className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3"
      >
        {/* The room's own line waits for the read rather than guessing at it.
            The panel has no summary handed to it the way the modal did — it is
            addressed by id — so a name here before the read lands would be an
            invention. The roster below says what it is doing meanwhile. */}
        {detail === null ? (
          <div className="flex items-center gap-3" aria-busy>
            <Skeleton className="size-9 rounded-full" />
            <Skeleton className="h-4 w-32" />
          </div>
        ) : (
          <RoomDetailsHeader
            // Remounted for each press of "Edit topic…" — see `topicEdits`.
            key={topicEdits}
            room={detail}
            participants={view.participants}
            visuals={view.roomVisuals}
            startTopicEditing={topicEdits > 0}
          />
        )}

        {/* An archived room triggers nobody, so the loudness sentence would be
            false there — "Two agents will answer you here" of a room that
            answers nothing. It says the true thing instead, and it is also the
            reason each dormant scale below hands to a screen reader, so the
            sentence has to work as a description of one of them.

            It names the ROSTER as well as the settings, because both are held:
            see the add row and `RoomMemberRow`'s removal verbs below. */}
        {detail?.archived === true && (
          <p
            id={dormantReasonId}
            className="bg-muted/50 text-muted-foreground rounded-lg px-3 py-2.5 text-xs"
          >
            Nobody is triggered in an archived room, so its members and their settings are on hold.
            Bring it back to change them.
          </p>
        )}
        {/* Only once there is a roster: an empty one is a real answer here —
            "There is nobody here to answer you" — so drawing this during the
            read would state something false and then correct itself. */}
        {detail !== null && !detail.archived && (
          <RoomLoudnessLine members={view.members} roomKind={detail.kind} preview={preview} />
        )}

        {/* **Said only when it is known to be true** (DOR-786). The rows below
            carry a working dot each, so their absence is the room's answer to
            "is anything happening here" — and until the room read carried its
            own presence, that absence was also what a sheet with no stream open
            looked like. `workingKnown` is the difference: silent when nothing
            current can say, this line when something can. Not in an archived
            room, where nobody is triggered at all and the banner above already
            says so — "no one is working" there would be a second, weaker way of
            saying the same thing. */}
        {detail !== null && !detail.archived && view.workingKnown && view.working.length === 0 && (
          <p className="text-muted-foreground px-3 text-xs">No one is working right now.</p>
        )}

        {/* Focusable, never tabbable: "Members" lands the keyboard here when
            the roster has no control of its own to land on yet. */}
        <div ref={rosterRef} tabIndex={-1} className="outline-none">
          <RoomMemberList
            members={view.members}
            isLoading={view.isLoading}
            isError={view.isError}
            onRetry={view.retry}
          >
            {(member) =>
              // Unreachable while the room is still being read — the roster and
              // the room are the same read — and stated rather than asserted,
              // because a torn frame here would draw a row about a room nobody
              // can name.
              detail === null ? null : (
                <RoomMemberRow
                  member={member}
                  roomKind={detail.kind}
                  isReader={member.authorId === view.room?.viewerAuthorId}
                  visual={
                    member.author.agentRef
                      ? (view.facesByRef.get(member.author.agentRef) ?? null)
                      : null
                  }
                  presence={
                    view.working.find((agent) => agent.authorId === member.authorId) ?? null
                  }
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
                  roomTitle={spokenTitle}
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
              )
            }
          </RoomMemberList>
        </div>

        {/* Not drawn at all in an archived room. Adding names no
            `responseMode`, so the server seeds one — `engaged` for a channel —
            which means remove-then-add here would rewrite a deliberate `Silent`
            into an agent that answers, in the very room the banner above says
            nothing can be changed in. A surface that refuses to let you CHANGE
            a setting must not let you SET one. */}
        {detail !== null && !detail.archived && (
          <AddMembersRow
            expanded={addExpanded}
            // Pressing the row IS asking for the picker, so the cursor follows
            // it in. `'offered'` rather than `'asked'`: expanding unmounts the
            // button that was pressed and drops focus on `<body>`, which is
            // nowhere — there is nothing here to take the cursor away from.
            onExpand={() => {
              setAddExpanded(true);
              wantSearchFocus.current = 'offered';
            }}
            roster={view.agents}
            exclude={view.isAlreadyIn}
            onSubmit={writes.addAgents}
            emptyRosterMessage={
              view.agents.candidates.length === 0
                ? 'You have not added any agents yet.'
                : 'Every agent you have is already in here.'
            }
            // Only for the empty fleet, which is the one of those two sentences
            // a person can act on — "everyone is already in here" is a finished
            // job, not a dead end. The panel stays open behind the creation
            // dialog: it is not a modal any more, so there is nothing to close.
            emptyRosterAction={
              view.agents.candidates.length === 0 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => useAgentCreationStore.getState().open()}
                >
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

        {/* Under the roster, because it is about what the people above may do
            rather than about who they are — and not drawn at all in an archived
            room, where the banner above says every setting is on hold and
            nothing is triggered anyway. */}
        {detail !== null && !detail.archived && <RoomLimitsSection room={detail} />}
      </div>

      {/* Nothing to say about a room still being read: the footer's two facts
          are when it was made and whether it is archived. */}
      {detail !== null && <RoomDetailsFooter room={detail} />}
    </div>
  );
}
