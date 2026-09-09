/**
 * The global plan — a second entry point beside `project(repoRoot, opts)`, never
 * a root discriminator on it.
 *
 * `buildPlan` runs fourteen stages unconditionally, in order, and a
 * discriminator would run all of them against a home directory and rely on each
 * one opting out. The rule "never generate at user scope" would then be enforced
 * by fourteen independent omissions, and the ordinary way a rule like that is
 * lost is a fifteenth stage added later by somebody who never read the design. A
 * separate entry point inverts it: a stage reaches the global plan only if
 * somebody puts it there. P8c is the executable half of that promise.
 *
 * Two halves, split exactly the way `buildPlan` and `project()` already are:
 * {@link buildGlobalPlan} decides and touches no disk, {@link projectGlobal}
 * reads `<dorkHome>/plugins` and hands the result in. The split is what lets the
 * word "pure" mean something — the properties in
 * `__tests__/properties/plan-root-scope.property.test.ts` are checkable on a
 * hand-built input because no filesystem is involved.
 *
 * **This module plans one tier: `<dorkHome>/skills`.** Not the user-level skill
 * directories other agent tools read — those need roots this slice never passes
 * — and not commands, hooks or instructions at any scope. Only skills, only
 * symlinks, and only inside DorkOS's own directory.
 *
 * @module plan/global-projector
 */
import { join } from 'node:path';
import type { HarnessId } from '../manifest/schema.js';
import { scanInstalledPlugins, type InstalledPlugin } from '../sources/installed.js';
import { PLUGIN_ROOT_SKILL_WARNING_REASON } from './installed-projector.js';
import type { ProjectionAction, ProjectionPlan, ProjectionWarning } from './types.js';

/**
 * Where a global plan may write. An absent root is a root the plan does not
 * target.
 *
 * That is one rule with three callers: a boundary-confined deployment, an
 * unanswered question about which agent tools to share with, and a machine with
 * no enabled harness all reach the same code path — the root is simply not
 * there, and nothing beneath it is planned. There is no second "enabled" flag to
 * disagree with the roots.
 */
export interface GlobalPlanRoots {
  /**
   * The DorkOS data directory, absolute. Always present: it is where global
   * packages are read from (`<dorkHome>/plugins/<pkg>`) and where the
   * scheduler's own root is (`<dorkHome>/skills`).
   */
  dorkHome: string;
  /**
   * The cross-tool user-level skills directory, absolute — `~/.agents/skills` on
   * an ordinary machine.
   *
   * **Always absent in this slice**, and reading it is slice A3's. It is
   * declared here so the roots type is the one both slices share rather than one
   * that changes shape under a later reader.
   */
  agentsSkillsDir?: string;
  /**
   * Claude Code's user-level skills directory, absolute — the `skills` folder
   * under the root a bare `claude` opens.
   *
   * **Always absent in this slice**, for the same reason as
   * {@link agentsSkillsDir}.
   */
  claudeSkillsDir?: string;
}

/** Everything a global plan needs. The engine reads no config and resolves no home. */
export interface GlobalPlanInput {
  /** Where the plan may write. */
  roots: GlobalPlanRoots;
  /** The globally installed packages, already scanned. {@link projectGlobal} fills this in. */
  packages: readonly InstalledPlugin[];
  /**
   * The agent tools this machine shares global packages with.
   *
   * Empty is legal and plans the dork-home tier only, which needs no harness to
   * be useful: the DorkOS scheduler is not an agent tool, and a skill that runs
   * on a timer runs whether or not anything else can read it. Unused in this
   * slice beyond that — the tiers a harness list turns on are A3's.
   */
  harnesses: readonly HarnessId[];
}

/**
 * The harness a dork-home link is attributed to.
 *
 * A pure placeholder, and unlike its project-scope twin it is not even half
 * honest: `<dorkHome>/skills` is DorkOS's own directory and no agent tool reads
 * it. Every {@link ProjectionAction} must name a `HarnessId` and that type has
 * no DorkOS member, so the field is filled and `harnessAgnostic` says out loud
 * that it means nothing — which is what keeps the entry under its own heading
 * in a report and out of every per-tool cell.
 */
const GLOBAL_LINK_ATTRIBUTION: HarnessId = 'codex';

/**
 * The note carried on a link for a skill that runs on a timer.
 *
 * Frozen copy (spec §4 row 6). It names the outcome — the skill's schedule
 * starts working — rather than the mechanism, because the mechanism is a
 * directory nobody but DorkOS looks in.
 */
export const GLOBAL_SCHEDULE_LINK_REASON =
  'skill runs on a timer; linked into the DorkOS skills folder, the one place DorkOS looks for timed skills';

/** The note carried on every other dork-home link. Frozen copy (spec §4 row 6). */
export const GLOBAL_CANONICAL_LINK_REASON =
  'linked into the DorkOS skills folder, so a package you installed for all your projects is reachable there';

/**
 * Where global packages are installed: `<dorkHome>/plugins`.
 *
 * Exported because it is the containment root clause 3 of the sweep predicate
 * tests link text against (`apply/global-apply.ts`), and one spelling of the
 * path is what stops the planner and the sweep disagreeing about which links are
 * DorkOS's.
 *
 * @param dorkHome - the resolved DorkOS data directory, absolute.
 * @returns the absolute plugins root.
 */
export function globalPluginsDir(dorkHome: string): string {
  return join(dorkHome, 'plugins');
}

