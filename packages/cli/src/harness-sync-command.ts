import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import {
  applyPlan,
  checkPlan,
  formatDropList,
  project,
  HARNESS_IDS,
  type HarnessId,
  type ProjectionAction,
  type ProjectionPlan,
} from '@dorkos/harness';

/**
 * Parsed arguments accepted by {@link runHarnessSync}.
 *
 * `check` and `fix` are mutually exclusive; bare `dorkos harness sync` (neither
 * flag) is treated as `check`. `harness` narrows every projection, drop, and
 * drift entry to a single target harness.
 */
export interface HarnessSyncArgs {
  /** Report drift without touching disk (the default mode). */
  check: boolean;
  /** Realize the plan on disk (symlinks, scaffolds, generated files). */
  fix: boolean;
  /** Optional single-harness filter (one of {@link HARNESS_IDS}). */
  harness?: string;
}

/**
 * Resolve the dork home for installed-plugin projection, mirroring `cli.ts`.
 *
 * The `harness` namespace is intercepted in `cli.ts` *before* the block that
 * resolves and exports `process.env.DORK_HOME`, so we resolve it here with the
 * same precedence (`DORK_HOME` env var, else `~/.dork`). This lets GLOBAL-scope
 * installs project; PROJECT-scope installs are repo-relative and project even
 * when no home exists.
 *
 * @returns the resolved dork home directory.
 */
function resolveDorkHome(): string {
  // eslint-disable-next-line no-restricted-syntax -- the harness branch in cli.ts runs before DORK_HOME is exported, so we mirror its `env || ~/.dork` resolution here
  return process.env.DORK_HOME || join(homedir(), '.dork');
}

/** The four actionable projection kinds, in the order shown in the per-harness summary. */
const SUMMARY_KINDS = ['native', 'symlink', 'scaffold', 'generate'] as const;

/** One-line usage string surfaced in error messages. */
const USAGE_LINE = 'Usage: dorkos harness sync [--check] [--fix] [--harness <id>]';

/**
 * Parse raw CLI arguments for `dorkos harness sync` into a typed
 * {@link HarnessSyncArgs} object.
 *
 * Expected shape: `[--check] [--fix] [--harness <id>]`. Throws an `Error`
 * (caught and formatted by the dispatcher in `cli.ts`) on an unknown option.
 * Never calls `process.exit` directly — exit-code policy lives in `cli.ts`.
 *
 * @param rawArgs - Raw argv slice that comes after `harness sync`.
 * @returns Parsed {@link HarnessSyncArgs}.
 */
export function parseHarnessSyncArgs(rawArgs: string[]): HarnessSyncArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        check: { type: 'boolean', default: false },
        fix: { type: 'boolean', default: false },
        harness: { type: 'string' },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    if (
      err instanceof TypeError &&
      (err as NodeJS.ErrnoException).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION'
    ) {
      const match = err.message.match(/Unknown option '([^']+)'/);
      const option = match?.[1] ?? 'unknown';
      throw new Error(`Unknown option for 'harness sync': ${option}\n${USAGE_LINE}`);
    }
    throw err;
  }

  const { values } = parsed;
  return {
    check: Boolean(values.check),
    fix: Boolean(values.fix),
    harness: typeof values.harness === 'string' ? values.harness : undefined,
  };
}

/** Format a single action as `[kind] artifact "name" -> path  (harness)`. */
function formatAction(action: ProjectionAction): string {
  const path = action.target ?? action.source ?? '(no path)';
  return `  [${action.kind}] ${action.artifact} "${action.name}" -> ${path}  (${action.harness})`;
}

