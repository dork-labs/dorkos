/**
 * One chip: what one agent tool does with one agent file.
 *
 * @module entities/harness/ui/HarnessStateChip
 */
import { TriangleAlert } from 'lucide-react';
import type { HarnessCell, HarnessId } from '@dorkos/shared/harness-schemas';
import { cn } from '@/layers/shared/lib/utils';
import { STATUS_TONE_SURFACE } from '@/layers/shared/ui';
import {
  HARNESS_CHIP_TONE,
  harnessChipDescription,
  harnessChipWord,
  type HarnessChipTone,
} from '../lib/harness-status';

/**
 * The surface each tone wears.
 *
 * Three of the four are the app's own tinted status surfaces, so a warning chip
 * is the same amber as a warning banner in both themes. `muted` is the fourth
 * and is not a colour at all: a dashed outline with no fill, because "this tool
 * can't see it" has to read as absence and the design system's rule for a muted
 * thing is fewer signals, never less contrast — the label keeps the muted
 * foreground it would have had, and what it gives up is the fill.
 */
const CHIP_SURFACE = {
  neutral: STATUS_TONE_SURFACE.neutral,
  info: STATUS_TONE_SURFACE.info,
  warning: STATUS_TONE_SURFACE.warning,
  muted: 'border border-dashed border-border text-muted-foreground',
} satisfies Record<HarnessChipTone, string>;

/** What a {@link HarnessStateChip} is saying. */
export interface HarnessStateChipProps {
  /** The agent tool the chip is about. */
  harness: HarnessId;
  /** What that tool does with this file. */
  cell: HarnessCell;
}

/**
 * One agent tool's state for one file, as a chip in the row's chip list.
 *
 * **It is a list item, and it is named twice on purpose.** `listitem` takes its
 * accessible name from the author rather than from its contents, so the visible
 * words are repeated in `aria-label` — that is what makes the chip reachable by
 * the name a sighted reader sees rather than by a class.
 *
 * The reason rides `title`, which the accessibility tree reads as the chip's
 * DESCRIPTION once the label has named it — the same split `ProvenanceChip`
 * makes for its warning.
 *
 * **Which reasons have a second home, exactly.** All of them do now. A `dropped`
 * reason is repeated in full and verbatim by the "Not shared with `<harness>`"
 * panel. A `drifted` or `conflict` cell is what the drift banner is about, and
 * it says so in words a person can read without hovering anything — "some agent
 * files are out of date", "DorkOS can't update some files" — with every path a
 * sync would remove, and the reason each one goes, in its disclosure and again
 * in the "what changed" summary afterwards. A `pending-approval` cell is named
 * by the approval card itself, which is the surface built to show the commands,
 * and the summary says a package is waiting. So this description is a
 * convenience everywhere, which is what a `title` on a non-focusable `<li>` has
 * to be (DOR-1895 closed the gap DOR-1893 recorded here).
 *
 * A cell that landed but may not work keeps its state chip and gains a marker
 * beside the words, whose own description is the warning text. Two facts, two
 * marks — the state is still the state.
 */
export function HarnessStateChip({ harness, cell }: HarnessStateChipProps) {
  const word = harnessChipWord(harness, cell.state);
  const description = harnessChipDescription(cell);
  const warning = cell.warnings?.length ? cell.warnings.join(' · ') : undefined;

  return (
    <li
      aria-label={word}
      {...(description === undefined ? {} : { title: description })}
      className={cn(
        'text-3xs inline-flex items-center gap-1 rounded-full px-2 py-0.5 leading-tight',
        CHIP_SURFACE[HARNESS_CHIP_TONE[cell.state]]
      )}
    >
      {word}
      {warning !== undefined && (
        <span role="img" aria-label="May not work" title={warning} className="inline-flex">
          <TriangleAlert aria-hidden className="text-status-warning-fg size-2.5" />
        </span>
      )}
    </li>
  );
}
