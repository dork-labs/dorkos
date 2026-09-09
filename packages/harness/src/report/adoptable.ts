/**
 * The one sentence every surface says about a skill only some agent tools can
 * see, written once and built from facts rather than from a literal.
 *
 * Four surfaces print it — `dorkos harness sync`, the boot summary, the Skills
 * page row and the adopt command's own report — and two surfaces describing one
 * fact in two voices is how a person stops trusting either, which is the
 * argument `apply/sweep-reasons.ts` makes about its own table.
 *
 * **The harness list is COMPUTED, never written down.** It is every enabled
 * harness whose vendor-documented project read paths do not include the root the
 * skill sits in, in manifest order. On a repository enabling all six, a
 * `.claude/skills` skill yields Codex and Gemini — the only two whose documented
 * project read paths omit `.claude/skills` — and on an OpenCode-first repository
 * a `.opencode/skills` skill yields the other five.
 *
 * @module report/adoptable
 */
import { HARNESS_LABELS, type HarnessId } from '../manifest/schema.js';
import type { SkillRoot } from '../inventory/types.js';
import { skillsFactsFor } from '../vendor-facts/index.js';
import { joinNames } from '../adopt/refusals.js';

/** What one headline is about. */
export interface AdoptableSentenceInput {
  /** Which root these skills live in. */
  root: SkillRoot;
  /** The skill names, sorted. */
  names: readonly string[];
  /** The enabled harnesses that cannot see them, in manifest order. */
  cannotSee: readonly HarnessId[];
  /**
   * The absolute repository root, when the reader may not be standing in it.
   *
   * The ONE switch between the two forms of this sentence. Every surface DorkOS
   * prints from the SERVER passes it — the boot log and the Skills page — because
   * the reader is not in that directory and a bare command means whatever folder
   * they happen to be in (DOR-1921's measurement, applied ahead of time). The
   * CLI passes nothing, because it ran in the repository.
   */
  projectPath?: string;
}

/**
 * Which enabled harnesses cannot see a skill in `root`, per their own vendor
 * docs.
 *
 * @param root - the skills root the skill sits in.
 * @param enabled - the enabled harnesses, in manifest order.
 * @returns the harnesses whose documented project read paths omit that root.
 */
export function harnessesThatCannotSee(
  root: SkillRoot,
  enabled: readonly HarnessId[]
): HarnessId[] {
  return enabled.filter(
    (harness) => !(skillsFactsFor(harness).readPaths.project as readonly string[]).includes(root)
  );
}

/**
 * The headline for one root's worth of skills only some agent tools can see.
 *
 * Returns an empty string when `cannotSee` is empty: every agent tool this
 * project uses can already see the skill, a count of zero problems is noise, and
 * this block is not a drift report. It never changes an exit code either — a
 * skill somebody keeps in a tool's own folder is a real choice, the same rule
 * AP-15 already follows for a gitignored `.agents/`.
 *
 * @param input - the root, the names, the tools that cannot see them, and the
 *   absolute project path when the reader is not standing in the repository.
 * @returns the sentence, or `''` when there is nothing honest to say.
 */
export function adoptableSentence(input: AdoptableSentenceInput): string {
  const { root, names, cannotSee, projectPath } = input;
  if (names.length === 0 || cannotSee.length === 0) return '';

  const tools = joinNames(cannotSee.map((harness) => HARNESS_LABELS[harness]));
  const project = projectPath === undefined ? '' : ` --project ${projectPath}`;

  // At n = 1 the headline names the skill in its own command and stands alone.
  // At n > 1 it cannot — one command cannot name three skills — so the command
  // carries `<name>` and the caller prints one line per skill beneath it.
  if (names.length === 1) {
    return (
      `1 skill lives only in ${root} and ${tools} cannot see it — ` +
      `dorkos harness adopt ${names[0]}${project} moves it`
    );
  }
  return (
    `${names.length} skills live only in ${root} and ${tools} cannot see them — ` +
    `dorkos harness adopt <name>${project} moves one`
  );
}

/**
 * The command one named skill's own line carries, under a headline that could
 * not name it.
 *
 * Its own function because the headline's `<name>` and this line's real name are
 * the same command with one substitution, and a caller spelling the second by
 * hand is how the two drift apart.
 *
 * @param name - the skill's name.
 * @param projectPath - the absolute repository root, for a server surface.
 * @returns the command to run.
 */
export function adoptCommandFor(name: string, projectPath?: string): string {
  return `dorkos harness adopt ${name}${projectPath === undefined ? '' : ` --project ${projectPath}`}`;
}

/** The heading the block of headlines sits under (S1c). */
export const ADOPTABLE_BLOCK_HEADING = 'Skills only some of your agents can see:';
