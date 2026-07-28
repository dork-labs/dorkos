import { useEffect, useMemo, useRef, useState } from 'react';
import { UserMinus } from 'lucide-react';
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import { agentAuthorRef, type Room, type RoomRosterEntry } from '@dorkos/shared/room-schemas';
import { initialOf } from '@/layers/shared/lib';
import {
  Button,
  IdentityAvatar,
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@/layers/shared/ui';
import {
  authorColor,
  roomDisplayTitle,
  useAddRoomMember,
  useRemoveRoomMember,
  useRoom,
  useSetMemberResponseMode,
  RESPONSE_MODE_OPTIONS,
} from '@/layers/entities/room';
import type { AgentPickerCandidate } from '@/layers/entities/agent';
import { useAgentPickerCandidates } from '../model/use-agent-picker-candidates';
import { AgentRosterPicker } from './AgentRosterPicker';

/** Which half of the panel the reader asked for, so that half gets the focus. */
export type MembersDialogIntent = 'roster' | 'add';

/**
 * The least this panel needs to know about a room.
 *
 * Deliberately narrower than `RoomSummary`: the three entry points spec §14.3
 * names hold different shapes — a sidebar row has a `RoomSummary`, the open
 * room has a `RoomWithRoster` — and neither is assignable to the other. The
 * panel reads the room itself anyway, so an id and enough to name it is all it
 * ever needed.
 */
export type MembersDialogRoom = Pick<Room, 'id' | 'kind' | 'slug' | 'title'>;

interface RoomMembersDialogProps {
  /** The room whose roster is being managed. */
  room: MembersDialogRoom;
  /** Whether the panel is on screen. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Which entry point opened it — "Members…" lands on the roster, "Add agents…" on the picker. */
  intent: MembersDialogIntent;
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
export function RoomMembersDialog({ room, open, onOpenChange, intent }: RoomMembersDialogProps) {
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
  /** The member whose removal is waiting to be confirmed, by author id. */
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLElement | null>(null);
  /** Whether the "add" intent has already been handed its field. Once only. */
  const searchFocused = useRef(false);

  /**
   * Give the search field the focus the "add" entry point asked for, as soon as
   * there IS a field.
   *
   * `onOpenAutoFocus` fires once, when the dialog opens, and the field it wants
   * arrives later than that whenever the fleet has to be read first. So the
   * intent is honoured again here — once, and only while focus is still inside
   * the dialog, so a reader who has already tabbed somewhere else does not have
   * it yanked back mid-keystroke.
   */
  useEffect(() => {
    if (intent !== 'add' || searchFocused.current) return;
    const field = searchRef.current;
    if (!field) return;
    const content = contentRef.current;
    if (content && !content.contains(document.activeElement)) return;
    searchFocused.current = true;
    field.focus();
  }, [intent, agents.isLoading, agents.isError]);

  // The confirmation takes the focus so it can be answered from the keyboard
  // without hunting for it, and so a screen reader reads what it is confirming.
  useEffect(() => {
    if (pendingRemoval !== null) confirmRef.current?.focus();
  }, [pendingRemoval]);

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

  const handleModeChange = (member: RoomRosterEntry, mode: ResponseMode) => {
    setResponseMode.mutate({ roomId: room.id, authorId: member.authorId, responseMode: mode });
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
        // With intent "add" the field may not exist YET — the panel reads its
        // own fleet, so the picker draws a shape while that lands. Focus goes
        // to the content in the meantime and {@link useFocusSearchWhenReady}
        // hands it on the moment the field appears; without that, "Add
        // agents…" on a cold read left the reader nowhere.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const target =
            intent === 'add' ? (searchRef.current ?? event.currentTarget) : event.currentTarget;
          contentRef.current = event.currentTarget as HTMLElement;
          (target as HTMLElement | null)?.focus();
        }}
        onEscapeKeyDown={handleEscapeKeyDown}
      >
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Members of {title}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Who is in here, and when each agent replies.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

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
              <ul className="space-y-2">
                {agentMembers.map((member) => (
                  <li key={member.authorId} className="rounded-md border p-2">
                    <div className="flex items-center gap-2">
                      <IdentityAvatar
                        color={member.author.color ?? authorColor(member.author.id)}
                        emoji={member.author.emoji}
                        fallback={initialOf(member.author.displayName)}
                        className="size-6 shrink-0"
                      />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {member.author.displayName}
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove ${member.author.displayName}`}
                        onClick={() => setPendingRemoval(member.authorId)}
                        className="text-muted-foreground hover:text-destructive focus-visible:ring-ring shrink-0 rounded-md p-1.5 outline-hidden transition-colors focus-visible:ring-2"
                      >
                        <UserMinus className="size-4" />
                      </button>
                    </div>

                    {/* The mode gets its own line rather than sharing one with
                        the name: the longest label does not fit beside an agent
                        name at this width, and a truncated "Replies only when
                        @me…" is a setting you cannot read. */}
                    <Select
                      value={member.responseMode}
                      onValueChange={(value) => handleModeChange(member, value as ResponseMode)}
                    >
                      <SelectTrigger
                        className="mt-1.5 w-full"
                        aria-label={`When ${member.author.displayName} replies`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {RESPONSE_MODE_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    {/* Confirmed in place rather than in a second dialog.
                          A dialog over a dialog closed BOTH when it was
                          answered — the inner one's dismissal reaches the outer
                          as an interaction from outside it — so the roster the
                          reader was working on vanished with the confirmation.
                          jsdom has no portals to race; only a browser shows it. */}
                    {pendingRemoval === member.authorId && (
                      <div
                        role="group"
                        aria-label={`Remove ${member.author.displayName} from ${title}?`}
                        className="bg-muted/60 mt-1.5 space-y-2 rounded-md p-2"
                      >
                        <p className="text-muted-foreground text-xs">
                          Remove {member.author.displayName}? It stops seeing new messages here and
                          what it already said stays. Adding it back starts a fresh session.
                        </p>
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => setPendingRemoval(null)}
                          >
                            Cancel
                          </Button>
                          <Button
                            ref={confirmRef}
                            type="button"
                            size="sm"
                            variant="destructive"
                            onClick={() => confirmRemoval(member)}
                          >
                            Remove
                          </Button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label="Add agents" className="space-y-2 border-t pt-4">
            <h3 className="text-sm font-medium">Add agents</h3>
            <p className="text-muted-foreground text-xs">
              They join here and can read everything already said.
            </p>
            <AgentRosterPicker
              roster={agents}
              exclude={isAlreadyIn}
              onSubmit={handleAdd}
              submitLabel={(count) => (count > 1 ? `Add ${count} agents` : 'Add agent')}
              emptyRosterMessage={
                agents.candidates.length === 0
                  ? 'You have not added any agents yet. Add one to put it in here.'
                  : 'Every agent you have is already in here.'
              }
              allChosenMessage="Every agent you have is already in here."
              isSubmitting={addMember.isPending}
              inputRef={searchRef}
            />
          </section>
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
