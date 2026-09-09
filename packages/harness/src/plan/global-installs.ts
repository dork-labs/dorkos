/**
 * What DorkOS says about a package installed for every project.
 *
 * A global install (`<dorkHome>/plugins/<pkg>`) is scanned in full and projected
 * nowhere: `buildPlan` is repo-relative end to end, and every apply and sweep
 * path resolves against a `repoRoot`. So the whole of this module is prose — the
 * lines a person reads about such a package, and the one line the same package
 * installed at BOTH scopes earns.
 *
 * It is its own module because it is its own subject. `installed-projector.ts`
 * turns a package into files; nothing here turns anything into a file.
 *
 * @module plan/global-installs
 */
import type { HarnessId } from '../manifest/schema.js';
import type { InstalledPlugin } from '../sources/installed.js';
import type { ProjectionAction, ProjectionWarning } from './types.js';
import { dropWholePlugin } from './installed-projector.js';

/**
 * The harness a global package's unreadable-hooks warning is attributed to.
 *
 * Every {@link ProjectionWarning} must name one and `HarnessId` has no "DorkOS"
 * member, so this is a placeholder — the same one `plan/unreadable-hooks.ts`
 * uses, and for the same reason: the file is a Claude-plugin `hooks/hooks.json`,
 * and claude-code is the only agent tool that takes an installed package's hooks
 * in their native form. `harnessAgnostic` beside it says out loud that the field
 * is a placeholder, so the report gives the line its own heading and no
 * `--harness` filter drops it.
 */
const GLOBAL_HOOKS_ATTRIBUTION: HarnessId = 'claude-code';

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
 * How many skill names the first form lists before it stops counting them out.
 *
 * A drop reason is one line in a terminal. A pack with sixty skills would push
 * every other line off the screen to say something the count already said, so
 * the list stops at ten and the rest are summarised.
 */
const MAX_NAMED_SKILLS = 10;

/**
 * The skill names the first form lists: up to {@link MAX_NAMED_SKILLS} of them,
 * then how many were not named.
 */
function namedSkills(names: readonly string[]): string {
  if (names.length <= MAX_NAMED_SKILLS) return names.join(', ');
  const rest = names.length - MAX_NAMED_SKILLS;
  return `${names.slice(0, MAX_NAMED_SKILLS).join(', ')}, and ${rest} more`;
}

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
 * each agent tool does with the pair, and the tools disagree — so the per-tool
 * consequence lives in the sentence rather than in a chip that could not say
 * "unknown" honestly.
 *
 * **What it says about Claude Code is what is true TODAY, not what will be.** A
 * global package reaches Claude Code only by SDK injection, in sessions DorkOS
 * drives (`services/runtimes/claude-code/messaging/plugin-activation.ts` loads
 * every installed global package as a `{ type: 'local' }` plugin, and
 * `listEnabledPluginNames` treats every one of them as enabled). The project
 * copy reaches it as `.claude/skills/<pkg>__<name>`, a different name, so in
 * such a session both are visible and neither shadows the other. Outside one —
 * a bare `claude` in the repository — only the project copy exists, because
 * nothing writes `~/.claude/skills` until slice A3. An earlier draft said
 * "Claude Code uses the all-projects copy, even here", which is the vendor's
 * user-over-project precedence rule; that rule cannot apply while nothing DorkOS
 * writes is in the user tier, so the sentence was false at the moment it
 * printed. A3 may append the precedence sentence once it is true.
 *
 * The uninstall command carries the **absolute repository root**, never `.`. The
 * CLI forwards `--project` verbatim and the server resolves it against its OWN
 * working directory (`lib/boundary.ts`), so a `.` means the server's cwd, not
 * the reader's: `installRootCandidates` then finds nothing at that project and
 * falls through to the dork home, removing the all-projects copy — the opposite
 * of what the sentence promises. DOR-1921 hit the same defect on its install
 * offer and fixed it the same way.
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
 * copy and `--project <repo>` reaches this project's.
 */
