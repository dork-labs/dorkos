import { useEffect, useMemo, useRef, useState } from 'react';
import { agentAuthorRef, type RoomRosterEntry } from '@dorkos/shared/room-schemas';
import type { AgentVisual } from '@/layers/shared/lib';
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  Skeleton,
} from '@/layers/shared/ui';
import {
  modeForRung,
  roomDisplayTitle,
  useAddRoomMember,
  useLoadedRoomEntries,
  useRemoveRoomMember,
  useRoom,
  useRoomPresence,
  useSetMemberResponseMode,
  type ResponseRung,
} from '@/layers/entities/room';
import { useEngagedWindow } from '@/layers/entities/config';
import type { AgentPickerCandidate } from '@/layers/entities/agent';
import { useAgentPickerCandidates } from '../model/use-agent-picker-candidates';
import type { RoomDetailsFocus, RoomDetailsRoom } from '../model/room-details';
import { AddMembersRow } from './AddMembersRow';
import { RoomDetailsHeader } from './RoomDetailsHeader';
import { RoomMemberRow } from './RoomMemberRow';

interface RoomDetailsDialogProps {
  /** The room whose roster is being managed. */
  room: RoomDetailsRoom;
  /** Whether the panel is on screen. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Which entry point opened it — "Members…" lands on the roster, "Add agents…" on the picker. */
  focus: RoomDetailsFocus;
}

/**
 * Who is in a room, and how each agent decides when to reply there.
 *
 * This is the surface spec §14.3 asks for, and all three of its entry points
 * now land here: the sidebar row's "Members…" and "Add agents…", the open
 * room's header roster, and the empty state that promises it. One panel, so
 * there is one place to learn and one place a change lands. It is also the
 * first UI ever to touch the
 * per-room `responseMode` override — a field the schema has carried since R1,
 * which until now was fixed at join time and changeable only by editing the
 * database.
 *
 * A modal rather than a popover, deliberately: the sidebar is a drawer on a
 * phone and has to close for a popover anchored to it to be visible, so
 * anything that is a task rather than a glance uses the responsive modal
 * (spec §14.5).
 *
 * **Only agents are managed here.** The room's human member is the person
 * reading — there is no verb for them (spec §15.2), and removing yourself from
 * a room you created would make it invisible with no route back, which is the
 * same reason there is no "Leave".
 */
