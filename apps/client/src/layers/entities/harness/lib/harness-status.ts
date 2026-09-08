/**
 * The pure half of drawing a harness status: the word a chip says, the tone it
 * wears, and the grouping the drop panels are built from.
 *
 * Nothing here reads a hook or renders anything, so every string and every
 * grouping decision is testable without a DOM — and the components below stay
 * layout.
 *
 * **No sentence in this module is written here.** A chip word is a fixed phrase
 * per state; everything else a person reads — the reason under a drop, the note
 * on a project-level entry — is the projection plan's own string, passed through
 * unchanged. `dorkos harness sync` prints those same strings, and two surfaces
 * describing one fact in two voices is how a person stops trusting either.
 *
 * @module entities/harness/lib/harness-status
 */
import {
  HARNESS_LABELS,
  type HarnessCell,
  type HarnessCellState,
  type HarnessId,
  type HarnessProjectEntry,
  type HarnessRow,
} from '@dorkos/shared/harness-schemas';

/**
 * How loud a chip is.
 *
 * Four values, not the app's five status tones: `muted` is the fourth and is
 * what "this tool can't see it" has to look like — quieter than neutral, and
 * never the failure red. A dropped file is a fact about coverage, not a break.
 */
export type HarnessChipTone = 'neutral' | 'info' | 'warning' | 'muted';

/**
 * What each state says, as a phrase with the tool's name in front of it.
 *
 * Plain words on purpose: "reads it", "shared", "out of date", "can't see it".
 * The alternative — the state names themselves — asks a person to learn seven
 * words this product invented before they can read their own screen.
 */
const CHIP_WORDS = {
  native: 'reads it',
  projected: 'shared',
  drifted: 'out of date',
  dropped: 'can’t see it',
  warned: 'may not work',
  conflict: 'blocked',
  'pending-approval': 'needs your OK',
} satisfies Record<HarnessCellState, string>;

/**
 * The tone each state wears.
 *
 * `native` and `projected` are the resting states and share one neutral, because
 * a page where the good news is coloured is a page where nothing stands out.
 * Only the three states a person has to decide something about — a conflict, a
 * withheld hook, a projection that may not work — carry the warning tone.
 */
export const HARNESS_CHIP_TONE = {
  native: 'neutral',
  projected: 'neutral',
  drifted: 'info',
  dropped: 'muted',
  warned: 'warning',
  conflict: 'warning',
  'pending-approval': 'warning',
} satisfies Record<HarnessCellState, HarnessChipTone>;

/**
 * The separator inside a row key.
 *
 * A NUL, because no path and no artifact name can contain one — the same
 * reasoning, and the same character, the server's own `rowKey` uses. Written as
 * an escape rather than as a literal so this file stays text: a raw NUL byte
 * makes git treat the whole module as binary and stop diffing it.
 */
const KEY_SEP = '\u0000';

/** The states that mean a tool has this file and it is current. */
const SHARED_STATES = new Set<HarnessCellState>(['native', 'projected']);

/**
 * What makes two entries the same file: its kind, where it came from, and its
 * name — the response's own row key, restated for a React list.
 *
 * All three matter. Two settings files both contribute a hook group named
 * `hooks`, and two MCP servers share one `.mcp.json`, so neither `name` nor
 * `source` identifies a row on its own.
 *
 * @param row - The file.
 */
export function harnessRowKey(row: Pick<HarnessRow, 'artifact' | 'source' | 'name'>): string {
  return `${row.artifact}${KEY_SEP}${row.source ?? ''}${KEY_SEP}${row.name}`;
}

/**
 * The chip's words: the tool's display name, then what it does with this file.
 *
 * @param harness - The agent tool the chip is about.
 * @param state - What that tool does with this file.
 */
export function harnessChipWord(harness: HarnessId, state: HarnessCellState): string {
  return `${HARNESS_LABELS[harness]} ${CHIP_WORDS[state]}`;
}

/**
 * The sentence a chip carries as its description — the plan's `reason`, or the
 * path it writes to when there is no reason to give.
 *
 * A plain `projected` cell has nothing to explain, and an empty description
 * would be a tooltip that opens onto nothing; the target answers the question a
 * person actually has about that chip ("where did it go?").
 *
 * @param cell - The cell the chip is drawn from.
 */
export function harnessChipDescription(cell: HarnessCell): string | undefined {
  return cell.reason ?? cell.target;
}

/** One enabled tool paired with what it does with one file. */
export interface HarnessRowCell {
  /** The agent tool. */
  harness: HarnessId;
  /** What it does with this file. */
  cell: HarnessCell;
}

