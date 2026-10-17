import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * `twMerge`, told about the font-size names it cannot recognize by shape.
 *
 * tailwind-merge knows `text-2xs` or `text-lg` is a size from the name alone,
 * and reads any other `text-<word>` as a colour. The DorkOS app passes its
 * 13px `text-control` label size into these components through `className`;
 * unregistered, it would keep the component's own `text-sm` beside it, and a
 * text colour passed with it (`text-foreground`) would drop it altogether.
 */
const twMerge = extendTailwindMerge({
  extend: { classGroups: { 'font-size': [{ text: ['control'] }] } },
});

/** Merge classes while resolving Tailwind conflicts. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