export function RoomDetailsDialog({ room, open, onOpenChange, focus }: RoomDetailsDialogProps) {
  // Read here rather than handed down: this panel opens from three places (the
  // sidebar row, the room header, the empty state) and only one of them has a
  // fleet to give it.
  const agents = useAgentPickerCandidates();
  // The list payload carries a DM's participants but never a channel's roster,
  // and never anyone's response mode — so the panel reads the room itself, and
  // only while it is open.
  const roomQuery = useRoom(open ? room.id : null);
  const addMember = useAddRoomMember();
  const removeMember = useRemoveRoomMember();
  const setResponseMode = useSetMemberResponseMode();
  // The ceilings the engaged rung is described with. `null` until the config
  // read lands, and the sentence says less rather than quoting the numbers this
  // install ships with — see `useEngagedWindow`.
  const engagedWindow = useEngagedWindow();
  // Who is working, if anybody is telling us. The signal rides the room's own
  // SSE stream, which only the room ON SCREEN has open — so a panel opened from
  // the sidebar over some other room correctly learns nothing, and the rows say
  // the next true thing instead. Opening a second stream to decorate a dialog is
  // not a trade worth making.
  const working = useRoomPresence(open ? room.id : null);
  // "Last spoke" is decoration: worth printing over an open room, never worth a
  // history GET of its own — and never worth racing the live stream for the
  // cache entry it writes into. See `useLoadedRoomEntries`.
  const loadedEntries = useLoadedRoomEntries(open ? room.id : null);
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
   * The "Add agents…" entry point opens it already open, which is the whole
   * difference between that door and "Members…" — both land on one sheet, and
   * only the state it opens in says which one was pressed.
   */
  const [addExpanded, setAddExpanded] = useState(focus === 'add');
  const searchRef = useRef<HTMLInputElement>(null);
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
  }, [addExpanded, agents.isLoading, agents.isError]);

  const title = roomDisplayTitle(room);
  const members = useMemo(() => roomQuery.data?.members ?? [], [roomQuery.data]);
  const agentMembers = useMemo(() => members.filter((m) => m.author.kind === 'agent'), [members]);

  // An agent already in the room is not offerable. `agentRef` is the stable
  // handle derived from the agent's directory (ADR 260726-170126) — display
  // names are labels and two agents can share one, so they are never the key.
  const isAlreadyIn = useMemo(() => {
    const present = new Set(
      agentMembers.map((member) => member.author.agentRef).filter((ref): ref is string => !!ref)
    );
    return (agent: { agentPath: string }) => present.has(agentAuthorRef(agent.agentPath));
  }, [agentMembers]);

  /**
   * Each agent's real face, keyed by the same stable handle the roster carries.
   *
   * The fleet is read here anyway to offer the picker, and its candidates hold
   * the visual `entities/agent` resolves from the manifest — the one the sidebar
   * and the message gutter draw. Joining on it is what stops this roster
   * inventing a second appearance for an agent the reader already recognises.
   */
  const facesByRef = useMemo(() => {
    const faces = new Map<string, AgentVisual>();
    for (const candidate of agents.candidates) {
      if (candidate.visual !== null)
        faces.set(agentAuthorRef(candidate.agentPath), candidate.visual);
    }
    return faces;
  }, [agents.candidates]);

  /** The roster's authors, or `null` while it is still being read. */
  const participants = useMemo(
    () => (roomQuery.data ? roomQuery.data.members.map((member) => member.author) : null),
    [roomQuery.data]
  );

  /**
   * The faces of this room's agents, in roster order.
   *
   * Only a direct message's mark draws them, and it is the same join the roster
   * rows make — so the mark at the top of the sheet is the face the row below it
   * shows, rather than a letter disc for the agent the reader is looking at.
   */
  const roomVisuals = useMemo(
    () =>
      agentMembers
        .map((member) => (member.author.agentRef ? facesByRef.get(member.author.agentRef) : null))
        .filter((visual): visual is AgentVisual => visual !== null && visual !== undefined),
    [agentMembers, facesByRef]
  );

  /**
   * When each author last posted, as far as the loaded page can say.
   *
   * Posts only: a notice is the ROOM speaking about a member, not the member
   * speaking. Absent authors are absent from the map, and the row prints when
   * they joined rather than claiming they have never spoken — the page is only
   * the tail of the log, so silence in it proves nothing.
   */
  const lastSpokeByAuthor = useMemo(() => {
    const spoke = new Map<string, string>();
    for (const entry of loadedEntries ?? []) {
      if (entry.kind === 'post') spoke.set(entry.authorId, entry.createdAt);
    }
    return spoke;
  }, [loadedEntries]);

  const handleAdd = (chosen: AgentPickerCandidate[]) => {
    // One call per agent: the roster endpoint adds one member at a time, and a
    // partial success is still progress worth keeping, so a failure is reported
    // on its own rather than rolling the others back. Reporting is the shared
    // mutation toast's — the hook names the action and the server says why, and
    // raising a second toast here only ever produced two lines for one failure.
    //
    // Nothing is cleared here, and the panel stays open. Each agent that lands
    // joins the roster, drops out of `candidates` above, and takes its own chip
    // with it — so the selection empties at the rate the writes actually
    // succeed, and after three of four the reader is left holding the one that
    // failed rather than a button that would add the other three again.
    for (const agent of chosen) {
      addMember.mutate({ roomId: room.id, agentPath: agent.agentPath });
    }
  };

  // A rung is what a person picks; a `responseMode` is what gets stored. One
  // canonical value per rung, so this panel never writes one of the two aliases
  // whose meaning depends on which kind of room it ends up in.
  const handleRungChange = (member: RoomRosterEntry, rung: ResponseRung) => {
    setResponseMode.mutate({
      roomId: room.id,
      authorId: member.authorId,
      responseMode: modeForRung(rung, room.kind),
    });
  };

  const confirmRemoval = (member: RoomRosterEntry) => {
    setPendingRemoval(null);
    removeMember.mutate({ roomId: room.id, authorId: member.authorId });
  };

  /**
   * Escape answers the confirmation first, and only closes the panel once there
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

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        className="sm:max-w-md"
        // Focus follows the entry point, and this is the only place that can
        // place it. Radix's default — first tabbable element — is wrong in both
        // directions here: it lands in the add-agents search field for a reader
        // who asked for "Members…", and on the first roster control for one who
        // asked to add. So both branches are explicit.
        //
        // It has to happen HERE and not inside the picker. The menu that opened
        // this panel closes a commit later and restores focus to its own
        // trigger — the sidebar's "…" button — so any focus the picker set on
        // mount is simply overwritten, and the reader is left typing into a
        // sidebar. Focus placed by the dialog is inside its focus scope, which
        // Radix defends against exactly that.
        //
        // With a `focus` of "add" the field may not exist YET — the sheet reads
        // its own fleet, so the picker draws a shape while that lands. Focus
        // goes to the content in the meantime and the effect above hands it on
        // the moment the field appears; without that, "Add agents…" on a cold
        // read left the reader nowhere.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const target =
            focus === 'add' ? (searchRef.current ?? event.currentTarget) : event.currentTarget;
          contentRef.current = event.currentTarget as HTMLElement;
          (target as HTMLElement | null)?.focus();
        }}
        onEscapeKeyDown={handleEscapeKeyDown}
        // Nothing here describes the sheet as a whole. Its parts — the room
        // line, each member's row — say what they are where they are, and a
        // sentence at the top summarising a surface the reader is already
        // looking at is the help text the sheet was designed not to need.
        // Radix asks to be told that on purpose rather than assumed.
        aria-describedby={undefined}
      >
        <RoomDetailsHeader room={room} participants={participants} visuals={roomVisuals} />

        <ResponsiveDialogBody className="space-y-4">
          <section
            aria-label="Current members"
            aria-busy={roomQuery.isLoading || undefined}
            className="space-y-2"
          >
            {roomQuery.isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
              </div>
            ) : roomQuery.isError ? (
              <p className="text-muted-foreground text-sm">
                Couldn&apos;t read who is in here. Everyone is still where they were — close this
                and open it again to retry.
              </p>
            ) : agentMembers.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No agents in here yet. Add one below and it will see everything said so far.
              </p>
            ) : (
              /* Everyone, in the order the server hands them back — oldest
                 membership first (`RoomStore.listMembers`), which puts whoever
                 opened the room at the top. Nothing re-sorts here: the sidebar
                 and this panel name the same people in the same order because
                 neither of them decides one.

                 The reader is IN this list. A panel that answers "who is in
                 here?" by listing everyone except the person asking is
                 describing a room that does not exist. They simply have no
                 loudness and no verbs — see `RoomMemberRow`. */
              <ul className="space-y-2.5">
                {members.map((member) => (
                  <li key={member.authorId}>
                    <RoomMemberRow
                      member={member}
                      roomKind={room.kind}
                      isReader={member.authorId === roomQuery.data?.viewerAuthorId}
                      visual={
                        member.author.agentRef
                          ? (facesByRef.get(member.author.agentRef) ?? null)
                          : null
                      }
                      presence={working.find((agent) => agent.authorId === member.authorId) ?? null}
                      lastSpokeAt={lastSpokeByAuthor.get(member.authorId) ?? null}
                      expanded={expandedMember === member.authorId}
                      onExpandedChange={(next) => setExpandedMember(next ? member.authorId : null)}
                      onRungChange={(rung) => handleRungChange(member, rung)}
                      roomTitle={title}
                      // The confirmation lives in the ROW rather than here,
                      // because the row is what owns the "…" menu — and where
                      // the keyboard lands when that menu closes is a decision
                      // only the menu can make. See `RoomMemberRow`.
                      onRemoveRequested={() => setPendingRemoval(member.authorId)}
                      confirmingRemoval={pendingRemoval === member.authorId}
                      onConfirmRemoval={() => confirmRemoval(member)}
                      onCancelRemoval={() => setPendingRemoval(null)}
                      engagedWindow={engagedWindow}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <AddMembersRow
            expanded={addExpanded}
            onExpand={() => setAddExpanded(true)}
            roster={agents}
            exclude={isAlreadyIn}
            onSubmit={handleAdd}
            emptyRosterMessage={
              agents.candidates.length === 0
                ? 'You have not added any agents yet. Add one to put it in here.'
                : 'Every agent you have is already in here.'
            }
            allChosenMessage="Every agent you have is already in here."
            isSubmitting={addMember.isPending}
            inputRef={searchRef}
          />
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
