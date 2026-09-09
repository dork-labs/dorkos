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
 * **This module plans three tiers, all of them skills and all of them
 * symlinks:** `<dorkHome>/skills`, which DorkOS's own scheduler watches;
 * `~/.agents/skills`, which five agent tools read; and one `<claudeRoot>/skills`,
 * which Claude Code reads. Not commands, not hooks, not instructions, at any
 * scope: each is refused at user scope with its own reason (spec §2.10). Nothing
 * here generates a file, and the two user roots are INJECTED — the engine
 * resolves no home directory of its own.
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
   * Resolved by the server (`services/harness/agents-user-home.ts`, the sixth
   * `os.homedir()` carve-out) and handed in. Absent means the plan does not
   * target it, which is what a `DORKOS_BOUNDARY` deployment passes.
   *
   * Passing the root is NOT the same as planning links in it: {@link
   * buildGlobalPlan} also needs at least one enabled harness that reads the
   * directory. The root says where DorkOS MAY write; the harness list says
   * whether anybody asked it to.
   */
  agentsSkillsDir?: string;
  /**
   * Claude Code's user-level skills directory, absolute — the `skills` folder
   * under the root a bare `claude` opens.
   *
   * ONE directory, never a set. That is the root a bare `claude` opens, and a
   * bare `claude` is the only Claude Code the user tier has to serve: a
   * DorkOS-driven session, on any account, is served whole by SDK injection
   * (spec §2.9). `resolveActiveClaudeRoot()` answers which account DorkOS bills
   * and is not used; `resolveClaudeRootSet()` would put files in accounts nobody
   * is running and is not used either.
   *
   * **A package reachable both here and through SDK injection is listed ONCE**,
   * which is what makes writing this directory safe for a package a DorkOS
   * session already has. Measured, not reasoned from the vendor's sentence: a
   * real `claude` 2.1.266 was given one package through both routes and a second
   * through injection alone as a control, and it named the shared skill a single
   * time
   * (`meta/harness-smoke/20260909-103643.543-claude-user-tier.md`, 2026-09-09).
   * Two entries would have made this root conditional on the package not being
   * injected; one entry is why it is not.
   *
   * Same two-part rule as {@link agentsSkillsDir}: the root plus `claude-code`
   * in the harness list.
   */
  claudeSkillsDir?: string;
}

/**
 * A global plan, plus the two things only a global plan has to say.
 *
 * It IS a {@link ProjectionPlan} — `formatDropList`, `formatWarnings` and the
 * status model read one shape — with two fields the project planner has no need
 * for, both of which exist to keep a sweep from removing something on the
 * strength of a plan that could not be built properly.
 */
