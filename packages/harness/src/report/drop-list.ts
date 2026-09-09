/**
 * Drop-list formatter — the honesty surface of a projection plan.
 *
 * Every artifact with no home in a target harness appears here, grouped by
 * harness with its reason, so the operator sees exactly what did not travel and
 * why. Nothing is hidden behind false simplicity.
 *
 * @module report/drop-list
 */
import { isAbsolute } from 'node:path';
import type { ProjectionAction, ProjectionPlan } from '../plan/types.js';

/**
 * The heading an entry about an installed PACKAGE is grouped under, instead of a
 * harness name it has no real relationship with.
 *
 * A non-portable plugin layer has no home in ANY harness, and a hook declaration
 * the reader could not use reaches none of them — but both must carry a
 * `HarnessId`, so both used to be filed under `codex:` and `claude-code:` in
 * projects that run neither (contract VC-02). Grouping them here says what they
 * really are: a fact about the package, not about one agent.
 */
const PACKAGE_HEADING = 'plugin layers';

/**
 * The heading for everything else that is about no single harness: something in
 * the person's OWN tree that no agent tool is to blame for.
 *
 * The two need separate headings because `plugin layers:` is a lie about them.
 * Once the read-time losses started declaring themselves agnostic (DOR-1891), a
 * project with no packages installed at all was printing `plugin layers:` over a
 * rule in `.claude/rules/`, its own root `.mcp.json`, and a stale
 * `claudeOnlySkills` entry in its manifest — three files the person wrote, filed
 * under a word for something they had never used.
 */
const PROJECT_HEADING = 'this project';

/** Where an installed package's files live, and the one thing that marks an entry as being about one. */
const PLUGIN_DIR_PREFIX = '.dork/plugins/';

/**
 * Whether an agnostic entry is about an installed package rather than about the
 * person's own tree.
 *
 * The KIND decides it first: `artifact: 'plugin'` is a whole package, one of its
 * layers, or a file inside one, and nothing else emits that artifact at all. The
 * path is the second question, and only for the other kinds — a
 * `hooks/hooks.json` under `.dork/plugins/` is a package's, a `.mcp.json` at the
 * root is the project's.
 *
 * Asking the kind first is what makes this work at BOTH scopes. A global
 * package's paths are absolute — it has no repository to be relative to — so a
 * path-first rule filed a global package's broken manifest under a heading about
 * "this project" in a run that has no project at all (DOR-1933). The repo-
 * relative prefix cannot be widened to cover an absolute install directory
 * without knowing the dork home, which this formatter is not given and should
 * not be — so the absolute-ness itself is the answer for every other kind
 * (DOR-1935), because a project plan spells every path it carries relative to
 * the repository and only the global planner spells one out in full.
 *
 * For every other kind this still leans on an agnostic emitter carrying a
 * `source` when it has one, which is the same property that lets a warning be
 * matched to the artifact it concerns. An emitter that forgets lands its entry
 * here, under a heading about the person's own tree — wrong, and quiet. Both
 * halves are pinned in `__tests__/drop-list.test.ts`.
 */
function isAboutAPackage(entry: { artifact: string; source?: string }): boolean {
  if (entry.artifact === 'plugin') return true;
  if (entry.source === undefined) return false;
  // An ABSOLUTE source cannot be about the person's repository: every path a
  // project plan carries is repo-relative, and the one planner that spells paths
  // out in full is the global one, which reads `<dorkHome>/plugins` and nothing
  // else. So this is the same "not this project" answer the prefix gives, for
  // the scope where the prefix cannot exist (DOR-1935: a global package's
  // unreadable skill folder read `this project:` in a run with no project).
  return isAbsolute(entry.source) || entry.source.startsWith(PLUGIN_DIR_PREFIX);
}

/** The heading each entry is filed under: its harness, or one of the two agnostic ones. */
function headingFor(entry: {
  harness: string;
  harnessAgnostic?: boolean;
  artifact: string;
  source?: string;
}): string {
  if (entry.harnessAgnostic !== true) return entry.harness;
  return isAboutAPackage(entry) ? PACKAGE_HEADING : PROJECT_HEADING;
}

/**
 * Render `plan.drops` as a readable, honest block grouped by harness — with
 * everything that is NOT about one harness under a heading of its own:
 * `plugin layers:` for an installed package's, `this project:` for the person's
 * own tree (see {@link PACKAGE_HEADING} and {@link PROJECT_HEADING}).
 *
 * @param plan - the projection plan whose drops to format.
 * @returns a multi-line report, or a clean-state message when there are no drops.
 */
