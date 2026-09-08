/**
 * What DorkOS says about a package installed for every project.
 *
 * A global install (`<dorkHome>/plugins/<pkg>`) is scanned in full and projected
 * nowhere: `buildPlan` is repo-relative end to end, and every apply and sweep
 * path resolves against a `repoRoot`. So the whole of this module is prose — the
 * two lines a person reads about such a package, and the one line the same
 * package installed at BOTH scopes earns.
 *
 * It is its own module because it is its own subject. `installed-projector.ts`
 * turns a package into files; nothing here turns anything into a file.
 *
 * @module plan/global-installs
 */
import type { InstalledPlugin } from '../sources/installed.js';
import type { ProjectionAction } from './types.js';
import { dropWholePlugin } from './installed-projector.js';

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

/**
 * The form for a package that has skills nobody outside those sessions can reach.
 *
 * The count agrees with its noun. A bare `{n} skills` printed "Its 1 skills" for
 * the commonest global package there is — a pack with one skill in it — and a
 * sentence a person reads has to be a sentence.
 */
function globalInstallSkillsReason(count: number, names: string): string {
  const held = count === 1 ? '1 skill is' : `${count} skills are`;
  return `${GLOBAL_INSTALL_LEAD} Its ${held} not shared with this project: ${names}`;
}

/** The form for a package with nothing portable in it — a different sentence, not a blank list. */
const GLOBAL_INSTALL_NO_SKILLS = `${GLOBAL_INSTALL_LEAD} It has no skills to share.`;

/**
 * The notice a package installed at BOTH scopes earns (SRC-12).
 *
 * DorkOS resolves nothing here and says so. The two projections land in
 * different directories, so nothing overwrites anything; what differs is what
 * each agent tool does when it merges its user tier over its project tier, and
 * the tools disagree — so the per-tool consequence lives in the sentence rather
 * than in a chip that could not say "unknown" honestly.
 *
 * No version numbers, on purpose: {@link InstalledPlugin} carries no `version`,
 * and a notice that could only be raised when both versions are readable is a
 * notice that goes missing on the packages whose manifests say least. One string
 * with no line breaks, because `formatDropList` prints a reason as given and
 * would not indent a continuation.
 *
 * `dorkos marketplace uninstall` is not offered because it does not exist:
 * `dorkos marketplace <sub>` manages sources only. The two copies are separately
 * addressable because an uninstall probes project roots ahead of global ones
 * (`marketplace/lib/locate-install.ts`), so a bare run reaches the all-projects
 * copy and `--project .` reaches this project's.
 */
function bothScopesNoticeReason(pkg: string): string {
  return (
    `is installed twice: once for all your projects, and once in this project. ` +
    `Claude Code uses the all-projects copy, even here. Codex shows both. ` +
    `Uninstall one if you only meant to have one. ` +
    `Run dorkos uninstall ${pkg} --project .  to remove this project's copy. ` +
    `Run dorkos uninstall ${pkg}  to remove the all-projects copy. ` +
    `Both need DorkOS running, and both ask you first.`
  );
}

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

/**
 * One notice per package installed at both scopes (SRC-12).
 *
 * Emitted once for the package, never once per agent tool: it is a fact about
 * the package, and the tools disagree about what it means, so `harnessAgnostic`
 * puts it under the report's package heading and keeps it out of every cell.
 *
 * It needs nothing a later slice builds — `scanInstalledPlugins` already returns
 * both scopes on every project sync, so the fact is available at the exact
 * moment the drop is printed — and it is gated on nothing but the two names
 * matching. A package whose manifest says less (a Claude-Code-native one, which
 * declares no layers and no version) still earns it.
 *
 * @param plugins - every scanned package, both scopes.
 * @returns one drop per name found at both scopes, in scan order.
 */
export function planBothScopesNotices(plugins: readonly InstalledPlugin[]): ProjectionAction[] {
  const globalNames = new Set(
    plugins.filter((p) => p.location.scope === 'global').map((p) => p.name)
  );
  const seen = new Set<string>();
  const notices: ProjectionAction[] = [];
  for (const plugin of plugins) {
    if (plugin.location.scope !== 'project') continue;
    if (!globalNames.has(plugin.name) || seen.has(plugin.name)) continue;
    seen.add(plugin.name);
    notices.push(dropWholePlugin(plugin, bothScopesNoticeReason(plugin.name)));
  }
  return notices;
}
