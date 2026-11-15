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

/** The longest a package-chosen name may run in DorkOS's own words: OpenCode's documented 64. */
const NAME_CAP = 64;

/**
 * Line breaks `JSON.stringify` leaves as they are: U+2028, U+2029 and U+0085
 * (NEL). A model may read any of them as a new line.
 */
const UNESCAPED_LINE_BREAKS = /[\u2028\u2029\u0085]/g;

/**
 * A skill or folder name a package wrote, made safe to quote in DorkOS's
 * voice: the line breaks JSON keeps are stripped, it is clipped to
 * {@link NAME_CAP} characters, then JSON-quoted so a newline or quote in it
 * cannot break out of the line (Security, #3752 review).
 */
function quoted(name: string): string {
  const flat = name.replace(UNESCAPED_LINE_BREAKS, '');
  return JSON.stringify(flat.length > NAME_CAP ? `${flat.slice(0, NAME_CAP)}…` : flat);
}

/** One line per skip. */
function describe(skip: SkippedPackageSkill): string {
  const what = `${quoted(skip.name)} from the ${skip.package} package`;
  switch (skip.winner.kind) {
    case 'own':
      return `- ${what}: the person's own skill at ${skip.winner.source} has this name, so theirs is the one you have.`;
    case 'package':
      return `- ${what}: ${quoted(skip.winner.projection)} was added first with this name, so that is the one you have.`;
    case 'unreadable':
      return `- the ${quoted(skip.skill)} skill folder from the ${skip.package} package: its name could not be read, so it was left out.`;
  }
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
    'Some installed package skills were not added, because OpenCode keeps only one skill per name and these could replace one you already have:',
    ...skips.map(describe),
  ].join('\n');
}
