import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * `twMerge`, told about the app's own font-size tokens.
 *
 * tailwind-merge recognizes `text-2xs` and `text-3xs` as sizes by their shape,
 * but reads any other `text-<word>` as a colour. Unregistered, `text-control`
 * would silently drop the `text-muted-foreground` beside it and keep a
 * `text-xs` it should replace.
 */
const twMerge = extendTailwindMerge({
  extend: { classGroups: { 'font-size': [{ text: ['control'] }] } },
});

/** Merge Tailwind class names with conflict resolution via `clsx` and `twMerge`. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
