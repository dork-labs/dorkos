/**
 * The palette's prefix legend.
 *
 * @module features/command-palette/ui/PalettePrefixLegend
 */
import { cn } from '@/layers/shared/lib';

/** What each prefix narrows the palette to, in the order they read. */
const PREFIXES: readonly { key: string; means: string }[] = [
  { key: '#', means: 'channels' },
  { key: '@', means: 'agents and DMs' },
  { key: '>', means: 'commands' },
];

export interface PalettePrefixLegendProps {
  className?: string;
}

/**
 * Says what `#`, `@` and `>` do.
 *
 * The prefixes are the fastest way through the palette and the only part of it
 * with no affordance at all — a person who has not been told cannot discover
 * them. This is the telling (spec `rooms` §13.2, §13.4).
 *
 * It sits at the foot of the list and in the no-results state, which are the
 * two moments a person is looking for a way through rather than at a result.
 * Not interactive, and not a list of results, so it is hidden from cmdk's
 * keyboard navigation by being plain markup rather than a `CommandItem`.
 */
export function PalettePrefixLegend({ className }: PalettePrefixLegendProps) {
  return (
    <div
      className={cn(
        'text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs',
        className
      )}
    >
      {PREFIXES.map(({ key, means }) => (
        <span key={key} className="inline-flex items-center gap-1">
          <kbd className="bg-muted rounded px-1 py-0.5 font-mono text-3xs">{key}</kbd>
          {means}
        </span>
      ))}
    </div>
  );
}
