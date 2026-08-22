import { CircleStop } from 'lucide-react';
import { useHaltRoom, useOpenRoomWorking } from '@/layers/entities/room';
import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@/layers/shared/ui';

interface RoomWorkingChipProps {
  /** How many agents are working in the room right now. */
  count: number;
  /** What the room is called, for the tooltip. */
  roomName: string;
}

/**
 * Whether anything is running in this room, as one chip: a pulse and a count.
 *
 * **A number, not a sentence.** The masthead this replaces had room for "3
 * agents working" and the bar does not — the row is 36px and the room's name
 * sits beside it — so the chip says the same fact in the same 40px the members
 * chip next to it uses, and the tooltip carries the sentence. Two chips, two
 * counts, told apart by the pulse and the green: this one is about right now,
 * that one is about who belongs here.
 *
 * **Not a bare dot.** A colour-only signal is one a reader who cannot tell green
 * from grey never receives, so the count is text and the dot only animates it.
 *
 * **`tabular-nums` is load-bearing, not typography.** This chip is mounted at
 * all times (see {@link RoomRunState}) and its width is the space being
 * reserved; proportional digits would make that width depend on which digit is
 * showing, so the row would inch sideways as the count changed.
 */
export function RoomWorkingChip({ count, roomName }: RoomWorkingChipProps) {
  const label = count === 1 ? '1 agent working' : `${count} agents working`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="room-working-chip"
          aria-label={label}
          className="text-status-success bg-status-success/10 inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium tabular-nums"
        >
          <span
            aria-hidden
            className="bg-status-success size-1.5 rounded-full motion-safe:animate-pulse"
          />
          {count}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {`${label} in ${roomName}`}
      </TooltipContent>
    </Tooltip>
  );
}

interface RoomHaltButtonProps {
  /** The room to stop. */
  roomId: string;
  /** What that room is called, so the button can say what it stops. */
  roomName: string;
}

/**
 * Stop every agent working in this room.
 *
 * **It is the only way to stop a room, and that is the whole design**: typing
 * "stop" into the composer sends a message, which is what a person means about a
 * third of the time and never what a looping agent hears
 * (`room-participation` §10.4). Pressing this reaches the runtimes instead.
 *
 * Deliberately NOT `destructive`. Nothing is destroyed — the turns stop and what
 * they already said stays — and red would put the room's most ordinary recovery
 * action in the same register as deleting something.
 *
 * The word is hidden below `sm` and the icon carries it, because a phone's bar
 * is already spending its width on the room's name; the accessible name says
 * which room either way, so nothing is lost to a screen reader at any size.
 */
export function RoomHaltButton({ roomId, roomName }: RoomHaltButtonProps) {
  const halt = useHaltRoom();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          data-testid="room-halt"
          variant="outline"
          size="xs"
          aria-label={`Stop all agents in ${roomName}`}
          disabled={halt.isPending}
          onClick={() => halt.mutate({ roomId })}
        >
          <CircleStop aria-hidden className="size-3.5" />
          <span className="sr-only sm:not-sr-only">Stop</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {`Stop all agents in ${roomName}`}
      </TooltipContent>
    </Tooltip>
  );
}

interface RoomRunStateProps {
  /** The room on screen. */
  roomId: string;
  /** What it is called — both controls say so. */
  roomName: string;
}

/**
 * "Something is running here", and the button that stops it — the pair of
 * controls a room grows while it is busy.
 *
 * Shared by the channel bar and Home's, because Home IS a room (#team) and the
 * two surfaces were only ever different addresses for the same fact. Home lost
 * both when its masthead went (phase H1); this is where it gets them back.
 *
 * **The reserved-space mechanism (I3), which is the point of this component.**
 * Both controls are mounted at ALL times, busy or idle. When nothing is running
 * the slot is faded out and marked `inert`, so it is invisible, unfocusable,
 * unclickable and absent from the accessibility tree — but it still occupies its
 * width. That is the difference between this and the conditional render it
 * replaces: an agent picking something up changes only `opacity`, so the room's
 * name to the left of the slot and the search/inbox/right-panel cluster to the
 * right of it do not move by a pixel. Rendering the pair only while busy would
 * have shoved the identity zone sideways mid-read, which is exactly what I3
 * forbids.
 *
 * Two details make the reservation hold rather than merely look reserved. The
 * chip renders the live count even at zero, so the box is filled by the same
 * content that will be visible a moment later rather than by a spacer that could
 * drift out of step with it; and that count is `tabular-nums`, so its width does
 * not depend on which digits are showing.
 *
 * `inert` rather than `hidden` or `aria-hidden` plus `tabIndex={-1}`: one
 * attribute that takes the whole subtree out of focus order, hit-testing and the
 * a11y tree at once, and the only one of the three that cannot be half-applied.
 */
export function RoomRunState({ roomId, roomName }: RoomRunStateProps) {
  const working = useOpenRoomWorking(roomId);
  const idle = working === 0;

  return (
    <div
      data-testid="room-run-state"
      data-idle={idle}
      inert={idle}
      className={
        idle
          ? 'pointer-events-none flex shrink-0 items-center gap-1 opacity-0 transition-opacity duration-200'
          : 'flex shrink-0 items-center gap-1 opacity-100 transition-opacity duration-200'
      }
    >
      <RoomWorkingChip count={working} roomName={roomName} />
      <RoomHaltButton roomId={roomId} roomName={roomName} />
    </div>
  );
}
