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
import { InlineCode } from '@/layers/shared/ui';
import { collapsedChipLabel, harnessRowCells, isRowFullyShared } from '../lib/harness-status';
import { HarnessStateChip } from './HarnessStateChip';

/**
 * The one sentence an adoptable skill gets, and the only advice on the row.
 *
 * The folder is the row's own rather than a constant. A skill is adoptable
 * whenever it sits where only some agent tools look, and that is `.claude/skills`
 * for a Claude-first repo and `.opencode/skills` or `.cursor/skills` for the
 * repos this stopped being silent about (DOR-1902) — naming `.claude/skills` at
 * somebody whose skills are in `.opencode/skills` is advice about a directory
 * they do not have. The folder is the source path's parent, which is what the
 * status model derives `harness-native` from too.
 *
 * Module-private: the row is the only thing that says it, and the tests that
 * check the wording assert the literal — a test comparing a string against the
 * function that produced it cannot fail on a copy change.
 *
 * @param source - the row's repo-relative source path.
 * @returns the sentence, naming the folder when the path has one.
 */
function adoptableAdvice(source: string | undefined): string {
  const slash = source === undefined ? -1 : source.lastIndexOf('/');
  const folder = slash > 0 ? source?.slice(0, slash) : undefined;
  return folder === undefined
    ? 'Lives where only some of your agents look. Move it to .agents/skills so every agent can read it.'
    : `Lives in ${folder}. Move it to .agents/skills so every agent can read it.`;
}

/**
 * The command that moves one skill, printed for the person to paste.
 *
 * `--project` carries the ABSOLUTE repository root, never `.`: the reader is not
 * standing in that directory, so a pasted `.` means whatever folder they happen
 * to be in — the defect DOR-1921 and `plan/global-installs.ts` both measured.
 *
 * Spelled here rather than imported from `@dorkos/harness`, which builds the
 * same string for the terminal (`report/adoptable.ts`): that package is a Node
 * filesystem engine and this is a browser bundle. The two are kept honest by
 * asserting the literal on both sides.
 *
 * @param name - the skill's name.
 * @param projectPath - the project's absolute path, as the status resolved it.
 * @returns the command.
 */
function adoptCommand(name: string, projectPath: string): string {
  return `dorkos harness adopt ${name} --project ${projectPath}`;
}

/**
 * The tag on a row that came from a package installed for every project.
 *
 * Two skills of the same name can sit in this list, one from this project and
 * one from a package installed for all of them, and nothing else on the row
 * tells them apart — the name is the same, the chips say the same thing, and the
 * source path differs only in being absolute, which is not a difference a person
 * reads. Muted rather than a chip: it says where the file came from, not what an
 * agent tool does with it, and the chip row means the second thing.
 */
const GLOBAL_SCOPE_TAG = 'for all your projects';

/** What a {@link SkillHarnessRow} draws. */
export interface SkillHarnessRowProps {
  /** The file and its per-tool states. */
  row: HarnessRow;
  /** The project's absolute path, for the command an adoptable row prints. */
  projectPath: string;
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
 * is the advice, now in two parts: where the file lives and what moving it
 * buys, then the one command that does it. Still copy rather than a button —
 * moving a file out from under a person's editor is not something a side panel
 * should offer without naming both paths first (D3) — but a printed command is
 * something they can read before they run it, which is the same disclosure a
 * `--fix` gets.
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
export function SkillHarnessRow({
  row,
  enabled,
  projectPath,
  showEveryHarness,
}: SkillHarnessRowProps) {
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
        {row.scope === 'global' && (
          <span className="text-muted-foreground text-3xs shrink-0">{GLOBAL_SCOPE_TAG}</span>
        )}
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

      {row.adoptable && (
        <>
          <p className="text-muted-foreground text-3xs">{adoptableAdvice(row.source)}</p>
          <p className="text-muted-foreground text-3xs">
            Run: <InlineCode>{adoptCommand(row.name, projectPath)}</InlineCode>
          </p>
        </>
      )}
    </div>
  );
}
