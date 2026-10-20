import { Wifi } from 'lucide-react';
import { useOnWifi } from '@/layers/entities/config';
import { cn } from '@/layers/shared/lib';
import { useIsTouchOnly } from '@/layers/shared/model';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/layers/shared/ui';

/** The pill's words. */
export const WIFI_TURN_CAP_LABEL = 'On Wi-Fi · agents ask or only read';
/** What the pill says on hover, focus, or tap. */
export const WIFI_TURN_CAP_DETAIL =
  'Over Wi-Fi, every file or shell step needs your OK, or agents only read.';

/**
 * A 44px-square hit area around the pill (Apple HIG), drawn as an invisible
 * pseudo-element so the icon stays small and the line keeps its height. The
 * pill's side margins plus the row's gap keep it clear of its neighbours' taps.
 *
 * @internal
 */
const HIT_AREA =
  "relative after:absolute after:top-1/2 after:left-1/2 after:size-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']";

interface WifiTurnCapPillProps {
  /**
   * Say it in as few pixels as possible, as the line's other items do below
   * `full`: the icon alone, so a phone-width line keeps room for the chip
   * beside it ("Default (Wi-Fi)"). The words stay in its label and tooltip.
   */
  compact?: boolean;
}

/**
 * Says, while this browser reached DorkOS over Wi-Fi, that a chat started here
 * runs at the runtime's default at most: every file or shell step asks, and an
 * answer is Allow once or Deny, or, on a runtime whose default only reads
 * (Codex), the agent only reads (DOR-3037). Draws nothing anywhere else.
 *
 * It sits outside the status line's budget, beside the Session `⋯`, so a busy
 * line never hides it: the limit applies to every message sent from here.
 *
 * A button, so the line behind it reads by keyboard as well as by hover. On a
 * touch-only device a tap opens the line in a popover instead, since a tooltip
 * never shows for a finger; it stays on screen and closes on an outside tap or
 * Esc.
 */
export function WifiTurnCapPill({ compact }: WifiTurnCapPillProps) {
  const onWifi = useOnWifi();
  const touchOnly = useIsTouchOnly();
  if (!onWifi) return null;

  const pill = (
    <button
      type="button"
      data-testid="wifi-turn-cap"
      aria-label={`${WIFI_TURN_CAP_LABEL}. ${WIFI_TURN_CAP_DETAIL}`}
      className={cn(
        'border-border text-muted-foreground inline-flex items-center gap-1 rounded-full border py-0.5',
        HIT_AREA,
        // On touch the tap opens the line; with a mouse it only reveals it.
        touchOnly ? 'cursor-pointer' : 'cursor-default',
        compact ? 'mx-1.5 px-1' : 'px-2',
        'focus-visible:ring-ring outline-none focus-visible:ring-[3px]'
      )}
    >
      <Wifi aria-hidden className="size-(--size-icon-xs) shrink-0" />
      {!compact && <span>{WIFI_TURN_CAP_LABEL}</span>}
    </button>
  );

  if (touchOnly) {
    return (
      <Popover>
        <PopoverTrigger asChild>{pill}</PopoverTrigger>
        <PopoverContent
          side="top"
          collisionPadding={8}
          data-testid="wifi-turn-cap-detail"
          className="w-auto max-w-70 p-3 text-xs"
        >
          {WIFI_TURN_CAP_DETAIL}
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{pill}</TooltipTrigger>
      <TooltipContent side="top">{WIFI_TURN_CAP_DETAIL}</TooltipContent>
    </Tooltip>
  );
}
