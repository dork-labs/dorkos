/**
 * The header badge that says how much of a bridged group Telegram lets the
 * bot see (chats-as-channels spec §8).
 *
 * @module entities/room/ui/BridgeVisibilityBadge
 */
import { useState } from 'react';
import { cn } from '@/layers/shared/lib';
import {
  badgeVariants,
  ResponsivePopover,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
  ResponsivePopoverTrigger,
} from '@/layers/shared/ui';

export interface BridgeVisibilityBadgeProps {
  /**
   * `'partial'` (mentions, commands, and replies only) or `'full'`
   * (everything). Never pass `null` here — the caller gates on it, because a
   * bridged DM has no badge at all (spec §8, "a DM has no badge") and a
   * never-checked group already degrades to `'partial'` server-side rather
   * than reaching the client as an absence to handle.
   */
  visibility: 'partial' | 'full';
  className?: string;
}

const VISIBILITY_LABEL: Record<'partial' | 'full', string> = {
  partial: 'sees mentions only',
  full: 'sees everything',
};

/**
 * "sees mentions only" / "sees everything" — Telegram's own privacy-mode
 * switch for the bot, sourced from the bridge row's `visibility` (which is
 * sourced from `getMe`, never from config or from anything this client
 * infers from the log).
 *
 * **A disclosure, never a control.** Pressing it opens an explanation, not a
 * switch — there is nothing here to flip, and rendering one would tell a
 * reader the opposite of the truth: the popover says outright that changing
 * this means leaving and rejoining the group on Telegram's side, not
 * pressing anything in DorkOS. The trigger is a plain `<button>` styled as a
 * label, deliberately never a `Switch`/`Toggle` or anything wearing an
 * on/off affordance.
 *
 * **The expanded copy states two honest gaps, not one.** A badge that only
 * explained Telegram's switch would still mislead: `respondMode` is a
 * SECOND gate DorkOS applies on top of whatever Telegram lets through, so a
 * room reading "sees everything" next to a log of nothing but mentions is
 * not lying — the badge says so itself (spec §8's own words: "a person
 * reading 'sees everything' next to a log of only mentions would rightly
 * conclude the product is lying").
 */
export function BridgeVisibilityBadge({ visibility, className }: BridgeVisibilityBadgeProps) {
  const [open, setOpen] = useState(false);
  const label = VISIBILITY_LABEL[visibility];

  return (
    <ResponsivePopover open={open} onOpenChange={setOpen}>
      <ResponsivePopoverTrigger asChild>
        <button
          type="button"
          data-testid="bridge-visibility-badge"
          data-visibility={visibility}
          // Not `aria-pressed` and not `role="switch"` — both would tell a
          // screen reader this is a control with a state to flip, which is
          // exactly the claim §8 forbids the badge from making.
          aria-haspopup="dialog"
          aria-expanded={open}
          // The badge's own shell, from the badge's own recipe — but still a
          // `<button>`: §8 forbids this from claiming to be a control you flip,
          // and `Badge` would make it a `<span>` with no popover to open.
          className={cn(
            badgeVariants({ shape: 'pill', variant: 'outline' }),
            'text-muted-foreground hover:text-foreground text-2xs h-6 shrink-0 px-2.5',
            className
          )}
        >
          {label}
        </button>
      </ResponsivePopoverTrigger>
      <ResponsivePopoverContent className="w-72 space-y-2 p-3 text-sm" align="start">
        <ResponsivePopoverTitle className="text-sm font-semibold">
          What this room can see
        </ResponsivePopoverTitle>
        <p className="text-muted-foreground text-xs">
          This is Telegram&apos;s own privacy switch for the bot, not a DorkOS setting. You
          can&apos;t change it here. Turning it off means removing the bot from this group and
          adding it back after flipping the switch in Telegram.
        </p>
        <p className="text-muted-foreground text-xs">
          The switch is bot-wide, not per group: if the bot was added here before you last changed
          it, this group can still be limited even though the switch now says otherwise. It only
          applies in groups where it was added after this was set.
        </p>
        <p className="text-muted-foreground text-xs">
          This badge only describes Telegram&apos;s side. DorkOS has a reply setting of its own for
          this room that can narrow things further, so a bot Telegram lets see everything can still
          only act on messages that mention it.
        </p>
      </ResponsivePopoverContent>
    </ResponsivePopover>
  );
}
