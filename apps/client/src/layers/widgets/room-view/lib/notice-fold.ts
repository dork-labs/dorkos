/**
 * Which of a room's notices fold away, when the room says the same kind of
 * thing several times in a row.
 *
 * An agent that fails five turns running writes five notices, one under the
 * other, and the column pushes the conversation off the screen while saying
 * one thing. Three or more notices in a row fold to the latest, behind a
 * "2 earlier" button that opens them in place (the disclosure #3307 gave a
 * session's unprompted turns).
 *
 * **A warm notice never folds.** Warm is the line that waits on the reader —
 * a failed turn, an approval nobody gave — and a fold is for lines nobody
 * needs to read twice. A run that holds one keeps it visible, folded or not.
 *
 * Pure, so the rule is tested without a timeline.
 *
 * @module widgets/room-view/lib/notice-fold
 */
import type { RoomEntry } from '@/layers/entities/room';
import { isWarmNotice } from '@/layers/features/conversation';

/** How many notices in a row it takes before the earlier ones fold. */
export const NOTICE_FOLD_MIN_RUN = 3;

/** One folded run, as the button above it describes it. */
export interface NoticeFold {
  /** The run's id: its first notice's entry id. Stable while the run grows. */
  runId: string;
  /** How many notices the fold holds back. */
  count: number;
  /** True while the reader has it open. */
  expanded: boolean;
}

/** What a room's flow draws once its notice runs are folded. */
export interface FoldedNotices {
  /** The entries to lay out, in order, with folded notices left out. */
  visible: RoomEntry[];
  /** The fold button to draw directly before an entry, by that entry's id. */
  foldBefore: ReadonlyMap<string, NoticeFold>;
  /** The run each foldable notice belongs to, by entry id. */
  runOf: ReadonlyMap<string, string>;
}

/**
 * Fold every run of three or more consecutive notices to its latest.
 *
 * @param entries - The room's top-level entries, oldest first.
 * @param expanded - The runs the reader has opened, by run id.
 */
export function foldNoticeRuns(
  entries: readonly RoomEntry[],
  expanded: ReadonlySet<string>
): FoldedNotices {
  const visible: RoomEntry[] = [];
  const foldBefore = new Map<string, NoticeFold>();
  const runOf = new Map<string, string>();

  let i = 0;
  while (i < entries.length) {
    const start = i;
    while (i < entries.length && entries[i]!.kind === 'notice') i++;
    const run = entries.slice(start, i);
    if (run.length === 0) {
      visible.push(entries[i]!);
      i++;
      continue;
    }

    const latest = run[run.length - 1]!;
    const foldable = run.filter((e) => e !== latest && !isWarmNotice(e.body.notice));
    if (run.length < NOTICE_FOLD_MIN_RUN || foldable.length === 0) {
      visible.push(...run);
      continue;
    }

    const runId = run[0]!.id;
    const open = expanded.has(runId);
    const fold: NoticeFold = { runId, count: foldable.length, expanded: open };
    const held = new Set(foldable);
    for (const entry of foldable) runOf.set(entry.id, runId);

    if (open) {
      // Open: everything shows, and the button that closes it again sits at
      // the top of the run it opened.
      foldBefore.set(run[0]!.id, fold);
      visible.push(...run);
      continue;
    }

    // Closed: the button takes the place of the first notice it holds back.
    const firstHeld = run.findIndex((e) => held.has(e));
    const anchor = run.slice(firstHeld).find((e) => !held.has(e))!;
    foldBefore.set(anchor.id, fold);
    visible.push(...run.filter((e) => !held.has(e)));
  }

  return { visible, foldBefore, runOf };
}
