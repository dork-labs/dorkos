/**
 * The line an OpenCode agent reads about package skills DorkOS left out
 * (DOR-4387).
 *
 * OpenCode keeps one of two skills that share a name, so DorkOS does not add a
 * package skill whose name is already the person's own, or another package's.
 * The agent is told which skills were left out and why, so it neither looks
 * for them nor mistakes the person's skill for the package's.
 *
 * @module services/runtimes/opencode/messaging/skipped-skills
 */
import { currentPackageSkillSkips, type SkippedPackageSkill } from '@dorkos/harness';
import { logger } from '../../../../lib/logger.js';

/** One line per skip. */
function describe(skip: SkippedPackageSkill): string {
  return skip.winner.kind === 'own'
    ? `- "${skip.name}" from the ${skip.package} package: the person's own skill at ${skip.winner.source} has this name, so theirs is the one you have.`
    : `- "${skip.name}" from the ${skip.package} package: ${skip.winner.projection} was added first with this name, so that is the one you have.`;
}

/**
 * Render the skipped-skills note for a turn in this project, or nothing.
 *
 * Never throws: a project DorkOS cannot read leaves the note out, and the plan
 * enforces the skip either way.
 *
 * @param projectRoot - the session's working directory.
 */
export function renderSkippedSkillLines(projectRoot: string): string | undefined {
  let skips: SkippedPackageSkill[];
  try {
    skips = currentPackageSkillSkips(projectRoot);
  } catch (err) {
    logger.debug('[OpenCode] could not read skipped package skills', { err: String(err) });
    return undefined;
  }
  if (skips.length === 0) return undefined;
  return [
    'Some installed package skills were not added, because a skill with the same name already exists and OpenCode keeps only one per name:',
    ...skips.map(describe),
  ].join('\n');
}
