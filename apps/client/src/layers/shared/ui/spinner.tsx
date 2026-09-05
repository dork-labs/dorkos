/**
 * The app's one spinning-loader glyph.
 *
 * `Loader2 + animate-spin` was written by hand at 44 call sites, at six
 * different sizes for the same "inline loading" job, in two spellings of the
 * same Tailwind v4 token, and with `aria-hidden` on some and missing on others
 * — so a decorative spinner was read aloud in half the app (DOR-1763 finding
 * 17.9). This is that convention as a component: pick a size from the shared
 * icon scale, and the accessibility answer comes with it.
 *
 * @module shared/ui/spinner
 */
import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/layers/shared/lib/utils';

const spinnerVariants = cva('animate-spin', {
  variants: {
    // The shared icon scale, not literal pixels: these tokens grow with the
    // app's icon-size setting, so a spinner beside an icon stays its size.
    size: {
      xs: 'size-(--size-icon-xs)',
      sm: 'size-(--size-icon-sm)',
      md: 'size-(--size-icon-md)',
      lg: 'size-8',
    },
  },
  defaultVariants: { size: 'sm' },
});

/** Everything a spinner draws — its size, and whether it speaks. */
export interface SpinnerProps
  extends Omit<React.ComponentProps<typeof Loader2>, 'size'>, VariantProps<typeof spinnerVariants> {
  /**
   * What a screen reader should announce, for a spinner that is the only sign
   * anything is happening. Leave it off — the default — when text beside the
   * spinner already says it; the glyph is then hidden from screen readers
   * instead of being read as an unlabelled image.
   */
  label?: string;
}

/**
 * A spinning loader.
 *
 * Decorative by default: without a `label` it is `aria-hidden`, because a
 * spinner beside the words "Loading agents" is the same fact twice. Pass
 * `label` when the spinner stands alone and a reader would otherwise be told
 * nothing at all.
 *
 * @param size - `xs`, `sm` (default), `md`, or `lg` on the shared icon scale.
 * @param label - Announce this instead of hiding the spinner.
 */
function Spinner({ className, size, label, ...props }: SpinnerProps) {
  return (
    <Loader2
      data-slot="spinner"
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn(spinnerVariants({ size }), className)}
      {...props}
    />
  );
}

export { Spinner, spinnerVariants };
