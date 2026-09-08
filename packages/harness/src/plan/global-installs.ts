/**
 * What DorkOS says about a package installed for every project.
 *
 * A global install (`<dorkHome>/plugins/<pkg>`) is scanned in full and projected
 * nowhere: `buildPlan` is repo-relative end to end, and every apply and sweep
 * path resolves against a `repoRoot`. So the whole of this module is prose — the
 * two lines a person reads about such a package.
 *
 * It is its own module because it is its own subject. `installed-projector.ts`
 * turns a package into files; nothing here turns anything into a file.
 *
 * @module plan/global-installs
 */
import type { InstalledPlugin } from '../sources/installed.js';

/**
 * The first two sentences of the drop every globally installed package earns.
 *
 * A global install reaches Claude Code only while DorkOS is driving it, through
 * the runtime's own SDK injection, and reaches no other agent tool at all. That
 * is the whole of what is true today, so it is the whole of what this says.
 *
 * It replaces a sentence that told the reader to run a global-scope sync — a
 * command nobody ever built, and no flag of `dorkos harness sync` has ever
 * accepted. The forms below are written so later slices APPEND to them rather
 * than rewrite them: a sentence that grows by addition can never be false at the
 * moment it is printed.
 */
const GLOBAL_INSTALL_LEAD =
  'installed for all your projects. Only the Claude Code sessions DorkOS runs can see it.';

/** The form for a package that has skills nobody outside those sessions can reach. */
function globalInstallSkillsReason(count: number, names: string): string {
  return `${GLOBAL_INSTALL_LEAD} Its ${count} skills are not shared with this project: ${names}`;
}

/** The form for a package with nothing portable in it — a different sentence, not a blank list. */
const GLOBAL_INSTALL_NO_SKILLS = `${GLOBAL_INSTALL_LEAD} It has no skills to share.`;

/**
 * Say what a globally installed package holds, and who can see it.
 *
 * Two forms, because a package with nothing portable in it is a different
 * sentence from one whose skills nobody else can reach. Neither names a command:
 * in this slice there is none to name, and naming one that does not exist is the
 * defect this replaces.
 *
 * @param plugin - the globally installed package being dropped.
 * @returns the drop reason, continuing the line `formatDropList` already opened
 *   with the package's name.
 */
export function globalInstallDropReason(plugin: InstalledPlugin): string {
  if (plugin.skills.length === 0) return GLOBAL_INSTALL_NO_SKILLS;
  return globalInstallSkillsReason(
    plugin.skills.length,
    plugin.skills.map((skill) => skill.name).join(', ')
  );
}
