/**
 * One touch chip — a single thing the turn handled, and what happened to it.
 *
 * @module features/chat/ui/chips/TouchChip
 */
import { cn } from '@/layers/shared/lib';
import type { TouchChip as TouchChipData } from '../../lib/touch-chips';
import { VERB_ICON, VERB_LABEL } from './chip-verbs';

export interface TouchChipProps {
  /** The folded record of everything that happened to this target. */
  chip: TouchChipData;
  /** Open the chip's target. Called for every chip; a chip with nowhere to go is a no-op. */
  onOpen: (chip: TouchChipData) => void;
}

/**
 * Whether clicking this chip goes anywhere. Files and URLs open in the canvas;
 * a bare command or a search pattern has no surface to open, so its chip is a
 * record rather than a control and is styled as one.
 */
function isOpenable(chip: TouchChipData): boolean {
  return chip.kind !== 'command';
}

/** The native tooltip: the full target, then the audit trail of every touch. */
function tooltipFor(chip: TouchChipData): string {
  return [chip.fullTarget, chip.history.join(', ')].filter(Boolean).join('\n');
}

/**
 * Render one chip: its verb glyph, its name, a `×N` badge once it has been
 * touched more than once, and a diffstat once something has been changed.
 *
 * A deleted target keeps its chip as a struck-through tombstone — the design is
 * explicit that a deletion is never invisible — and a failed one carries the
 * destructive tint.
 *
 * `data-verb` and `data-live` are what the verb animations key off once they
 * land; they are written here so nothing has to be re-plumbed to switch them on.
 *
 * @param props - The chip model and the open handler.
 */
export function TouchChip({ chip, onOpen }: TouchChipProps) {
  const openable = isOpenable(chip);
  const tombstone = chip.verb === 'delete';
  const hasDiffstat = chip.additions !== undefined || chip.deletions !== undefined;

  return (
    <button
      type="button"
      data-testid="touch-chip"
      data-verb={chip.verb}
      data-live={chip.live}
      title={tooltipFor(chip)}
      aria-label={`${VERB_LABEL[chip.verb]} ${chip.fullTarget}`}
      onClick={() => onOpen(chip)}
      className={cn(
        'inline-flex max-w-56 items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs',
        'bg-card text-foreground border-border',
        'focus-visible:ring-ring/50 outline-none focus-visible:ring-2',
        openable ? 'hover:bg-accent hover:text-accent-foreground' : 'cursor-default',
        tombstone && 'text-muted-foreground line-through opacity-60',
        chip.error && 'border-destructive/40 bg-destructive/10 text-destructive'
      )}
    >
      <span aria-hidden="true" className="shrink-0 leading-none">
        {VERB_ICON[chip.verb]}
      </span>
      <span className="truncate">{chip.label}</span>
      {chip.touches > 1 && (
        <span className="text-muted-foreground shrink-0 tabular-nums">×{chip.touches}</span>
      )}
      {hasDiffstat && (
        <span className="shrink-0 tabular-nums">
          <span className="text-emerald-600 dark:text-emerald-400">+{chip.additions ?? 0}</span>{' '}
          <span className="text-red-600 dark:text-red-400">−{chip.deletions ?? 0}</span>
        </span>
      )}
    </button>
  );
}
