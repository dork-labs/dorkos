import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { TriangleAlert } from 'lucide-react';
import { cn } from '@/layers/shared/lib/utils';
import { Badge } from './badge';
import { Chip } from './chip';
import { STATUS_TONE_TEXT } from './status-dot';
import {
  ResponsivePopover,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
  ResponsivePopoverTrigger,
} from './responsive-popover';

/**
 * The label's crossfade: opacity only, 120ms ease-out. It says "what changed"
 * and nothing else, so there is no travel and no spring to settle.
 */
const LABEL_FADE = { duration: 0.12, ease: 'easeOut' } as const;

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
 * Inert, it is a {@link Badge}; set here, it is a {@link Chip} that opens the
 * one action. The label crossfades over 120ms, opacity only, so "set here" to
 * "server default · Opus" reads as the same chip changing its mind rather than
 * two chips swapping places. Under reduced motion the label just changes.
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
  const label = isSetHere ? 'Set here' : `Server default · ${serverDefault ?? 'none'}`;
  const interactive = isSetHere && !!onUseServerDefault;
  const reducedMotion = useReducedMotion();

  const words = (
    <AnimatePresence mode="wait" initial={false}>
      <motion.span
        key={label}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={reducedMotion ? { duration: 0 } : LABEL_FADE}
        className="block truncate"
      >
        {label}
      </motion.span>
    </AnimatePresence>
  );

  if (!interactive) {
    return (
      <Badge
        size="xs"
        tone={warning ? 'warning' : 'neutral'}
        title={warning ? `${label}: ${warning}` : label}
        aria-label={warning ? `${label}: ${warning}` : undefined}
        className={cn('max-w-56', className)}
        data-testid={testId}
      >
        {words}
      </Badge>
    );
  }

  return (
    <ResponsivePopover open={open} onOpenChange={setOpen}>
      <ResponsivePopoverTrigger asChild>
        <Chip
          size="sm"
          icon={warning ? TriangleAlert : undefined}
          iconClassName={warning ? STATUS_TONE_TEXT.warning : undefined}
          aria-label={`Set here${warning ? `: ${warning}` : ''}`}
          title={warning ? `${label}: ${warning}` : label}
          className={className}
          data-testid={testId}
        >
          {words}
        </Chip>
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
            <span className="text-muted-foreground block text-xs">Currently {serverDefault}</span>
          ) : (
            <span className="text-muted-foreground block text-xs">
              Not set. Uses the built-in default.
            </span>
          )}
        </button>
      </ResponsivePopoverContent>
    </ResponsivePopover>
  );
}