/**
 * The row's cells in manifest order — one per enabled tool that has one.
 *
 * `cells` is a partial record over the six ids, so a tool with no entry draws no
 * chip rather than an empty one. Manifest order, never sorted: the order in
 * `.agents/harness.manifest.json` is the order the person wrote, and re-sorting
 * it would make the same row read differently on two screens.
 *
 * @param row - The file.
 * @param enabled - The enabled tools, in manifest order.
 */
export function harnessRowCells(row: HarnessRow, enabled: readonly HarnessId[]): HarnessRowCell[] {
  return enabled.flatMap((harness) => {
    const cell = row.cells[harness];
    return cell === undefined ? [] : [{ harness, cell }];
  });
}

/**
 * Whether every enabled tool has this file, is current on it, and has nothing
 * to warn about.
 *
 * True is what lets the row collapse to one chip. Three ways to fail it, and
 * each is a thing a person would otherwise have to click to find out:
 *
 * - a cell in any other state;
 * - a tool with no cell at all — a row that quietly drew two chips where three
 *   tools are enabled would be the page hiding the third;
 * - a cell carrying `warnings`. Its STATE is `projected` and the projection did
 *   land, so a state-only reading would collapse it — and the collapse would
 *   swallow the marker saying it may not work. A warning is an exception; the
 *   rule is "any exception expands the row", not "any exception the state
 *   happens to record".
 *
 * @param row - The file.
 * @param enabled - The enabled tools.
 */
export function isRowFullyShared(row: HarnessRow, enabled: readonly HarnessId[]): boolean {
  if (enabled.length === 0) return false;
  const cells = harnessRowCells(row, enabled);
  return (
    cells.length === enabled.length &&
    cells.every(({ cell }) => SHARED_STATES.has(cell.state) && !cell.warnings?.length)
  );
}

/**
 * The one chip a healthy row draws instead of a wall of identical ones.
 *
 * @param count - How many tools share it.
 */
export function collapsedChipLabel(count: number): string {
  return `Shared with all ${count}`;
}

/** One file a tool cannot see, and the plan's own sentence about why. */
export interface HarnessDropEntry {
  /** Stable per panel — `(artifact, source, name)`, the row key. */
  key: string;
  /** What kind of agent file it is. */
  artifact: HarnessRow['artifact'];
  /** Its name. */
  name: string;
  /** The plan's sentence, verbatim. Absent when the engine gave none. */
  reason?: string;
}

/** Everything one tool cannot see. */
export interface HarnessDropGroup {
  /** The tool. */
  harness: HarnessId;
  /** Its display name. */
  label: string;
  /** What it cannot see, in the order the rows arrived. */
  entries: HarnessDropEntry[];
}

/**
 * Group the dropped cells by tool — the panels, built on the client.
 *
 * The response carries no `drops` map on purpose (Decision 32): every drop is
 * already a cell of some row, and a map beside `rows` measured 46,244 bytes
 * against 32,415 for the same facts. Grouping here is what keeps exactly one
 * copy of each sentence on the wire.
 *
 * Only enabled tools with at least one drop get a group, so a project running
 * Codex alone never sees an empty "Not shared with Cursor".
 *
 * @param rows - Every file in the status.
 * @param enabled - The enabled tools, in manifest order.
 */
export function groupDropsByHarness(
  rows: readonly HarnessRow[],
  enabled: readonly HarnessId[]
): HarnessDropGroup[] {
  return enabled.flatMap((harness) => {
    const entries = rows.flatMap<HarnessDropEntry>((row) => {
      const cell = row.cells[harness];
      if (cell === undefined || cell.state !== 'dropped') return [];
      return [
        {
          key: harnessRowKey(row),
          artifact: row.artifact,
          name: row.name,
          ...(cell.reason === undefined ? {} : { reason: cell.reason }),
        },
      ];
    });
    if (entries.length === 0) return [];
    return [{ harness, label: HARNESS_LABELS[harness], entries }];
  });
}

/**
 * The heading half of a project-level entry: what kind of thing happened, then
 * what it happened to.
 *
 * `drop · plugin some-package`. The kind is the response's own word and the
 * artifact is the response's own word, so nothing here is a paraphrase of
 * either.
 *
 * @param entry - The project-level entry.
 */
export function projectEntryHeading(entry: HarnessProjectEntry): string {
  return `${entry.kind} · ${entry.artifact} ${entry.name}`;
}