/**
 * The DorkOS skills root: `<dorkHome>/skills`.
 *
 * The same directory `services/tasks/skills-roots.ts` creates on boot and
 * watches as a global task root. Spelled here rather than imported because the
 * engine is a leaf package and cannot import a server service; the pair is
 * pinned by the integration test, which drives the scheduler's own discovery
 * over what this plan wrote.
 *
 * @param dorkHome - the resolved DorkOS data directory, absolute.
 * @returns the absolute skills root.
 */
export function globalSkillsDir(dorkHome: string): string {
  return join(dorkHome, 'skills');
}

/**
 * Plan the projection of every globally installed package's skills, from
 * packages a caller has already scanned.
 *
 * PURE: no filesystem access at all, which is what makes P8b and P8c checkable
 * on a hand-built input. It mirrors the split `buildPlan` and `project()`
 * already have, where `project()` does the reads and `buildPlan` decides.
 *
 * One tier, one action per skill: `<dorkHome>/skills/<pkg>__<name>` links to
 * `<dorkHome>/plugins/<pkg>/skills/<name>`, planned whatever agent tools are
 * enabled and carrying `harnessAgnostic: true`. There is **no per-harness
 * fan-out**: the planner emits one action per target path, de-duplicated, which
 * is why a global plan can never produce two actions racing for one path — a
 * shape the project-scope planner has to stand a stage down to avoid.
 *
 * Only skills are planned. Not commands, not hooks, not instructions: each is
 * refused at user scope with its own reason (spec §2.10), and none of them has a
 * home in `<dorkHome>/skills` in any case.
 *
 * Two fields of the returned {@link ProjectionPlan} are always empty and their
 * own TSDoc says why: `notEnabled` is a per-repository detection result and
 * there is no repository here, and `narrowedTo` is never set because this
 * function takes no narrowing parameter at all.
 *
 * @param input - the roots, the already-scanned packages, and the enabled agent
 *   tools.
 * @returns the same {@link ProjectionPlan} shape `project()` returns, so
 *   `formatDropList`, `formatWarnings` and the status model read one type.
 */
export function buildGlobalPlan(input: GlobalPlanInput): ProjectionPlan {
  const skillsRoot = globalSkillsDir(input.roots.dorkHome);
  const actions: ProjectionAction[] = [];
  const warnings: ProjectionWarning[] = [];
  // One action per TARGET PATH. Two packages cannot collide (the namespace is
  // the package name) but a package's own `skills/` and `.dork/tasks/` are
  // already de-duplicated by the scan, and a keep-set the apply and the sweep
  // both read must hold each path once whatever a future source adds.
  const planned = new Set<string>();

  for (const plugin of input.packages) {
    if (plugin.location.scope !== 'global') continue;
    for (const skill of plugin.skills) {
      const namespaced = `${plugin.name}__${skill.name}`;
      const target = `${skillsRoot}/${namespaced}`;
      if (planned.has(target)) continue;
      planned.add(target);
      actions.push({
        kind: 'symlink',
        artifact: 'skill',
        harness: GLOBAL_LINK_ATTRIBUTION,
        harnessAgnostic: true,
        provenance: 'installed',
        scope: 'global',
        name: namespaced,
        source: skill.sourceDir,
        target,
        reason: skill.hasSchedule ? GLOBAL_SCHEDULE_LINK_REASON : GLOBAL_CANONICAL_LINK_REASON,
      });
      if (skill.usesPluginRoot) {
        warnings.push({
          artifact: 'skill',
          harness: GLOBAL_LINK_ATTRIBUTION,
          harnessAgnostic: true,
          name: namespaced,
          source: skill.sourceDir,
          reason: PLUGIN_ROOT_SKILL_WARNING_REASON,
        });
      }
    }
  }

  return { actions, drops: [], warnings, notEnabled: [] };
}

/**
 * Read `<dorkHome>/plugins` and plan from it — the global twin of `project()`,
 * and the only half that touches a disk.
 *
 * Never throws. `scanInstalledPlugins` already swallows a package it cannot make
 * sense of (an unparseable manifest leaves the package out, following
 * `inventory/read.ts`), and the one failure it does not own is the plugins root
 * itself being unreadable — a permission error on `<dorkHome>/plugins`. That
 * becomes a warning and an empty plan rather than an exception, because the
 * command a person runs to be told what DorkOS will do must not die telling them.
 *
 * @param input - the same {@link GlobalPlanInput} without `packages`, which this
 *   function fills in.
 * @returns the plan for what is installed for every project right now.
 */
export function projectGlobal(input: Omit<GlobalPlanInput, 'packages'>): ProjectionPlan {
  let packages: readonly InstalledPlugin[];
  try {
    packages = scanInstalledPlugins({ dorkHome: input.roots.dorkHome });
  } catch (err) {
    return {
      actions: [],
      drops: [],
      warnings: [
        {
          artifact: 'plugin',
          harness: GLOBAL_LINK_ATTRIBUTION,
          harnessAgnostic: true,
          name: globalPluginsDir(input.roots.dorkHome),
          reason:
            `DorkOS could not read the folder your all-projects packages live in: ` +
            `${globalPluginsDir(input.roots.dorkHome)} (${err instanceof Error ? err.message : String(err)}). ` +
            `Nothing was linked, and nothing was removed.`,
        },
      ],
      notEnabled: [],
    };
  }
  return buildGlobalPlan({ ...input, packages });
}
