/**
 * One skill, and what every agent tool does with it.
 *
 * @module entities/harness/ui/SkillHarnessRow
 */
import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { HarnessId, HarnessRow } from '@dorkos/shared/harness-schemas';
import { HARNESS_LABELS } from '@dorkos/shared/harness-schemas';
import { cn } from '@/layers/shared/lib/utils';
import { collapsedChipLabel, harnessRowCells, isRowFullyShared } from '../lib/harness-status';
import { HarnessStateChip } from './HarnessStateChip';

/**
 * The one sentence an adoptable skill gets, and the only advice on the row.
 *
 * Module-private: the row is the only thing that says it, and the tests that
 * check the wording assert the literal — a test comparing a string against the
 * constant that produced it cannot fail on a copy change.
 */
const ADOPTABLE_ADVICE =
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
 * nothing a person has to act on is ever behind a click. The summary chip is a
 * button, and its description names the tools, so nothing is unreachable either.
 *
 * **That chip is a toggle and stays mounted through both presses.** It used to
 * render only while collapsed, so activating it removed the very element that
 * was activated: focus fell to `<body>`, the row was left with no control, and
 * the eighteen collapsed rows this repository has could be opened once and never
 * closed. It is now a disclosure in the ordinary sense — `aria-expanded` says
 * which way it is, pressing it again goes back, and focus never leaves it.
 *
 * **The row is a `group`, not a list item.** Its name is the skill's name, which
 * a screen reader announces on entering it; a bare list item would announce
 * nothing until its text was read. It also leaves `listitem` free to mean
 * exactly one thing on this page — a chip.
 */
export function SkillHarnessRow({ row, enabled, showEveryHarness }: SkillHarnessRowProps) {
  const [expandedHere, setExpandedHere] = useState(false);

  const cells = harnessRowCells(row, enabled);
  // The row's own toggle exists only while the page-level one is off: two
  // controls over one thing, both live, is a control that lies about what it
  // does. While "Show every agent tool" is on, it IS the control.
  const collapsible = isRowFullyShared(row, enabled) && !showEveryHarness;
  const collapsed = collapsible && !expandedHere;

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
        {collapsible && (
          <li>
            <button
              type="button"
              aria-expanded={!collapsed}
              title={cells.map(({ harness }) => HARNESS_LABELS[harness]).join(' · ')}
              onClick={() => setExpandedHere((open) => !open)}
              className="bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground text-3xs focus-visible:ring-ring inline-flex items-center gap-1 rounded-full px-2 py-0.5 leading-tight transition-colors focus-visible:ring-2 focus-visible:outline-none"
            >
              {collapsedChipLabel(cells.length)}
              <ChevronDown
                aria-hidden
                className={cn('size-2.5 transition-transform', collapsed && '-rotate-90')}
              />
            </button>
          </li>
        )}
        {!collapsed &&
          cells.map(({ harness, cell }) => (
            <HarnessStateChip key={harness} harness={harness} cell={cell} />
          ))}
      </ul>

      {row.adoptable && <p className="text-muted-foreground text-3xs">{ADOPTABLE_ADVICE}</p>}
    </div>
  );
}
