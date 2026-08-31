/**
 * One touch chip — a single thing the turn handled, and what happened to it.
 *
 * @module features/chat/ui/chips/TouchChip
 */
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { cn } from '@/layers/shared/lib';
import { hitsLabel, type TouchChip as TouchChipData } from '../../lib/touch-chips';
import { CHIP_MORPH, CHIP_RING, chipEntryMotion } from './chip-motion';
import { VERB_ICON, VERB_LABEL } from './chip-verbs';
import { TickingNumber } from './TickingNumber';

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
  /**
   * Whether this chip's read→edit upgrade still owes the reader its ring. Owned
   * by the strip's upgrade ledger, because the row remounts a chip every time it
   * re-enters. A record being read — the tray, a showcase — is given nothing.
   */
  pulseUpgrade?: boolean;
  /** Called once the ring has been seen, so the same upgrade is never announced twice. */
  onUpgradeSeen?: (key: string) => void;
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
    chip.pattern === true ? 'A pattern, not one file. There is nothing to open.' : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * What the chip is called out loud. The glyph and the badges are decoration to a
 * screen reader, so everything they carry — the verb, the repeat count, the
 * diffstat — is said here instead.
 *
 * Two substitutions the eye makes for itself and a screen reader cannot. A
 * pattern that was read was **globbed**: the tool named a set of files, and
 * "Read src/**\/*.ts" claims it opened one. (A pattern that was deleted really
 * was deleted, so only the read case is renamed.) And a command is said by its
 * label rather than its full text, because a `Bash` call can carry a
 * three-hundred-character script and reading it aloud is not an answer to "what
 * did this turn touch".
 */
function accessibleNameFor(chip: TouchChipData): string {
  const verb = chip.pattern === true && chip.verb === 'read' ? 'Globbed' : VERB_LABEL[chip.verb];
  const target = chip.verb === 'run' ? chip.label : chip.fullTarget;
  const parts = [`${verb} ${target}`];
  if (chip.touches > 1) parts.push(`${chip.touches} times`);
  if (chip.hits !== undefined) parts.push(hitsLabel(chip.hits));
  if (chip.additions !== undefined) parts.push(`${chip.additions} added`);
  if (chip.deletions !== undefined) parts.push(`${chip.deletions} removed`);
  if (chip.error) parts.push('failed');
  return parts.join(', ');
}

/** The pill a count sits in: the repeat badge and the hit badge share it. */
const COUNT_BADGE =
  'bg-muted text-muted-foreground shrink-0 rounded-full px-1.5 text-[10px] leading-[1.4] tabular-nums';

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
 * **What drives the verb animations.** The signatures themselves are CSS
 * (`index.css`, the touch-chip block); this component supplies the three things
 * they key off. `data-verb` says which signature. `data-live` runs the looping
 * ones — read, search, edit, fetch, run — and stops them the frame the tool
 * settles. `data-arriving` plays the two single shots, create and delete, which
 * happen once and have to finish to read at all. The decorations those
 * signatures need — a caret, a block cursor, streaming dots, the pen that draws
 * the border, a spark, a puff — are rendered only for the verb and the moment
 * that uses them, so a settled chip is markup as still as it looks.
 *
 * @param props - The chip model, the open handler, and whether it is in the live row.
 */
