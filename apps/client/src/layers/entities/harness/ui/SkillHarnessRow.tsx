/**
 * One skill, and what every agent tool does with it.
 *
 * @module entities/harness/ui/SkillHarnessRow
 */
import { useState } from 'react';
import type { HarnessId, HarnessRow } from '@dorkos/shared/harness-schemas';
import { HARNESS_LABELS } from '@dorkos/shared/harness-schemas';
import { collapsedChipLabel, harnessRowCells, isRowFullyShared } from '../lib/harness-status';
import { HarnessStateChip } from './HarnessStateChip';

/** The one sentence an adoptable skill gets, and the only advice on the row. */
export const ADOPTABLE_ADVICE =
  'Lives in .claude/skills. Move it to .agents/skills so every agent can read it.';

/** What a {@link SkillHarnessRow} draws. */
export interface SkillHarnessRowProps {
  /** The file and its per-tool states. */
  row: HarnessRow;
  /** The enabled tools, in manifest order. */
  enabled: readonly HarnessId[];
  /** The page-level "Show every agent tool" preference. */
  showEveryHarness: boolean;
}

/**
 * Two lines, plus a third when the skill is adoptable.
 *
 * Line 1 is the skill's name with its source path muted beside it, truncated
 * from the LEFT (`dir="rtl"` around a `<bdi dir="ltr">`, the idiom the model list
 * and the search hit row already use) because a path's leaf identifies it and
 * its head is what every row repeats. Line 2 is the chip list, wrapping. Line 3
 * is the advice, and it is copy — no button, because moving a file out from
 * under a person's editor is not something a side panel should offer (D3).
 *
 * **One layout, no breakpoint.** The chips wrap, and that is the whole mobile
 * answer: the docked panel at its narrowest, the phone sheet and the full-page
 * profile all draw this row, with chips falling onto a second line. The
 * alternative — a sideways-scrolling chip strip — hides state behind a gesture
 * on the one surface whose job is to show state.
 *
 * **The healthy row collapses.** When every enabled tool has the file and is
 * current on it, the row draws one chip instead of three identical ones, because
 * with thirty-one skills a wall of identical chips is what a person reads past
 * to find the row that matters. Any exception expands the row automatically —
 * nothing a person has to act on is ever behind a click. The collapsed chip is a
 * button, and its description names the tools, so nothing is unreachable either.
 *
 * **The row is a `group`, not a list item.** Its name is the skill's name, which
 * a screen reader announces on entering it; a bare list item would announce
 * nothing until its text was read. It also leaves `listitem` free to mean
 * exactly one thing on this page — a chip.
 */
export function SkillHarnessRow({ row, enabled, showEveryHarness }: SkillHarnessRowProps) {
  const [expandedHere, setExpandedHere] = useState(false);

  const cells = harnessRowCells(row, enabled);
  const collapsible = isRowFullyShared(row, enabled);
  const collapsed = collapsible && !showEveryHarness && !expandedHere;

  return (
    <div role="group" aria-label={row.name} className="flex flex-col gap-1 py-1.5">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 shrink truncate text-xs font-medium">{row.name}</span>
        {row.source !== undefined && (
          <span
            dir="rtl"
            title={row.source}
            className="text-muted-foreground text-3xs ml-auto min-w-0 truncate text-left font-mono"
          >
            <bdi dir="ltr">{row.source}</bdi>
          </span>
        )}
      </div>

      <ul aria-label="Agent tools" className="flex flex-wrap items-center gap-1">
        {collapsed ? (
          <li>
            <button
              type="button"
              aria-expanded={false}
              title={cells.map(({ harness }) => HARNESS_LABELS[harness]).join(' · ')}
              onClick={() => setExpandedHere(true)}
              className="bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground text-3xs focus-visible:ring-ring inline-flex items-center rounded-full px-2 py-0.5 leading-tight transition-colors focus-visible:ring-2 focus-visible:outline-none"
            >
              {collapsedChipLabel(cells.length)}
            </button>
          </li>
        ) : (
          cells.map(({ harness, cell }) => (
            <HarnessStateChip key={harness} harness={harness} cell={cell} />
          ))
        )}
      </ul>

      {row.adoptable && <p className="text-muted-foreground text-3xs">{ADOPTABLE_ADVICE}</p>}
    </div>
  );
}
