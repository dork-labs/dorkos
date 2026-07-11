import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { TriangleAlert } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { Button } from '@/layers/shared/ui';

/**
 * Shared chrome for the diff-review surfaces (text merge view + image modes):
 * the notice banner, the segmented-control pill, the centered status message,
 * and the two-step armed destructive button. One module so both surfaces stay
 * visually and behaviorally identical.
 *
 * @module features/diff-review/ui/diff-chrome
 */

/** A calm inline notice strip below a review header (conflict / write-failure). */
export function Banner({
  tone,
  reduceMotion,
  children,
}: {
  tone: 'warn' | 'error';
  reduceMotion: boolean | null;
  children: React.ReactNode;
}) {
  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
      className={cn(
        'mx-2 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-3 py-2 text-sm',
        tone === 'warn'
          ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
          : 'bg-destructive/10 text-destructive'
      )}
    >
      {children}
    </motion.div>
  );
}

/** A pill button inside a segmented control (compare-against, image modes). */
export function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex items-center rounded px-2 py-0.5 text-xs transition-colors',
        active
          ? 'bg-secondary text-secondary-foreground'
          : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {children}
    </button>
  );
}

/** Centered muted message for empty/error/loading diff states. */
export function DiffMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground flex h-full items-center justify-center p-8 text-center">
      <p>{children}</p>
    </div>
  );
}

/** How long an armed destructive button stays armed before quietly disarming (ms). */
const ARM_TIMEOUT_MS = 5000;

/**
 * A destructive action behind a two-step confirm: the first click arms the
 * button (destructive variant + confirm label), a second click within the arm
 * window executes, and inactivity quietly disarms. `requireConfirm: false`
 * executes on the first click (the caller decides when the stakes warrant the
 * gate — e.g. a degraded diff base).
 */
export function ArmedButton({
  label,
  confirmLabel,
  ariaLabel,
  confirmAriaLabel,
  icon,
  requireConfirm,
  disabled,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  ariaLabel: string;
  confirmAriaLabel: string;
  icon: React.ReactNode;
  requireConfirm: boolean;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (disarmTimer.current) clearTimeout(disarmTimer.current);
    },
    []
  );

  const handleClick = () => {
    if (!requireConfirm || armed) {
      setArmed(false);
      if (disarmTimer.current) clearTimeout(disarmTimer.current);
      onConfirm();
      return;
    }
    setArmed(true);
    disarmTimer.current = setTimeout(() => setArmed(false), ARM_TIMEOUT_MS);
  };

  return (
    <Button
      type="button"
      variant={armed ? 'destructive' : 'ghost'}
      size="sm"
      className="h-7"
      disabled={disabled}
      aria-label={armed ? confirmAriaLabel : ariaLabel}
      onClick={handleClick}
    >
      {armed ? <TriangleAlert className="mr-1 size-3.5" /> : icon}
      {armed ? confirmLabel : label}
    </Button>
  );
}
