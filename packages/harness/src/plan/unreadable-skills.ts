/**
 * Unreadable-skill reporting — one line for a skill folder nobody could look
 * inside.
 *
 * The third and smallest of the three levels this engine has learned to tell
 * apart, and the one that was missing. An unreadable `SKILL.md` FILE was already
 * safe (the scan records the skill with an empty body); an unreadable skills
 * ROOT was already safe and loud (`plan.unreadableSkillRoots` stands both skill
 * sweeps down and names the folder). The skill DIRECTORY between them answered
 * "not a skill", so the plan stopped naming its `<pkg>__<name>` links, and the
 * sweep — for which the plan IS the keep-set — removed them without a word
 * (DOR-1935, measured in DOR-1923's review).
 *
 * The scan now keeps such a directory as a skill and flags it, so nothing is
 * removed. This module is the sentence that goes with it: a person looking at a
 * folder they cannot read is owed the fact that DorkOS could not read it either,
 * and that it left everything pointing at it alone.
 *
 * Unlike the ROOT case this does NOT stand any sweep down. The root read
 * perfectly well, every other skill in it is ordinary evidence, and one bad
 * folder inside a good one must not freeze the whole package.
 *
 * @module plan/unreadable-skills
 */
import type { HarnessId } from '../manifest/schema.js';
import type { ProjectionWarning } from './types.js';

/**
 * The harness an unreadable-skill warning is attributed to.
 *
 * A PLACEHOLDER, like every other read-time loss in this engine: the folder
 * reaches every harness that reads skills, `HarnessId` has no member for "all of
 * them", and `harnessAgnostic` beside it says the field means nothing so no
 * `--harness <id>` filter can hide the line.
 */
const UNREADABLE_SKILL_ATTRIBUTION: HarnessId = 'claude-code';

/**
 * One warning per skill folder the scan could not look inside.
 *
 * The sentence names the folder, says what DorkOS decided about it, and gives
 * the way out. "Treated as installed" is the load-bearing half: the tree is
 * deliberately not tidied, and a line that only named the folder would leave
 * somebody to work that out from the links that did not go.
 *
 * @param dirs - the skill directories that could not be read, spelled the way
 *   the scan that found them spells its paths.
 * @returns one warning per folder, empty when every skill folder read cleanly.
 */
export function planUnreadableSkillWarnings(dirs: readonly string[]): ProjectionWarning[] {
  return dirs.map((dir) => ({
    artifact: 'skill' as const,
    harness: UNREADABLE_SKILL_ATTRIBUTION,
    harnessAgnostic: true,
    name: dir,
    source: dir,
    reason:
      `DorkOS could not look inside ${dir}, so it does not know what is in there. ` +
      `The skill still counts as installed and every link to it was left exactly as it is. ` +
      `Fix the folder, then re-run.`,
  }));
}
