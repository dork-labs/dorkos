import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { TriangleAlert } from 'lucide-react';
import { cn } from '../lib/utils';
import { STATUS_TONE_SURFACE, STATUS_TONE_TEXT } from './status-dot';
import {
  ResponsivePopover,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
  ResponsivePopoverTrigger,
} from './responsive-popover';

/**
 * The 120ms crossfade with the messaging spring settle (spec `execution-defaults`
 * §3.1). Written out here rather than imported because there is no shared motion
 * token module yet; the numbers are the messaging set's, and this is the second
 * place to want them — a third should lift them into one.
 */
const CHIP_TRANSITION = { duration: 0.12, ease: 'easeOut' } as const;
const CHIP_SETTLE = { type: 'spring', stiffness: 320, damping: 28 } as const;

/** What a {@link ProvenanceChip} is saying about one setting. */
export interface ProvenanceChipProps {
  /**
   * Whether the value was set on this surface. `false` means it is inherited
   * from the server's default, which is the resting state.
   */
  isSetHere: boolean;
  /**
   * The server default this setting would fall back to, written for a person —
   * shown both in the inherited chip's label and in the reset action's wording.
   * `null` when the server has no default either, which makes the reset honest
   * about handing the choice back to the runtime.
   */
  serverDefault: string | null;
  /**
   * Restore the inherited value. Absent → the chip is a label only, which is
   * what an inherited chip already is.
   */
  onUseServerDefault?: () => void;
  /**
   * A reason this value cannot be honored as written, or `null`. Present turns
   * the chip warning-colored and shows the sentence inside the popover, so
   * nothing is hidden and nothing is only a color (spec §3.4).
   */
  warning?: string | null;
  /** Extra classes for the trigger. */
  className?: string;
  /** Test hook. */
  'data-testid'?: string;
}

/**
 * The chip that says where a setting came from — and IS the reset.
 *
 * One affordance, not two: a value set on this surface wears "set here", and
 * clicking it offers exactly one action, "Use server default". An inherited
 * value wears "server default · X" and does nothing when clicked, because there
 * is nothing to undo. That is the design's whole point — the place that explains
 * a value is the place that clears it, so nobody hunts for a reset button
 * (spec `execution-defaults` §3.1).
 *
 * The label crossfades over 120ms and settles on the messaging spring, so the
 * change from "set here" to "server default · Opus" reads as the same chip
 * changing its mind rather than two chips swapping places.
 */
export function ProvenanceChip({
  isSetHere,
  serverDefault,
  onUseServerDefault,
  warning,
  className,
  'data-testid': testId,
}: ProvenanceChipProps) {
  // Controlled so the one action can close the one panel. Left uncontrolled,
  // Radix keeps the popover open over a chip that has already changed its mind
  // — and this chip's whole claim is that clicking it is the undo, which is not
  // legible while the thing you clicked is still hidden behind the menu.
  const [open, setOpen] = useState(false);
  const label = isSetHere ? 'set here' : `server default · ${serverDefault ?? 'none'}`;
  const interactive = isSetHere && !!onUseServerDefault;

  const chip = (
    <span
      className={cn(
        'text-3xs inline-flex h-5 items-center gap-1 rounded-full px-2 leading-none whitespace-nowrap',
        warning ? STATUS_TONE_SURFACE.warning : STATUS_TONE_SURFACE.neutral,
        interactive && 'hover:bg-accent hover:text-accent-foreground transition-colors',
        className
      )}
      data-testid={testId}
    >
      {warning && <TriangleAlert className="size-2.5 shrink-0" aria-hidden />}
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={label}
          initial={{ opacity: 0, y: 2 }}
          animate={{ opacity: 1, y: 0, transition: CHIP_SETTLE }}
          exit={{ opacity: 0 }}
          transition={CHIP_TRANSITION}
        >
          {label}
        </motion.span>
      </AnimatePresence>
    </span>
  );

  if (!interactive) {
    return warning ? (
      <span title={warning} aria-label={`${label} — ${warning}`}>
        {chip}
      </span>
    ) : (
      chip
    );
  }

  return (
    <ResponsivePopover open={open} onOpenChange={setOpen}>
      <ResponsivePopoverTrigger asChild>
        <button type="button" aria-label={`Set here${warning ? ` — ${warning}` : ''}`}>
          {chip}
        </button>
      </ResponsivePopoverTrigger>
      <ResponsivePopoverContent className="w-64 p-2" align="start">
        <ResponsivePopoverTitle>Where this value comes from</ResponsivePopoverTitle>
        {warning && <p className={cn('px-2 pt-1 text-xs', STATUS_TONE_TEXT.warning)}>{warning}</p>}
        <button
          type="button"
          onClick={() => {
            onUseServerDefault();
            setOpen(false);
          }}
          className="hover:bg-accent mt-1 w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors"
          data-testid={testId ? `${testId}-reset` : undefined}
        >
          Use server default
          {serverDefault ? (
            <span className="text-muted-foreground block text-xs">currently {serverDefault}</span>
          ) : (
            <span className="text-muted-foreground block text-xs">
              the runtime picks — nothing is set
            </span>
          )}
        </button>
      </ResponsivePopoverContent>
    </ResponsivePopover>
  );
}
