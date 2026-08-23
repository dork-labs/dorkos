/**
 * What this one room allows agents to say to each other, and what it inherits.
 *
 * @module features/room-management/ui/RoomLimitsSection
 */
import { useState } from 'react';
import { ROOM_TURN_LIMIT_BOUNDS } from '@dorkos/shared/config-schema';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import { useRoomTurnLimits } from '@/layers/entities/config';
import { useSetRoomLimits, type SetRoomLimitsInput } from '@/layers/entities/room';
import { Badge, CollapsibleFieldCard, Label, RadioGroup, RadioGroupItem } from '@/layers/shared/ui';
import { roomLimitsErrorMessage } from '../lib/room-limit-errors';
import { RoomLimitRow } from './RoomLimitRow';

/** The three answers a room may give about being limited at all. */
type LimitStance = 'default' | 'limited' | 'unlimited';

/** Which stance a stored `turnLimitsEnabled` is. `null` is "follow Settings". */
function stanceOf(stored: boolean | null | undefined): LimitStance {
  if (stored === true) return 'limited';
  if (stored === false) return 'unlimited';
  return 'default';
}

/** What a stance stores. The inverse of {@link stanceOf}. */
function storedFor(stance: LimitStance): boolean | null {
  if (stance === 'limited') return true;
  if (stance === 'unlimited') return false;
  return null;
}

export interface RoomLimitsSectionProps {
  /** The room, as freshly as it has been read. */
  room: RoomWithRoster;
}

/**
 * How far agents may carry a conversation in THIS room.
 *
 * **Everything here is an override, and an empty field is the normal state.** A
 * room that says nothing follows Settings, which is what almost every room does
 * — so the section is collapsed until asked for, and each field shows the number
 * it would use rather than a blank.
 *
 * **The write is the install owner's alone** (403 `OPERATOR_ONLY`): these fields
 * are spend authority, so a second human — an invited member, a cached remote
 * one — must not be able to uncap a room on the owner's account.
 *
 * **The section is still shown to every person, and the refusal is what says
 * no.** This client genuinely cannot tell the owner from any other human today:
 * the only signal available is `GET /api/team`'s `isSelf`, which names the
 * account that owns the install for EVERY caller rather than answering "who is
 * asking" (the residual `use-room-row-menu.ts` records). Hiding the section on a
 * guess would hide it from the one person who may use it. So it is offered, and
 * a refusal becomes a sentence naming who can — inline, under the control that
 * was refused, which is also why this mutation opts out of the shared toast.
 *
 * What IS hidden is the section for a reader the roster positively says is an
 * agent: no agent may ever write these, so offering it would be a lie in every
 * case rather than in one. Seeing a room and being in it are different things,
 * so a reader who is not on the roster at all is not thereby an agent.
 *
 * **The one thing a room cannot do is named out loud.** The install-wide hourly
 * total still applies to an unlimited room, because a room may opt out of its
 * own bounds and never out of the bill.
 */