export interface GlobalProjectionPlan extends ProjectionPlan {
  /**
   * The packages root this plan could not read, when it could not read it.
   *
   * Present ONLY when the read itself failed — a permission error on
   * `<dorkHome>/plugins`, say. An empty but readable folder is not this: it is a
   * machine with no global packages, and its plan is legitimately empty.
   *
   * **A sweep is skipped outright while this is set**, because the plan is the
   * only evidence a sweep has about what is still installed, and a plan built
   * from a folder nobody could read is evidence of nothing. Without the skip,
   * one unreadable directory deletes every global link on the machine and pauses
   * every schedule that ran from one.
   */
  unreadableRoot?: string;
  /**
   * The packages this plan actually enumerated, by name.
   *
   * The plan is authoritative about these and about nothing else. A package on
   * disk whose `.dork/manifest.json` will not parse is skipped by the scan and
   * so is absent here — and its links must survive, because a manifest a person
   * broke half an hour ago is not a package they uninstalled. See
   * `apply/global-apply.ts` for the sweep rule the pair drives.
   */
  enumeratedPackages: readonly string[];
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
   * on a timer runs whether or not anything else can read it.
   *
   * Otherwise this is what turns each user tier on. `~/.agents/skills` is
   * planned when at least one of {@link AGENTS_SKILLS_DIR_READERS} is here, and
   * `<claudeRoot>/skills` when `claude-code` is. There is no per-tool link: one
   * directory serves five tools, so the list decides whether the directory is
   * written at all, never how many times.
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
 * The agent tools that read `~/.agents/skills`, in `HARNESS_IDS` order.
 *
 * Every harness but `claude-code`, and that is an invariant of the vendor facts
 * rather than a list somebody typed here: `packages/harness/src/vendor-facts/index.ts`
 * carries `~/.agents/skills` under `skills.readPaths.user` for each of these
 * five and `~/.claude/skills` for Claude Code, and the case in
 * `vendor-facts/__tests__/vendor-facts.test.ts` reds if a refresh moves one.
 * That invariant is the whole reason the user tier is at most TWO directories.
 *
 * **One of the five is measured and four are documented.** DOR-1856's free
 * listing probe ran a real `codex` 0.145.0 over a staged link in a sandbox HOME
 * and it listed the skill (`meta/harness-smoke/20260909-103636.210-codex-user-tier.md`);
 * OpenCode, Cursor, Gemini CLI and Copilot were not probed, and their cells are
 * vendor-page claims. The link is planned for all five all the same, because the
 * SAME single link serves them: dropping it for the four unmeasured tools would
 * remove Codex's skills too. What the four earn instead is a dated sentence on
 * the surfaces a person reads ({@link USER_TIER_MEASUREMENT_NOTE}).
 */
export const AGENTS_SKILLS_DIR_READERS: readonly HarnessId[] = [
  'codex',
  'cursor',
  'gemini',
  'copilot',
  'opencode',
];

/**
 * The note carried on every `~/.agents/skills` link. Frozen copy (spec §4c).
 *
 * It names the outcome and the folder, never the mechanism, and it is one
 * sentence because a drop-list line is one line.
 */
export const AGENTS_USER_LINK_REASON =
  'linked into your shared skills folder, the one place Codex, OpenCode, Cursor, Gemini CLI and Copilot all look for skills';

/** The note carried on every `<claudeRoot>/skills` link. Frozen copy (spec §4c). */
export const CLAUDE_USER_LINK_REASON =
  'linked into Claude Code\u2019s own skills folder, the only place it looks';

/**
 * What DorkOS has actually tested about the shared folder, and what it has only
 * read on a vendor page.
 *
 * Printed by the surfaces that name the folder, never carried on an action: the
 * two link reasons above are frozen copy about WHERE a link went, and a
 * measurement date is a different claim from a different source. Dated on
 * purpose, so a reader can tell how old the answer is.
 */
export const USER_TIER_MEASUREMENT_NOTE =
  'DorkOS tested Codex on 2026-09-09 and it reads this folder. OpenCode, Cursor, Gemini CLI and Copilot say they read it too, and DorkOS has not tested them.';

/**
 * The sentence a run ends on when nothing is shared with any other agent tool.
 *
 * It can never be read as more than it is: the links are in DorkOS's own folder,
 * which is where skills that run on a timer are found and is not a folder any
 * agent tool reads.
 */
export const GLOBAL_REACH_NOTE =
  'This puts your all-projects skills where DorkOS looks for skills that run on a timer. It does not share them with Claude Code, Codex or any other agent tool yet.';

/**
 * The sentence a run ends on when Claude Code is the ONLY tool shared with.
 *
 * Its own branch because the two beside it are both wrong here, in opposite
 * directions. {@link GLOBAL_REACH_NOTE} ends "it does not share them with Claude
 * Code, Codex or any other agent tool yet" — printed directly under a list of
 * links this run just made in Claude Code's own skills folder, which is the
 * defect this constant exists to end. {@link USER_TIER_MEASUREMENT_NOTE} is
 * about the SHARED folder and five tools none of which this run touched.
 */
export const GLOBAL_CLAUDE_ONLY_NOTE =
  'Your all-projects skills are in Claude Code\u2019s own skills folder now. No other agent tool can see them yet.';

/**
 * The restart caveat, printed once per run and only when the run created a
 * skills folder that was not there before. Frozen copy (spec §4b).
 *
 * The global sibling of `reportClaudeSkillsRestart`. Gated on the folder being
 * NEW because a tool that was already reading the folder picks up a new link in
 * it on its own; what it cannot pick up is a folder that did not exist when it
 * started.
 */
export const GLOBAL_SKILLS_RESTART_NOTE =
  'Claude Code needs a restart before it sees the new skills folder. In Gemini CLI, run /skills reload.';

/**
 * The one sentence a global run ends on, chosen by how far it actually reaches.
 *
 * FOUR answers and never one hedged one, because every pair of them contradicts
 * the other on some machine:
 *
 * - a confined deployment says so and names the root it was given;
 * - a machine sharing with nothing says the links are DorkOS's own;
 * - a machine sharing with Claude Code alone says what Claude Code can see;
 * - a machine sharing the folder five tools read says which of the five DorkOS
 *   has actually tested.
 *
 * It lives here rather than in the CLI because it is frozen copy about what the
 * PLAN did, and because two surfaces print it: `dorkos harness sync --global`
 * and `dorkos harness global --enable`. Deciding it twice is how they end up
 * disagreeing about one machine.
 *
 * @param roots - the roots the plan was built from; an absent root is a tier
 *   this run does not reach.
 * @param boundaryRoot - the configured boundary root, when one confined this
 *   deployment.
 * @returns the closing sentence.
 */
export function globalClosingNote(roots: GlobalPlanRoots, boundaryRoot?: string): string {
  if (boundaryRoot !== undefined) return globalBoundarySkipLine(boundaryRoot);
  if (roots.agentsSkillsDir !== undefined) return USER_TIER_MEASUREMENT_NOTE;
  return roots.claudeSkillsDir === undefined ? GLOBAL_REACH_NOTE : GLOBAL_CLAUDE_ONLY_NOTE;
}

/**
 * The line a boundary-confined deployment prints instead of writing links.
 * Frozen copy (spec §4 row 8).
 *
 * @param root - the boundary root, absolute, as the person configured it.
 * @returns the sentence, with the root interpolated.
 */
export function globalBoundarySkipLine(root: string): string {
  return (
    'Packages you installed for all your projects stay inside DorkOS on this machine. ' +
    `DorkOS is limited to ${root}, so it will not add links in your home folder.`
  );
}

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
 * One directory a global plan writes into, and how its links are labelled.
 *
 * Derived once per plan rather than re-decided per skill: which directories are
 * targeted is a property of the roots and the harness list, and asking that
 * question inside the skill loop is how a per-skill inconsistency gets in.
 */
interface GlobalPlanTier {
  /** The absolute directory this tier writes into. */
  dir: string;
  /** The `HarnessId` every action from this tier carries. */
  harness: HarnessId;
  /** Whether that id is a placeholder rather than a claim about one tool. */
  harnessAgnostic: boolean;
  /** The frozen note an action carries, given whether the skill runs on a timer. */
  reason: (hasSchedule: boolean) => string;
}

/**
 * Which directories this plan writes into.
 *
 * The rule is one sentence with two clauses, and BOTH are required for a user
 * tier: the root has to be passed, and an agent tool that reads it has to be
 * enabled. The root answers "may DorkOS write here" — a `DORKOS_BOUNDARY`
 * deployment passes neither — and the harness list answers "did anybody ask it
 * to". Collapsing them would make each mean the other: gating on the root alone
 * plans a Claude Code link for somebody who never enabled Claude Code, and
 * gating on the list alone plans a link with no directory to put it in.
 *
 * The dork-home tier has neither clause. It writes only inside DorkOS's own data
 * directory, into a root DorkOS already creates and watches on boot, so there is
 * nothing to ask about and nothing to confine.
 *
 * @param input - the roots and the enabled agent tools.
 * @returns the tiers to plan, dork-home first.
 */
function globalPlanTiers(input: Omit<GlobalPlanInput, 'packages'>): GlobalPlanTier[] {
  const tiers: GlobalPlanTier[] = [
    {
      dir: globalSkillsDir(input.roots.dorkHome),
      harness: GLOBAL_LINK_ATTRIBUTION,
      harnessAgnostic: true,
      reason: (hasSchedule) =>
        hasSchedule ? GLOBAL_SCHEDULE_LINK_REASON : GLOBAL_CANONICAL_LINK_REASON,
    },
  ];
  const enabled = new Set(input.harnesses);
  if (
    input.roots.agentsSkillsDir !== undefined &&
    AGENTS_SKILLS_DIR_READERS.some((harness) => enabled.has(harness))
  ) {
    tiers.push({
      dir: input.roots.agentsSkillsDir,
      // Honest rather than a placeholder: Codex is the one reader of this
      // directory DorkOS has measured. `harnessAgnostic` still says the label
      // means nothing on its own, because the same link serves five tools and
      // no per-tool cell may claim it.
      harness: 'codex',
      harnessAgnostic: true,
      reason: () => AGENTS_USER_LINK_REASON,
    });
  }
  if (input.roots.claudeSkillsDir !== undefined && enabled.has('claude-code')) {
    tiers.push({
      dir: input.roots.claudeSkillsDir,
      // Not agnostic: this directory has exactly one reader, so the label is a
      // claim and it is true.
      harness: 'claude-code',
      harnessAgnostic: false,
      reason: () => CLAUDE_USER_LINK_REASON,
    });
  }
  return tiers;
}

/**
 * Plan the projection of every globally installed package's skills, from
 * packages a caller has already scanned.
 *
 * PURE: no filesystem access at all, which is what makes P8b and P8c checkable
 * on a hand-built input. It mirrors the split `buildPlan` and `project()`
 * already have, where `project()` does the reads and `buildPlan` decides.
 *
 * Up to three tiers, one action per (tier, skill):
 *
 * - `<dorkHome>/skills/<pkg>__<name>`, always, whatever agent tools are enabled
 *   and carrying `harnessAgnostic: true`. DorkOS's own folder.
 * - `<agentsSkillsDir>/<pkg>__<name>`, when the root is passed AND at least one
 *   of {@link AGENTS_SKILLS_DIR_READERS} is enabled. One link for five tools,
 *   also `harnessAgnostic: true`, because it really is about all of them.
 * - `<claudeSkillsDir>/<pkg>__<name>`, when the root is passed AND `claude-code`
 *   is enabled. Attributed to `claude-code` and NOT agnostic, because that
 *   directory has exactly one reader.
 *
 * Every action's `source` is the skill directory inside `<dorkHome>/plugins`, so
 * all three tiers point at one copy on disk and nothing is duplicated anywhere.
 *
 * There is **no per-harness fan-out**: the planner emits one action per target
 * path, de-duplicated, which is why a global plan can never produce two actions
 * racing for one path — a shape the project-scope planner has to stand a stage
 * down to avoid. Five tools sharing `~/.agents/skills` is the clearest case: the
 * harness list decides whether that directory is written at all, never how many
 * times.
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
 * @returns a {@link GlobalProjectionPlan}: the same shape `project()` returns,
 *   plus the two fields a sweep needs to know what this plan is evidence of.
 */
export function buildGlobalPlan(input: GlobalPlanInput): GlobalProjectionPlan {
  const actions: ProjectionAction[] = [];
  const warnings: ProjectionWarning[] = [];
  // One action per TARGET PATH. Two packages cannot collide (the namespace is
  // the package name) but a package's own `skills/` and `.dork/tasks/` are
  // already de-duplicated by the scan, and a keep-set the apply and the sweep
  // both read must hold each path once whatever a future source adds.
  const planned = new Set<string>();
  const tiers = globalPlanTiers(input);

  for (const plugin of input.packages) {
    if (plugin.location.scope !== 'global') continue;
    for (const skill of plugin.skills) {
      const namespaced = `${plugin.name}__${skill.name}`;
      for (const tier of tiers) {
        // `join`, never `${dir}/${name}`: a target is a real path on this
        // machine, and the plan is the thing every other reader compares against
        // — the apply's `pathExists`, the sweep's `resolve`, the CLI's report,
        // the status payload. A plan that shipped a forward slash on Windows
        // would be the one value in the system spelled unlike every path beside
        // it, and the tests that hard-code the slash would be pinning the POSIX
        // representation rather than the behaviour.
        const target = join(tier.dir, namespaced);
        if (planned.has(target)) continue;
        planned.add(target);
        actions.push({
          kind: 'symlink',
          artifact: 'skill',
          harness: tier.harness,
          ...(tier.harnessAgnostic ? { harnessAgnostic: true } : {}),
          provenance: 'installed',
          scope: 'global',
          name: namespaced,
          source: skill.sourceDir,
          target,
          reason: tier.reason(skill.hasSchedule),
        });
      }
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

  return {
    actions,
    drops: [],
    warnings,
    notEnabled: [],
    enumeratedPackages: input.packages
      .filter((plugin) => plugin.location.scope === 'global')
      .map((plugin) => plugin.name),
  };
}

/**
 * Read `<dorkHome>/plugins` and plan from it — the global twin of `project()`,
 * and the only half that touches a disk.
 *
 * Never throws. `scanInstalledPlugins` already swallows a package it cannot make
 * sense of (an unparseable manifest leaves the package out, following
 * `inventory/read.ts`), and the one failure it does not own is the plugins root
 * itself being unreadable — a permission error on `<dorkHome>/plugins`. That
 * becomes a warning, an empty plan and {@link GlobalProjectionPlan.unreadableRoot}
 * rather than an exception, because the command a person runs to be told what
 * DorkOS will do must not die telling them.
 *
 * **The flag is what makes the empty plan safe.** An empty plan and an empty
 * folder look identical from the outside, and the sweep reads the plan as its
 * evidence of what is installed — so without a way to tell them apart, one
 * `chmod 000` on `<dorkHome>/plugins` would delete every global link on the
 * machine and pause every schedule that ran from one. Measured, before the flag
 * existed.
 *
 * @param input - the same {@link GlobalPlanInput} without `packages`, which this
 *   function fills in.
 * @returns the plan for what is installed for every project right now.
 */
export function projectGlobal(input: Omit<GlobalPlanInput, 'packages'>): GlobalProjectionPlan {
  const pluginsRoot = globalPluginsDir(input.roots.dorkHome);
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
          name: pluginsRoot,
          reason:
            `DorkOS could not read the folder your all-projects packages live in: ` +
            `${pluginsRoot} (${err instanceof Error ? err.message : String(err)}). ` +
            `Nothing was linked, and nothing was removed.`,
        },
      ],
      notEnabled: [],
      unreadableRoot: pluginsRoot,
      enumeratedPackages: [],
    };
  }
  return buildGlobalPlan({ ...input, packages });
}
