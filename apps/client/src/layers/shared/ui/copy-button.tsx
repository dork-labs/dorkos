import { Check, Copy, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { cn, useCopyFeedback } from '@/layers/shared/lib';
import { Button } from './button';

interface CopyButtonProps {
  /** Text copied to clipboard on click. */
  value: string;
  /** Optional aria-label override. Default: "Copy to clipboard". */
  label?: string;
  /** Override className for the button wrapper. */
  className?: string;
  /** Icon size — defaults to size-3.5 to match current usage. */
  size?: 'sm' | 'md';
}

/** Which glyph the button is showing — also the swap's animation key. */
type CopyButtonState = 'idle' | 'copied' | 'failed';

/**
 * Which glyph belongs to the current feedback state.
 *
 * A named function rather than two inline ternaries, because it is also the
 * `AnimatePresence` key: the thing that decides what is drawn and the thing
 * that decides when to re-draw it must be the same value, or a swap can be
 * missed.
 *
 * @param copied - The clipboard write succeeded, and the timer has not expired.
 * @param failed - The clipboard write threw.
 */
function copyButtonState(copied: boolean, failed: boolean): CopyButtonState {
  if (copied) return 'copied';
  if (failed) return 'failed';
  return 'idle';
}

/** The button's icon: a check on success, an X on failure, the bare glyph otherwise. */
function CopyButtonIcon({ state, size }: { state: CopyButtonState; size: string }) {
  if (state === 'copied') return <Check className={cn(size, 'text-status-success')} />;
  if (state === 'failed') return <X className={cn(size, 'text-destructive')} />;
  return <Copy className={size} />;
}

/**
 * Icon button that copies a string to the clipboard with timed inline feedback.
 *
 * Uses {@link useCopyFeedback} to manage the success/failure state. Defaults
 * match the compact form used inside Settings dialogs (size-3.5 icon,
 * muted-foreground hover).
 *
 * **The glyph swap is the confirmation, so it is animated.** Copy → check →
 * copy used to be three instantaneous replacements, on the one control in the
 * app whose whole job is answering "did that work?". The crossfade carries the
 * answer rather than decorating it. Under reduced motion the app-wide
 * `MotionConfig` drops the scale and keeps the fade, which still reads.
 */
export function CopyButton({
  value,
  label = 'Copy to clipboard',
  className,
  size = 'sm',
}: CopyButtonProps) {
  const { copied, failed, copy } = useCopyFeedback();
  const iconSize = size === 'md' ? 'size-4' : 'size-3.5';
  const state = copyButtonState(copied, failed);
  return (
    // `Button`, not a hand-rolled one: this used to be `p-1` around a 14px glyph
    // — a ~22px target, half of the 44px a thumb needs — and it had to remember
    // the focus ring, the press and the disabled treatment on its own.
    // `icon-sm` is 32px under a mouse and 40px on a phone.
    <Button
      variant="ghost"
      size="icon-sm"
      className={cn('text-muted-foreground hover:text-foreground', className)}
      onClick={() => void copy(value)}
      aria-label={failed ? "Couldn't copy — try again" : label}
    >
      {/* `mode="wait"`, so the outgoing glyph is gone before the next arrives —
          two 14px icons stacked in one 14px box would otherwise overlap. */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={state}
          className="block"
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.8 }}
          transition={{ duration: 0.12 }}
        >
          <CopyButtonIcon state={state} size={iconSize} />
        </motion.span>
      </AnimatePresence>
    </Button>
  );
}
