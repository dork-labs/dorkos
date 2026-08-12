/**
 * The scope chip — what the palette is looking inside, said on screen.
 *
 * @module features/command-palette/ui/PaletteScopeChip
 */
import { AgentAvatar, resolveAgentVisual } from '@/layers/entities/agent';
import { RoomAvatar, RoomTitle } from '@/layers/entities/room';
import { cn, getAgentDisplayName } from '@/layers/shared/lib';
import type { PaletteScope } from '../model/palette-scope';

/** What {@link PaletteScopeChip} needs to draw the active scope. */
export interface PaletteScopeChipProps {
  /** What the palette is scoped to. */
  scope: PaletteScope;
  className?: string;
}

/**
 * Draw the active scope as a chip in the search line.
 *
 * **It has no close button, and that is the design rather than an omission.**
 * §15's whole argument for chips over a query language is that the scope is
 * VISIBLE — not that it is clickable — and the way out is the key a person's
 * hands are already on: Backspace, with the caret at the start of what they
 * typed. A small × beside the name would add a second way to do one thing, at
 * the exact spot the fastest keyboard path already lands, and it would be the
 * only mouse target inside a control nothing else in the palette asks you to
 * click. The footer says `Backspace — Clear scope, at the start` while a chip is
 * up, so the way out and its one condition are both told rather than hidden
 * (spec `rooms` §14.5: a shortcut nobody is told about is folklore).
 *
 * The face is the subject's own — the agent's emoji and colour, or the `#` a
 * channel is drawn with everywhere else — so a person recognises the chip
 * before they read it.
 *
 * The chip is decorative in the accessibility tree's sense of structure but not
 * of content: it is announced as part of the search line's label, because
 * "what am I searching inside" is exactly the thing a screen reader user cannot
 * see.
 */
export function PaletteScopeChip({ scope, className }: PaletteScopeChipProps) {
  return (
    <span
      data-testid="palette-scope-chip"
      className={cn(
        'bg-accent text-accent-foreground inline-flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium',
        className
      )}
    >
      {scope.kind === 'agent' ? (
        <>
          <AgentAvatar {...resolveAgentVisual(scope.agent)} size="xs" badge={null} />
          {getAgentDisplayName(scope.agent)}
        </>
      ) : (
        <>
          <RoomAvatar room={scope.room} participants={scope.room.participants} size="xs" />
          {/* `RoomTitle`, not the plain label: the mark beside it already draws
              a channel's `#`, and spelling it again is the `# #general` defect
              DOR-583 fixed on every other room row in the cockpit. It keeps the
              spoken `#general` for assistive technology. */}
          <RoomTitle room={scope.room} />
        </>
      )}
    </span>
  );
}