export function RoomLimitsSection({ room }: RoomLimitsSectionProps) {
  const [open, setOpen] = useState(false);
  const { limits: installLimits } = useRoomTurnLimits();
  const setRoomLimits = useSetRoomLimits();

  const viewer = room.members.find((member) => member.authorId === room.viewerAuthorId);
  if (viewer !== undefined && viewer.author.kind !== 'human') return null;

  const stance = stanceOf(room.turnLimitsEnabled);
  const write = (patch: Omit<SetRoomLimitsInput, 'roomId'>) =>
    setRoomLimits.mutate({ roomId: room.id, ...patch });

  /** Whether anything is bounded here at all, once inheritance is resolved. */
  const boundedHere = room.turnLimitsEnabled ?? installLimits?.turnLimitsEnabled ?? true;
  /** True when this room has said something of its own about any of the four. */
  const hasOverrides =
    room.turnLimitsEnabled != null ||
    room.maxAgentDepth != null ||
    room.maxTurnsPerAgentPerCascade != null ||
    room.maxAutoTurnsPerHour != null;

  return (
    <CollapsibleFieldCard
      open={open}
      onOpenChange={setOpen}
      trigger="Automatic replies"
      badge={
        stance === 'unlimited' ? (
          <Badge variant="secondary">Not limited</Badge>
        ) : hasOverrides ? (
          <Badge variant="secondary">Custom</Badge>
        ) : undefined
      }
    >
      <div className="space-y-2">
        <Label className="text-sm font-medium">Limits in this room</Label>
        <RadioGroup
          value={stance}
          onValueChange={(next) => write({ turnLimitsEnabled: storedFor(next as LimitStance) })}
          className="gap-2"
        >
          <div className="flex items-start gap-2">
            <RadioGroupItem value="default" id={`${room.id}-limits-default`} className="mt-0.5" />
            <div className="min-w-0">
              <Label htmlFor={`${room.id}-limits-default`} className="text-sm font-normal">
                Follow Settings
              </Label>
              <p className="text-muted-foreground text-xs">
                {installLimits === null
                  ? 'Whatever your settings say.'
                  : installLimits.turnLimitsEnabled
                    ? 'Your settings limit automatic replies right now.'
                    : 'Your settings do not limit automatic replies right now.'}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <RadioGroupItem value="limited" id={`${room.id}-limits-limited`} className="mt-0.5" />
            <div className="min-w-0">
              <Label htmlFor={`${room.id}-limits-limited`} className="text-sm font-normal">
                Limited
              </Label>
              <p className="text-muted-foreground text-xs">
                Keep this room limited even if your settings are not.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <RadioGroupItem
              value="unlimited"
              id={`${room.id}-limits-unlimited`}
              className="mt-0.5"
            />
            <div className="min-w-0">
              <Label htmlFor={`${room.id}-limits-unlimited`} className="text-sm font-normal">
                Not limited
              </Label>
              <p className="text-muted-foreground text-xs">
                Agents reply to each other here until you press Stop.
              </p>
            </div>
          </div>
        </RadioGroup>
      </div>

      {/* Left on screen and disabled rather than hidden while the room is
          unlimited, the same rule Settings holds to: what is set here is kept,
          and coming back to Limited must not be a re-typing job. */}
      <div className="space-y-4">
        <RoomLimitRow
          label="Replies in a row"
          description="How many replies agents may trade here before the room pauses them."
          value={room.maxAgentDepth ?? null}
          fallback={installLimits?.maxAgentDepth ?? null}
          min={ROOM_TURN_LIMIT_BOUNDS.maxAgentDepth.min}
          max={ROOM_TURN_LIMIT_BOUNDS.maxAgentDepth.max}
          disabled={!boundedHere}
          onCommit={(next) => write({ maxAgentDepth: next })}
        />
        <RoomLimitRow
          label="Replies from one agent"
          description="How many of those replies any one agent may send here."
          value={room.maxTurnsPerAgentPerCascade ?? null}
          fallback={installLimits?.maxTurnsPerAgentPerCascade ?? null}
          min={ROOM_TURN_LIMIT_BOUNDS.maxTurnsPerAgentPerCascade.min}
          max={ROOM_TURN_LIMIT_BOUNDS.maxTurnsPerAgentPerCascade.max}
          disabled={!boundedHere}
          onCommit={(next) => write({ maxTurnsPerAgentPerCascade: next })}
        />
        <RoomLimitRow
          label="Replies each hour"
          description="The most automatic replies this room may run in an hour."
          value={room.maxAutoTurnsPerHour ?? null}
          fallback={installLimits?.maxAutomaticTurnsPerRoomPerHour ?? null}
          min={ROOM_TURN_LIMIT_BOUNDS.maxAutoTurnsPerHour.min}
          max={ROOM_TURN_LIMIT_BOUNDS.maxAutoTurnsPerHour.max}
          disabled={!boundedHere}
          onCommit={(next) => write({ maxAutoTurnsPerHour: next })}
        />
      </div>

      {/* One report, under the control that was refused. The mutation opts out
          of the shared toast for this: a value that has already snapped back
          plus a toast that fades is a failure said twice and remembered
          nowhere. */}
      {setRoomLimits.isError && (
        <p role="alert" className="text-destructive text-xs">
          {roomLimitsErrorMessage(setRoomLimits.error)}
        </p>
      )}

      <p className="text-muted-foreground text-xs">
        The hourly limit across all of DorkOS still applies here. A room can go without its own
        limits, not without your bill.
      </p>
    </CollapsibleFieldCard>
  );
}