export function formatDropList(plan: ProjectionPlan): string {
  if (plan.drops.length === 0) {
    return 'No drops — every enabled harness can accept every projected artifact.';
  }

  const byHarness = new Map<string, ProjectionAction[]>();
  for (const drop of plan.drops) {
    const heading = headingFor(drop);
    const list = byHarness.get(heading) ?? [];
    list.push(drop);
    byHarness.set(heading, list);
  }

  const lines: string[] = ['Dropped artifacts (no home in the target harness):'];
  for (const [harness, drops] of [...byHarness.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push('', `${harness}:`);
    for (const drop of drops) {
      lines.push(`  - ${drop.artifact} "${drop.name}": ${drop.reason ?? 'no reason given'}`);
    }
  }
  return lines.join('\n');
}

/**
 * The families of warning, in the words the heading uses, in the order they are
 * listed.
 *
 * A PLAN warning is two of them, and the block cannot tell which of the two any
 * one entry is — a projection that landed but may not work, and a declaration
 * nobody could read, are one `reason` string apiece. So both are named whenever
 * plan warnings are present, which is what the heading has always said.
 */
const PLAN_WARNING_FAMILIES = ['may not work in the target harness', 'could not be read'] as const;

/** The one family a RUN warning is: something here may not commit as a link. */
const RUN_WARNING_FAMILY = 'may not commit as a link';

/**
 * The block's first line, naming only the families this run actually carries.
 *
 * It matters that it is built rather than fixed: the heading is read by
 * everybody on every platform, and a run with no run-level warning in it has no
 * link that might fail to commit. A fixed heading naming all three told a person
 * on macOS about a Windows problem their tree does not have, every time any
 * warning at all was printed.
 *
 * @param hasPlanWarnings - whether the plan contributed any.
 * @param hasRunWarnings - whether the run contributed any.
 * @returns the heading line, ending in a colon.
 */
function warningHeading(hasPlanWarnings: boolean, hasRunWarnings: boolean): string {
  const families = [
    ...(hasPlanWarnings ? PLAN_WARNING_FAMILIES : []),
    ...(hasRunWarnings ? [RUN_WARNING_FAMILY] : []),
  ];
  const listed =
    families.length === 1
      ? families[0]
      : `${families.slice(0, -1).join(', ')}, or ${families[families.length - 1]}`;
  return `Warnings (${listed}):`;
}

/**
 * The heading run warnings are filed under.
 *
 * Its own heading beside the harness ones because it is a different subject: a
 * plan warning is about an artifact and a tool, and a run warning is about the
 * computer the sync just ran on.
 */
const MACHINE_HEADING = 'this machine:';

/**
 * Render the warnings a run carries as a readable block grouped by heading.
 *
 * Three things land here. From the PLAN: a projection that DID happen but may
 * not work in the target harness (e.g. a hook command carrying a Claude-only
 * substitution token Codex cannot resolve), and a source declaration the engine
 * could not read, so it reached no harness at all (e.g. a matcher group the
 * `hooks/hooks.json` salvage discarded). From the RUN itself: what `applyPlan`
 * and `checkPlan` answer in `warnings` — today, that the links here are Windows
 * junctions and git would commit the files inside them instead of the links
 * (DOR-1883). All three are things a person needs told and none of them is a
 * fault to fix, which is what makes them one block rather than two. The heading
 * names only the ones this run really carries ({@link warningHeading}).
 *
 * Returns an empty string when there is nothing to say, so callers can omit the
 * block cleanly.
 *
 * @param plan - the projection plan whose warnings to format.
 * @param runWarnings - what the apply or check answered about the run itself.
 * @returns a multi-line warning report, or `''` when there are no warnings.
 */
export function formatWarnings(plan: ProjectionPlan, runWarnings: readonly string[] = []): string {
  if (plan.warnings.length === 0 && runWarnings.length === 0) return '';

  const byHarness = new Map<string, ProjectionPlan['warnings']>();
  for (const warning of plan.warnings) {
    const heading = headingFor(warning);
    const list = byHarness.get(heading) ?? [];
    list.push(warning);
    byHarness.set(heading, list);
  }

  const lines: string[] = [warningHeading(plan.warnings.length > 0, runWarnings.length > 0)];
  for (const [harness, warnings] of [...byHarness.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    lines.push('', `${harness}:`);
    for (const warning of warnings) {
      lines.push(`  - ${warning.artifact} "${warning.name}": ${warning.reason}`);
    }
  }
  // LAST, whatever the harness headings sorted to: it is about the machine
  // rather than about any tool, and the tool sections read as a list of one
  // kind of thing.
  if (runWarnings.length > 0) {
    lines.push('', MACHINE_HEADING);
    for (const warning of runWarnings) lines.push(`  - ${warning}`);
  }
  return lines.join('\n');
}