/** Render a per-harness count of each actionable projection kind. */
function summarizeActions(actions: ProjectionAction[]): string {
  if (actions.length === 0) return '  (no projected actions)';

  const byHarness = new Map<HarnessId, Map<string, number>>();
  for (const action of actions) {
    const counts = byHarness.get(action.harness) ?? new Map<string, number>();
    counts.set(action.kind, (counts.get(action.kind) ?? 0) + 1);
    byHarness.set(action.harness, counts);
  }

  const lines: string[] = [];
  for (const [harness, counts] of [...byHarness.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const parts = SUMMARY_KINDS.filter((kind) => counts.has(kind)).map(
      (kind) => `${counts.get(kind)} ${kind}`
    );
    lines.push(`  ${harness}: ${parts.join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * Narrow a plan to a single harness, preserving action object identity so the
 * content side-table (`getActionContent`) keeps resolving for scaffold/generate.
 */
function filterPlanToHarness(plan: ProjectionPlan, harness: HarnessId): ProjectionPlan {
  return {
    actions: plan.actions.filter((a) => a.harness === harness),
    drops: plan.drops.filter((a) => a.harness === harness),
  };
}

/** Print the check-mode report and return its exit code (0 clean, 1 drift). */
function reportCheck(repoRoot: string, plan: ProjectionPlan): number {
  const drift = checkPlan(repoRoot, plan);

  console.log('Projection summary:');
  console.log(summarizeActions(plan.actions));
  console.log('');
  console.log(formatDropList(plan));
  console.log('');

  if (drift.clean) {
    console.log('No drift — every projection already matches the plan.');
    return 0;
  }
  console.log(`Drift detected (${drift.drifted.length} out of sync):`);
  for (const action of drift.drifted) console.log(formatAction(action));
  console.log('');
  console.log('Run `dorkos harness sync --fix` to apply.');
  return 1;
}

/**
 * Apply the plan, print the fix-mode report, and return its exit code (1 if conflicts).
 *
 * `sweepOrphans` removes installed-plugin projections whose plugin is gone; it is
 * passed only for an unfiltered plan (a `--harness` filter would mistake other
 * harnesses' live projections for orphans).
 */
function reportFix(repoRoot: string, plan: ProjectionPlan, sweepOrphans: boolean): number {
  const { applied, conflicts, swept } = applyPlan(repoRoot, plan, { sweepOrphans });

  console.log(`Applied ${applied.length} projection(s):`);
  for (const action of applied) console.log(formatAction(action));
  console.log('');
  console.log(formatDropList(plan));

  if (swept.length > 0) {
    console.log('');
    console.log(`Swept ${swept.length} orphaned installed projection(s):`);
    for (const path of swept) console.log(`  ${path}`);
  }

  if (conflicts.length === 0) return 0;

  console.log('');
  console.log(
    `${conflicts.length} conflict(s) left untouched — a real file or directory occupies the target; remove or rename it, then re-run:`
  );
  for (const action of conflicts) console.log(formatAction(action));
  return 1;
}

/**
 * Implements `dorkos harness sync` — drives the `@dorkos/harness` projection
 * engine offline.
 *
 * Resolves the repository root from `process.cwd()` and refuses to run when no
 * `.agents/harness.manifest.json` is present. Builds the projection plan, then
 * either reports drift (`--check`, the default) or realizes it on disk
 * (`--fix`). An optional `--harness <id>` narrows the plan to one target.
 *
 * Returns an exit code rather than calling `process.exit` — exit-code policy
 * lives in the dispatcher in `cli.ts`.
 *
 * @param args - Parsed {@link HarnessSyncArgs}.
 * @returns An object carrying the process exit code.
 */
export async function runHarnessSync(args: HarnessSyncArgs): Promise<{ exitCode: number }> {
  if (args.check && args.fix) {
    console.error('Pass either --check or --fix, not both.');
    console.error(USAGE_LINE);
    return { exitCode: 1 };
  }

  const repoRoot = process.cwd();
  const manifestPath = join(repoRoot, '.agents', 'harness.manifest.json');
  if (!existsSync(manifestPath)) {
    console.error(`No harness manifest found at ${manifestPath}.`);
    console.error(
      'Run `dorkos harness sync` from a repository whose `.agents/harness.manifest.json` exists.'
    );
    return { exitCode: 1 };
  }

  // Project marketplace-installed plugins too (DOR-173). Project-scoped installs
  // (`<repoRoot>/.dork/plugins`) are repo-relative and always project; passing a
  // resolved dork home additionally projects global-scope installs.
  let plan = project(repoRoot, { dorkHome: resolveDorkHome() });

  const harnessFiltered = args.harness !== undefined;
  if (harnessFiltered) {
    if (!(HARNESS_IDS as readonly string[]).includes(args.harness as string)) {
      console.error(
        `Unknown harness: '${args.harness}'. Known harnesses: ${HARNESS_IDS.join(', ')}`
      );
      return { exitCode: 1 };
    }
    plan = filterPlanToHarness(plan, args.harness as HarnessId);
  }

  // Orphan sweep only runs on a full (unfiltered) plan — see reportFix.
  const exitCode = args.fix
    ? reportFix(repoRoot, plan, !harnessFiltered)
    : reportCheck(repoRoot, plan);
  return { exitCode };
}