export function TouchChip({
  chip,
  onOpen,
  animated = false,
  pulseUpgrade = false,
  onUpgradeSeen,
}: TouchChipProps) {
  const reducedMotion = useReducedMotion() ?? false;
  const pulsing = pulseUpgrade && !reducedMotion;
  const openable = isOpenable(chip);
  const tombstone = chip.verb === 'delete';
  const hasDiffstat = chip.additions !== undefined || chip.deletions !== undefined;
  // A create and a delete are events, not states: the chip plays them as it
  // lands in the live row. Everywhere else — the tray, a showcase, a reopened
  // transcript — is a record being read, and a record does not re-enact itself.
  const arriving = animated && (chip.verb === 'create' || chip.verb === 'delete');

  return (
    <motion.button
      {...chipEntryMotion(animated, reducedMotion)}
      type="button"
      data-testid="touch-chip"
      data-verb={chip.verb}
      data-live={chip.live}
      data-arriving={arriving ? 'true' : undefined}
      title={tooltipFor(chip)}
      aria-label={accessibleNameFor(chip)}
      onClick={() => onOpen(chip)}
      className={cn(
        // Pill, not a card: the mockups draw every chip this way, and it is the
        // shape the app's other inline metadata chips already wear.
        'touch-chip relative inline-flex max-w-56 items-center gap-1.5 rounded-full border',
        'px-2 py-0.5 text-xs',
        'bg-card text-foreground border-border',
        'focus-visible:ring-ring/50 outline-none focus-visible:ring-2',
        openable ? 'hover:bg-accent hover:text-accent-foreground' : 'cursor-default',
        tombstone && 'text-muted-foreground line-through opacity-60',
        chip.error && 'border-destructive/40 bg-destructive/10 text-destructive'
      )}
    >
      {/* The clipped layer the read scan and the search beam travel through. */}
      <span aria-hidden="true" className="chip-sweep" />
      {/* Fixed width: the glyph swaps mid-flip, and a wider one must not push
          the name along with it. */}
      <span className="chip-icon relative inline-flex w-4 shrink-0 items-center justify-center leading-none">
        {/* The glyph's own wrapper, so the scribble wiggle and the bin's chomp
            have a transform to write on that the flip below is not using. */}
        <span className="chip-glyph inline-flex items-center justify-center [perspective:400px]">
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
        </span>
        {pulsing && (
          <motion.span
            aria-hidden="true"
            data-testid="chip-upgrade-pulse"
            className="border-primary pointer-events-none absolute -inset-1 rounded-full border"
            initial={{ scale: 0.6, opacity: 0.8 }}
            animate={{ scale: 1.8, opacity: 0 }}
            transition={CHIP_RING}
            onAnimationComplete={() => onUpgradeSeen?.(chip.key)}
          />
        )}
      </span>
      <span className="chip-label truncate">{chip.label}</span>
      {chip.verb === 'edit' && chip.live && (
        <span aria-hidden="true" data-testid="chip-caret" className="chip-caret" />
      )}
      {chip.verb === 'run' && chip.live && (
        <span aria-hidden="true" data-testid="chip-cursor" className="chip-cursor" />
      )}
      {chip.verb === 'fetch' && chip.live && (
        <span aria-hidden="true" data-testid="chip-dots" className="chip-dots">
          <span />
          <span />
          <span />
        </span>
      )}
      {chip.verb === 'create' && arriving && (
        <>
          <svg aria-hidden="true" data-testid="chip-pen" className="chip-pen">
            {/* `pathLength` normalises the perimeter to 100, so the stroke draws
                at one speed however long the name makes the chip. `rx` is half
                the chip's own height, which is what makes it the same pill. */}
            <rect x="0" y="0" width="100%" height="100%" rx="11" ry="11" pathLength="100" />
          </svg>
          <span aria-hidden="true" className="chip-spark" />
        </>
      )}
      {chip.verb === 'delete' && arriving && (
        <span aria-hidden="true" data-testid="chip-puff" className="chip-puff" />
      )}
      {/* Counts are badges rather than more text on the line: they are about the
          chip, not part of the name, and the mockups set them in their own pill. */}
      {chip.touches > 1 && <span className={COUNT_BADGE}>×{chip.touches}</span>}
      {chip.hits !== undefined && <span className={COUNT_BADGE}>{hitsLabel(chip.hits)}</span>}
      {hasDiffstat && (
        <motion.span
          className="shrink-0 tabular-nums"
          // The numbers slide in with the morph that earned them, and are simply
          // there on a chip that was already edited when it mounted.
          initial={pulsing ? { opacity: 0, x: -4 } : false}
          animate={{ opacity: 1, x: 0 }}
          transition={CHIP_MORPH}
        >
          {/* Each half appears only if something measured it. A created file
              gained lines and lost none, and `−0` would state a measurement
              nothing ever made. */}
          {chip.additions !== undefined && (
            <span className="text-emerald-600 dark:text-emerald-400">
              +<TickingNumber value={chip.additions} live={chip.live} />
            </span>
          )}
          {chip.additions !== undefined && chip.deletions !== undefined && ' '}
          {chip.deletions !== undefined && (
            <span className="text-red-600 dark:text-red-400">
              −<TickingNumber value={chip.deletions} live={chip.live} />
            </span>
          )}
        </motion.span>
      )}
    </motion.button>
  );
}
