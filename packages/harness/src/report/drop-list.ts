/**
 * Drop-list formatter — the honesty surface of a projection plan.
 *
 * Every artifact with no home in a target harness appears here, grouped by
 * harness with its reason, so the operator sees exactly what did not travel and
 * why. Nothing is hidden behind false simplicity.
 *
 * @module report/drop-list
 */
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
 * Sourced entries answer by path — a `hooks/hooks.json` under `.dork/plugins/` is
 * a package's, a `.mcp.json` at the root is the project's. The sourceless ones
 * are all `artifact: 'plugin'` (a whole package, one of its layers, or a global
 * package whose hooks file could not be read, whose path is absolute and so has
 * no repo-relative form to carry) and have nothing but their kind to go on,
 * which is enough because nothing else emits that artifact without a source.
 *
 * So this leans on every agnostic emitter carrying a `source` when it has one to
 * carry, which is the same property that lets a warning be matched to the
 * artifact it concerns. An emitter that forgets lands its entry here, under a
 * heading about the person's own tree — wrong, and quiet. Both halves are pinned
 * in `__tests__/drop-list.test.ts`.
 */
function isAboutAPackage(entry: { artifact: string; source?: string }): boolean {
  return entry.source === undefined
    ? entry.artifact === 'plugin'
    : entry.source.startsWith(PLUGIN_DIR_PREFIX);
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
 * fault to fix, which is what makes them one block rather than two.
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

  const lines: string[] = [
    'Warnings (may not work in the target harness, may not commit as a link, or could not be read):',
  ];
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
