/**
 * Who leads a channel, and the place to change it (DOR-2823).
 *
 * @module features/room-management/ui/RoomLeadSection
 */
import { useId } from 'react';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import {
  FieldCard,
  FieldCardContent,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/layers/shared/ui';
import { leadCandidates, roomLead, useSetRoomLead } from '@/layers/entities/room';

/**
 * The select's value for "nobody leads". Radix refuses an empty-string item
 * value, and no author id can collide with this one.
 */
const NO_LEAD = '__no-lead__';

/** What the section says the lead does, under its label. */
export const LEAD_HELP = 'Answers messages nobody else is answering.';

/** What #team says instead of offering a choice. */
export const TEAM_LEAD_NOTE = 'Your default agent. Change it from an agent’s profile.';

export interface RoomLeadSectionProps {
  /** The room, as freshly as it has been read. */
  room: RoomWithRoster;
}

/**
 * The channel's lead: the agent that answers a person when nobody else does.
 *
 * **Channels only.** A direct message has one agent, which answers everything
 * said there anyway, so the server refuses a lead on one and this draws nothing.
 *
 * **#team shows its lead and offers no choice.** Its lead is the install's
 * default agent, which is set from an agent's profile rather than from the room
 * — so the row says who it is and where it is changed, instead of offering a
 * select the server would refuse.
 *
 * **Only agents are offered.** A person is never the lead: the lead exists so a
 * person's message is always answered by an agent. Retired agents answer
 * nothing (DOR-2095) and are left out, except the one already leading — a
 * select whose value names no option draws blank, which would read as "None".
 *
 * Hidden from a reader the roster positively says is an agent, for the reason
 * `RoomLimitsSection` gives: the write is the install owner's alone.
 */
export function RoomLeadSection({ room }: RoomLeadSectionProps) {
  const labelId = useId();
  const helpId = useId();
  const setLead = useSetRoomLead();

  if (room.kind !== 'channel') return null;
  const viewer = room.members.find((member) => member.authorId === room.viewerAuthorId);
  if (viewer !== undefined && viewer.author.kind !== 'human') return null;

  const lead = roomLead(room);
  // #team is the one well-known room, and its lead is the default agent.
  const isTeam = room.wellKnown != null;
  const candidates = leadCandidates(room.members);
  if (lead !== null && !candidates.includes(lead)) candidates.unshift(lead);

  return (
    <FieldCard data-slot="room-lead-section">
      <FieldCardContent>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p id={labelId} className="text-sm font-medium">
              Lead
            </p>
            <p id={helpId} className="text-muted-foreground text-xs">
              {isTeam ? TEAM_LEAD_NOTE : LEAD_HELP}
            </p>
          </div>
          {isTeam ? (
            <span className="text-foreground max-w-40 shrink-0 truncate text-sm">
              {lead?.author.displayName ?? 'None'}
            </span>
          ) : (
            <Select
              value={lead?.authorId ?? NO_LEAD}
              onValueChange={(next) =>
                setLead.mutate({
                  roomId: room.id,
                  leadAuthorId: next === NO_LEAD ? null : next,
                })
              }
            >
              <SelectTrigger
                aria-labelledby={labelId}
                aria-describedby={helpId}
                className="w-40 shrink-0"
              >
                {/* Truncates a long name before the chevron, at phone width. */}
                <span className="min-w-0 flex-1 truncate text-left">
                  <SelectValue />
                </span>
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value={NO_LEAD}>None</SelectItem>
                {candidates.map((member) => (
                  <SelectItem key={member.authorId} value={member.authorId}>
                    <span className="truncate">{member.author.displayName}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </FieldCardContent>
    </FieldCard>
  );
}
