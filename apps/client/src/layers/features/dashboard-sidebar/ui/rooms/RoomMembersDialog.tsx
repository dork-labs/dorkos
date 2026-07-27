import { useMemo, useState } from 'react';
import { UserMinus } from 'lucide-react';
import { toast } from 'sonner';
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import {
  agentAuthorRef,
  type RoomRosterEntry,
  type RoomSummary,
} from '@dorkos/shared/room-schemas';
import { initialOf } from '@/layers/shared/lib';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
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
import { AgentChipPicker, type AgentPickerCandidate } from './AgentChipPicker';

/** Which half of the panel the reader asked for, so that half gets the focus. */
export type MembersDialogIntent = 'roster' | 'add';

interface RoomMembersDialogProps {
  /** The room whose roster is being managed. */
  room: RoomSummary;
  /** Whether the panel is on screen. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Which entry point opened it — "Members…" lands on the roster, "Add agents…" on the picker. */
  intent: MembersDialogIntent;
  /** Every agent in the fleet, sorted by name. Whoever is already in the room is filtered out here. */
  agents: AgentPickerCandidate[];
}

/**
 * Who is in a room, and how each agent decides when to reply there.
 *
 * This is the surface spec §14.3 asks for: one panel that the row's
 * "Members…" and "Add agents…" both reach, and that the room header and the
 * empty state will reach too. It is also the first UI ever to touch the
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
export function RoomMembersDialog({
  room,
  open,
  onOpenChange,
  intent,
  agents,
}: RoomMembersDialogProps) {
  // The list payload carries a DM's participants but never a channel's roster,
  // and never anyone's response mode — so the panel reads the room itself, and
  // only while it is open.
  const roomQuery = useRoom(open ? room.id : null);
  const addMember = useAddRoomMember();
  const removeMember = useRemoveRoomMember();
  const setResponseMode = useSetMemberResponseMode();
  const [pendingRemoval, setPendingRemoval] = useState<RoomRosterEntry | null>(null);

  const title = roomDisplayTitle(room);
  const members = useMemo(() => roomQuery.data?.members ?? [], [roomQuery.data]);
  const agentMembers = useMemo(() => members.filter((m) => m.author.kind === 'agent'), [members]);

  // An agent already in the room is not offerable. `agentRef` is the stable
  // handle derived from the agent's directory (ADR 260726-170126) — display
  // names are labels and two agents can share one, so they are never the key.
  const candidates = useMemo(() => {
    const present = new Set(
      agentMembers.map((member) => member.author.agentRef).filter((ref): ref is string => !!ref)
    );
    return agents.filter((agent) => !present.has(agentAuthorRef(agent.agentPath)));
  }, [agents, agentMembers]);

  const handleAdd = (chosen: AgentPickerCandidate[]) => {
    // One call per agent: the roster endpoint adds one member at a time, and a
    // partial success is still progress worth keeping — so each failure is
    // reported on its own rather than rolling the others back.
    for (const agent of chosen) {
      addMember.mutate(
        { roomId: room.id, agentPath: agent.agentPath },
        {
          onError: (err) =>
            toast.error(err.message || `Couldn't add ${agent.displayName} to ${title}`),
        }
      );
    }
  };

  const handleModeChange = (member: RoomRosterEntry, mode: ResponseMode) => {
    setResponseMode.mutate(
      { roomId: room.id, authorId: member.authorId, responseMode: mode },
      {
        onError: (err) =>
          toast.error(err.message || `Couldn't change how ${member.author.displayName} replies`),
      }
    );
  };

  const confirmRemoval = () => {
    const member = pendingRemoval;
    setPendingRemoval(null);
    if (!member) return;
    removeMember.mutate(
      { roomId: room.id, authorId: member.authorId },
      {
        onError: (err) =>
          toast.error(err.message || `Couldn't remove ${member.author.displayName} from ${title}`),
      }
    );
  };

  return (
    <>
      <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
        <ResponsiveDialogContent
          className="sm:max-w-md"
          // Focus follows the entry point, and has to be taken over to do it.
          // The picker sits at the BOTTOM of this panel but is the first
          // tabbable thing in it while the roster is still loading, so Radix's
          // "focus the first tabbable element" drops the cursor into a search
          // field a reader who asked for "Members…" never wanted. Panel first;
          // the picker focuses itself when the reader asked to add.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            if (intent === 'roster') (event.currentTarget as HTMLElement | null)?.focus();
          }}
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
                    <li
                      key={member.authorId}
                      className="flex flex-col gap-2 sm:flex-row sm:items-center"
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <IdentityAvatar
                          color={member.author.color ?? authorColor(member.author.id)}
                          emoji={member.author.emoji}
                          fallback={initialOf(member.author.displayName)}
                          className="size-6 shrink-0"
                        />
                        <span className="min-w-0 flex-1 truncate text-sm">
                          {member.author.displayName}
                        </span>
                      </span>
                      <span className="flex items-center gap-1">
                        <Select
                          value={member.responseMode}
                          onValueChange={(value) => handleModeChange(member, value as ResponseMode)}
                        >
                          <SelectTrigger
                            className="w-48"
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
                        <button
                          type="button"
                          aria-label={`Remove ${member.author.displayName}`}
                          onClick={() => setPendingRemoval(member)}
                          className="text-muted-foreground hover:text-destructive focus-visible:ring-ring shrink-0 rounded-md p-1.5 outline-hidden transition-colors focus-visible:ring-2"
                        >
                          <UserMinus className="size-4" />
                        </button>
                      </span>
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
              <AgentChipPicker
                candidates={candidates}
                onSubmit={handleAdd}
                submitLabel={(count) => (count > 1 ? `Add ${count} agents` : 'Add agent')}
                emptyRosterMessage={
                  agents.length === 0
                    ? 'You have not added any agents yet. Add one to put it in here.'
                    : 'Every agent you have is already in here.'
                }
                allChosenMessage="Every agent you have is already in here."
                isSubmitting={addMember.isPending}
                autoFocus={intent === 'add'}
              />
            </section>
          </ResponsiveDialogBody>
        </ResponsiveDialogContent>
      </ResponsiveDialog>

      <AlertDialog
        open={pendingRemoval !== null}
        onOpenChange={(next) => !next && setPendingRemoval(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {pendingRemoval?.author.displayName} from {title}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              It stops seeing new messages here. What it already said stays. You can add it back,
              but it starts a fresh session rather than picking up where it left off.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRemoval}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Re-exported so callers wire one candidate shape through both the row and the panel. */
export type { AgentPickerCandidate };
