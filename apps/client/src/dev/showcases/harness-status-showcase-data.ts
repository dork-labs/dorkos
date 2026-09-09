/**
 * The trees the harness-status showcase draws against.
 *
 * Everything here is typed as the real `HarnessStatusResponse` / `HarnessRow`,
 * so a change to the response schema breaks the showcase at compile time rather
 * than leaving it quietly drawing a shape the server stopped sending.
 *
 * The whole-tree fixtures come from the entity itself (`HARNESS_STATUS_*`), so
 * a showcase and a test are never looking at two different trees. This file
 * adds only what the tests have no reason to hold: the two widths this page can
 * get wrong — a source path far too long for the row, and a project running all
 * six tools at once.
 *
 * @module dev/showcases/harness-status-showcase-data
 */
import type {
  HarnessCellState,
  HarnessId,
  HarnessRow,
  HarnessStatusResponse,
} from '@dorkos/shared/harness-schemas';
import { HARNESS_STATUS_READY } from '@/layers/entities/harness';

/** The three tools the shared fixture enables, in manifest order. */
export const THREE_TOOLS: readonly HarnessId[] = HARNESS_STATUS_READY.enabled;

/** Every state the chip vocabulary has a word for, in the order the spec lists them. */
export const EVERY_CHIP_STATE: readonly HarnessCellState[] = [
  'native',
  'projected',
  'drifted',
  'dropped',
  'warned',
  'conflict',
  'pending-approval',
];

/**
 * One row of the shared fixture, by the skill's name.
 *
 * Throws rather than drawing nothing: a demo that silently disappears when
 * somebody renames a fixture row is a showcase that stops covering the state it
 * was added for, and the error card the boundary draws says which name went.
 *
 * @param name - The skill's name in `HARNESS_STATUS_READY`.
 */
export function readyRow(name: string): HarnessRow {
  const row = HARNESS_STATUS_READY.rows.find((candidate) => candidate.name === name);
  if (row === undefined) {
    throw new Error(`HARNESS_STATUS_READY has no row named "${name}"`);
  }
  return row;
}

/**
 * A skill whose source path is far too long for the row.
 *
 * One of the two things this page can get wrong at a narrow width: the path
 * truncates from the LEFT, because its leaf identifies the file and its head is
 * what every row on the page repeats. Truncating from the right would draw
 * thirty identical prefixes and no names.
 */
export const LONG_PATH_ROW: HarnessRow = {
  artifact: 'skill',
  provenance: 'installed',
  name: 'reviewing-pull-requests',
  source:
    '.dork/plugins/@dork-labs/engineering-toolkit/plugins/review/skills/reviewing-pull-requests',
  adoptable: false,
  cells: {
    'claude-code': {
      state: 'native',
      target: '.claude/skills/engineering-toolkit__reviewing-pull-requests',
    },
    codex: {
      state: 'projected',
      target: '.codex/skills/engineering-toolkit__reviewing-pull-requests',
    },
    cursor: {
      state: 'dropped',
      reason:
        'its frontmatter name breaks Cursor’s rule for a rule file, so Cursor would not load it',
    },
  },
};

/**
 * The six tools, in the order a manifest that enabled them all would list them.
 *
 * Mutable on purpose: the response's `enabled` is a mutable array, so a
 * `readonly` one here cannot be assigned into {@link HARNESS_STATUS_SIX_TOOLS}.
 */
export const SIX_TOOLS: HarnessId[] = [
  'claude-code',
  'codex',
  'cursor',
  'gemini',
  'copilot',
  'opencode',
];

/**
 * A row every one of the six tools has an answer about.
 *
 * The other thing this page can get wrong at a narrow width: six chips have to
 * wrap onto as many lines as they need, never scroll sideways.
 */
export const SIX_TOOL_ROW: HarnessRow = {
  artifact: 'skill',
  provenance: 'authored',
  name: 'writing-for-humans',
  source: '.agents/skills/writing-for-humans',
  adoptable: false,
  cells: {
    'claude-code': { state: 'native', target: '.claude/skills/writing-for-humans' },
    codex: { state: 'native', target: '.agents/skills/writing-for-humans' },
    cursor: { state: 'projected', target: '.cursor/rules/writing-for-humans.mdc' },
    gemini: { state: 'drifted', reason: 'the projected copy is older than the file it came from' },
    copilot: {
      state: 'warned',
      reason: 'Copilot reads one instructions file, so this skill is appended to it',
    },
    opencode: { state: 'native', target: '.agents/skills/writing-for-humans' },
  },
};

/**
 * A project running all six tools, with both awkward rows in it — the whole page
 * at the width where it has the most to get wrong.
 */
export const HARNESS_STATUS_SIX_TOOLS: HarnessStatusResponse = {
  ...HARNESS_STATUS_READY,
  enabled: SIX_TOOLS,
  notEnabled: [],
  rows: [SIX_TOOL_ROW, LONG_PATH_ROW, ...HARNESS_STATUS_READY.rows],
  counts: { ...HARNESS_STATUS_READY.counts, skills: 8 },
};