function bothScopesNoticeReason(pkg: string, repoRoot: string): string {
  return (
    `is installed twice: once for all your projects, and once in this project. ` +
    `In a session DorkOS runs, Claude Code sees both copies, under different names. ` +
    `On its own, Claude Code sees only this project's copy. So does Codex, until you share it. ` +
    `Uninstall one if you only meant to have one. ` +
    `Run dorkos uninstall ${pkg} --project ${repoRoot}  to remove this project's copy. ` +
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
    namedSkills(plugin.skills.map((skill) => skill.name))
  );
}

/**
 * Every drop a project sync makes about the packages installed for all projects.
 *
 * One drop per global package, and immediately after it the SRC-12 notice when
 * the same name is also installed in this project. **Adjacent on purpose**: the
 * report groups by heading and prints in insertion order, so a notice emitted at
 * the end of the list sits several packages away from the drop it is about.
 *
 * The notice is emitted once per package, never once per agent tool: it is a
 * fact about the package, and the tools disagree about what it means, so
 * `harnessAgnostic` puts it under the report's package heading and keeps it out
 * of every cell. It needs nothing a later slice builds — `scanInstalledPlugins`
 * already returns both scopes on every project sync — and it is gated on nothing
 * but the two names matching. A package whose manifest says less (a
 * Claude-Code-native one, which declares no layers and no version) still earns
 * it.
 *
 * @param input - every scanned package (both scopes) and the absolute repository
 *   root, which the notice's uninstall command carries.
 * @returns the drops, in scan order, each notice beside its package's drop.
 */
export function planGlobalInstallDrops(input: {
  plugins: readonly InstalledPlugin[];
  repoRoot: string;
}): ProjectionAction[] {
  const projectNames = new Set(
    input.plugins.filter((p) => p.location.scope === 'project').map((p) => p.name)
  );
  const noticed = new Set<string>();
  const drops: ProjectionAction[] = [];
  for (const plugin of input.plugins) {
    if (plugin.location.scope !== 'global') continue;
    drops.push(dropWholePlugin(plugin, globalInstallDropReason(plugin)));
    if (!projectNames.has(plugin.name) || noticed.has(plugin.name)) continue;
    noticed.add(plugin.name);
    drops.push(dropWholePlugin(plugin, bothScopesNoticeReason(plugin.name, input.repoRoot)));
  }
  return drops;
}

/**
 * Say when a global package's `hooks/hooks.json` could not be read.
 *
 * The scan reads it to the same standard as a project one, and until this
 * existed the result was thrown away: `planUnreadableHookWarnings` walks the
 * PROJECT-scoped packages, so a rotted global hooks file earned no line
 * anywhere. A discarded hook is never silent (DOR-1724), and that promise does
 * not stop at the repository boundary.
 *
 * One line per package rather than per declaration: they all name the same file,
 * and the point here is that the file is unreadable, not which of its events
 * survived.
 *
 * **What it claims is only what DorkOS knows.** It does not say the hooks do not
 * run: a global package is handed to the Claude Agent SDK whole
 * (`plugin-activation.ts`), and what Claude Code's own reader makes of a
 * half-broken file is Claude Code's business. It says DorkOS cannot read it, and
 * that DorkOS projects a global package's hooks nowhere — both measurable here.
 *
 * `artifact: 'plugin'` with no `source`, which is how `report/drop-list.ts`
 * recognises an entry as being about a PACKAGE rather than about the person's
 * own tree. A global package's file has no repo-relative path to carry, so the
 * path is named in the sentence instead.
 *
 * @param plugins - every scanned package; only the global ones are considered.
 * @returns one warning per global package whose hooks file could not be read.
 */
export function planGlobalUnreadableHookWarnings(
  plugins: readonly InstalledPlugin[]
): ProjectionWarning[] {
  const warnings: ProjectionWarning[] = [];
  for (const plugin of plugins) {
    if (plugin.location.scope !== 'global') continue;
    const [first] = plugin.unreadableHooks ?? [];
    if (!first) continue;
    warnings.push({
      artifact: 'plugin',
      harness: GLOBAL_HOOKS_ATTRIBUTION,
      harnessAgnostic: true,
      name: plugin.name,
      reason:
        `has a hooks file DorkOS could not read: ${first.path}. ` +
        `DorkOS cannot say what is in it, and does not project a global package's hooks anywhere.`,
    });
  }
  return warnings;
}
