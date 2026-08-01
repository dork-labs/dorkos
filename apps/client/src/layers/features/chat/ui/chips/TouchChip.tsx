/**
 * One touch chip — a single thing the turn handled, and what happened to it.
 *
 * @module features/chat/ui/chips/TouchChip
 */
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { cn } from '@/layers/shared/lib';
import type { TouchChip as TouchChipData } from '../../lib/touch-chips';
import { CHIP_MORPH, CHIP_RING, chipEntryMotion } from './chip-motion';
import { VERB_ICON, VERB_LABEL } from './chip-verbs';
import { useUpgradePulse } from './use-upgrade-pulse';

export interface TouchChipProps {
  /** The folded record of everything that happened to this target. */
  chip: TouchChipData;
  /** Open the chip's target. Called for every chip; a chip with nowhere to go is a no-op. */
  onOpen: (chip: TouchChipData) => void;
  /**
   * Whether this chip is in the live row, where it pops in on arrival and is
   * absorbed into the pile on its way out. Chips in the tray are a record being
   * read rather than something arriving, so they default to still.
   */
  animated?: boolean;
}

/**
 * Whether clicking this chip goes anywhere. Files and URLs open in the canvas;
 * a bare command, a search query, or a glob pattern has no single surface to
 * open, so its chip is a record rather than a control and is styled as one.
 *
 * The pattern case reads the accumulator's flag rather than looking for a `*`
 * in the string: `index.ts` is both a valid path and a valid glob, and only the
 * tool that produced it knows which it meant.
 */
function isOpenable(chip: TouchChipData): boolean {
  return chip.kind !== 'command' && chip.pattern !== true;
}

/** The native tooltip: the full target, the audit trail, and why a chip is inert. */
function tooltipFor(chip: TouchChipData): string {
  return [
    chip.fullTarget,
    chip.history.join(', '),
    chip.pattern === true ? 'A pattern, not one file — there is nothing to open.' : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * What the chip is called out loud. The glyph and the badges are decoration to a
 * screen reader, so everything they carry — the verb, the repeat count, the
 * diffstat — is said here instead.
 */
function accessibleNameFor(chip: TouchChipData): string {
  const parts = [`${VERB_LABEL[chip.verb]} ${chip.fullTarget}`];
  if (chip.touches > 1) parts.push(`${chip.touches} times`);
  if (chip.hits !== undefined) parts.push(hitsLabel(chip.hits));
  if (chip.additions !== undefined) parts.push(`${chip.additions} added`);
  if (chip.deletions !== undefined) parts.push(`${chip.deletions} removed`);
  if (chip.error) parts.push('failed');
  return parts.join(', ');
}

/** `1 hit` / `14 hits` — the badge text and the spoken one, from one place. */
function hitsLabel(hits: number): string {
  return hits === 1 ? '1 hit' : `${hits} hits`;
}

/**
 * Render one chip: its verb glyph, its name, a `×N` badge once it has been
 * touched more than once, and a diffstat once something has been changed.
 *
 * A deleted target keeps its chip as a struck-through tombstone — the design is
 * explicit that a deletion is never invisible — and a failed one carries the
 * destructive tint.
 *
 * A file that was read and is now being changed does not get a second chip: this
 * one morphs in place, the icon flipping to the pencil with a single ring pulse
 * and the diffstat sliding in beside it.
 *
 * `data-verb` and `data-live` are what the verb animations key off once they
 * land; they are written here so nothing has to be re-plumbed to switch them on.
 *
 * @param props - The chip model, the open handler, and whether it is in the live row.
 */
export function TouchChip({ chip, onOpen, animated = false }: TouchChipProps) {
  const reducedMotion = useReducedMotion() ?? false;
  const pulse = useUpgradePulse(chip.upgraded === true);
  const openable = isOpenable(chip);
  const tombstone = chip.verb === 'delete';
  const hasDiffstat = chip.additions !== undefined || chip.deletions !== undefined;

  return (
    <motion.button
      {...chipEntryMotion(animated, reducedMotion)}
      type="button"
      data-testid="touch-chip"
      data-verb={chip.verb}
      data-live={chip.live}
      title={tooltipFor(chip)}
      aria-label={accessibleNameFor(chip)}
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
      {/* Fixed width: the glyph swaps mid-flip, and a wider one must not push
          the name along with it. */}
      <span className="relative inline-flex w-4 shrink-0 items-center justify-center leading-none [perspective:400px]">
        <AnimatePresence initial={false} mode="wait">
          <motion.span
            // The verb is the key, so the icon flips exactly when the verb
            // changes — once per upgrade, not once per render.
            key={chip.verb}
            aria-hidden="true"
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, rotateX: -90 }}
            animate={reducedMotion ? { opacity: 1 } : { opacity: 1, rotateX: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, rotateX: 90 }}
            transition={CHIP_MORPH}
          >
            {VERB_ICON[chip.verb]}
          </motion.span>
        </AnimatePresence>
        {pulse.pulsing && !reducedMotion && (
          <motion.span
            aria-hidden="true"
            data-testid="chip-upgrade-pulse"
            className="border-primary pointer-events-none absolute -inset-1 rounded-full border"
            initial={{ scale: 0.6, opacity: 0.8 }}
            animate={{ scale: 1.8, opacity: 0 }}
            transition={CHIP_RING}
            onAnimationComplete={pulse.end}
          />
        )}
      </span>
      <span className="truncate">{chip.label}</span>
      {chip.touches > 1 && (
        <span className="text-muted-foreground shrink-0 tabular-nums">×{chip.touches}</span>
      )}
      {chip.hits !== undefined && (
        <span className="text-muted-foreground shrink-0 tabular-nums">{hitsLabel(chip.hits)}</span>
      )}
      {hasDiffstat && (
        <motion.span
          className="shrink-0 tabular-nums"
          // The numbers slide in with the morph that earned them, and are simply
          // there on a chip that was already edited when it mounted.
          initial={pulse.pulsing && !reducedMotion ? { opacity: 0, x: -4 } : false}
          animate={{ opacity: 1, x: 0 }}
          transition={CHIP_MORPH}
        >
          {/* Each half appears only if something measured it. A created file
              gained lines and lost none, and `−0` would state a measurement
              nothing ever made. */}
          {chip.additions !== undefined && (
            <span className="text-emerald-600 dark:text-emerald-400">+{chip.additions}</span>
          )}
          {chip.additions !== undefined && chip.deletions !== undefined && ' '}
          {chip.deletions !== undefined && (
            <span className="text-red-600 dark:text-red-400">−{chip.deletions}</span>
          )}
        </motion.span>
      )}
    </motion.button>
  );
}
