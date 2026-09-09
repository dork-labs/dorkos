/**
 * `dorkos harness sync --global` — sharing the packages installed for all your
 * projects.
 *
 * A different subject from the rest of `harness sync`, not a mode of it: it
 * reads `<dorkHome>/plugins`, needs no repository and reads no manifest, and
 * writes only inside `<dorkHome>`. It lives in its own module for the same
 * reason `harness-sync-allow-hooks.ts` does — one command, several subjects, and
 * the report for each is its own piece of prose.
 *
 * **Every path it will remove is printed before it is removed, and the receipt
 * of what went is printed after.** That order is the whole point of the surface:
 * a person watching the terminal sees the promise before the deletion rather
 * than only the deletion. `--check` narrows the run to the promise and writes
 * nothing at all.
 *
 * @module harness-sync-global
 */
import {
  applyGlobalPlan,
  checkGlobalPlan,
  formatWarnings,
  globalPluginsDir,
  globalSkillsDir,
  projectGlobal,
  type ProjectionAction,
} from '@dorkos/harness';

/**
 * The one sentence a global run ends on, whatever it did.
 *
 * Printed every time so the command can never be read as more than it is: the
 * links it writes are in DorkOS's own folder, which is where skills that run on
 * a timer are found and is not a folder any agent tool reads.
 */
const GLOBAL_REACH_NOTE =
  'This puts your all-projects skills where DorkOS looks for skills that run on a timer. It does not share them with Claude Code, Codex or any other agent tool yet.';

/** One planned link, as a person reads it. */
function globalActionLine(action: ProjectionAction): string {
  const note = action.reason ? ` — ${action.reason}` : '';
  return `  ${action.artifact} "${action.name}" -> ${action.target ?? '(no path)'}${note}`;
}

/** The heading and lines for every link a run is about to remove. */
function removalPreview(orphans: readonly string[], about: 'will' | 'did'): string[] {
  if (orphans.length === 0) return [];
  const heading =
    about === 'will'
      ? `Removing ${orphans.length} link(s) — what they came from is gone:`
      : `Removed ${orphans.length} link(s):`;
  return ['', heading, ...orphans.map((path) => `  ${path}`)];
}

/**
 * Implements `dorkos harness sync --global`.
 *
 * Reads the packages installed for all your projects and links their skills into
 * `<dorkHome>/skills`. It writes NOTHING outside that folder, because no other
 * root is passed to the plan.
 *
 * **A packages folder it could not read stops the run before anything is
 * removed**, and says so. An unreadable folder produces an empty plan, an empty
 * plan looks exactly like a machine with nothing installed, and a sweep run on
 * that evidence deletes every global link there is.
 *
 * **Every path it will remove is printed before it is removed**, and the receipt
 * of what went is printed after — in that order, so a person watching the
 * terminal sees the promise before the deletion rather than only the deletion.
 * `--check` narrows the whole thing to the promise and writes nothing at all.
 *
 * @param args - the parsed arguments; only `fix` is read here, because a run
 *   that is not a fix is a check (a bare `dorkos harness sync` reports).
 * @param dorkHome - the resolved DorkOS data directory.
 * @returns the process exit code: non-zero for a conflict, or for a `--check`
 *   that found work to do.
 */
export function runGlobalSync(args: { fix: boolean }, dorkHome: string): number {
  const roots = { dorkHome };
  const plan = projectGlobal({ roots, harnesses: [] });
  const drift = checkGlobalPlan(plan, roots);

  console.log('Packages installed for all your projects:');
  console.log(`  read from: ${globalPluginsDir(dorkHome)}`);
  console.log(`  linked into: ${globalSkillsDir(dorkHome)}`);

  // A folder nobody could read is not a folder with nothing in it, and the
  // difference decides whether a sweep may run at all. Said first, and said as
  // the reason nothing was removed, because a person watching a command that
  // usually removes things needs to know it deliberately did not.
  if (plan.unreadableRoot !== undefined) {
    console.log('');
    console.log(
      `DorkOS could not read ${plan.unreadableRoot}, so nothing was linked and nothing was removed.`
    );
    console.log('  Check the folder’s permissions, then run this again.');
    console.log('');
    console.log(GLOBAL_REACH_NOTE);
    return 1;
  }

  const warningBlock = formatWarnings(plan);
  if (warningBlock) {
    console.log('');
    console.log(warningBlock);
  }

  if (!args.fix) {
    if (drift.drifted.length > 0) {
      console.log('');
      console.log(`${drift.drifted.length} skill(s) to link:`);
      for (const action of drift.drifted) console.log(globalActionLine(action));
    }
    for (const line of removalPreview(drift.orphans, 'will')) console.log(line);
    if (drift.blocked.length > 0) {
      console.log('');
      console.log(
        `${drift.blocked.length} link(s) blocked — something DorkOS does not own is at the path:`
      );
      for (const action of drift.blocked) console.log(globalActionLine(action));
    }
    console.log('');
    console.log(
      drift.clean
        ? `Nothing to change. ${plan.actions.length} skill(s) already linked.`
        : 'Run `dorkos harness sync --fix --global` to apply.'
    );
    console.log(GLOBAL_REACH_NOTE);
    return drift.clean ? 0 : 1;
  }

  // The promise, before anything is removed.
  for (const line of removalPreview(drift.orphans, 'will')) console.log(line);

  const { applied, conflicts, swept } = applyGlobalPlan(plan, roots, { sweepOrphans: true });

  console.log('');
  console.log(
    applied.length === 0
      ? `Nothing to link. ${plan.actions.length} skill(s) already linked.`
      : `Linked ${applied.length} skill(s):`
  );
  for (const action of applied) console.log(globalActionLine(action));

  // The receipt, after.
  for (const line of removalPreview(swept, 'did')) console.log(line);

  if (conflicts.length > 0) {
    console.log('');
    console.log(
      `${conflicts.length} link(s) left untouched — something DorkOS does not own occupies the path. Each line says what is in the way; clear it, then re-run:`
    );
    for (const action of conflicts) console.log(globalActionLine(action));
  }

  console.log('');
  console.log(GLOBAL_REACH_NOTE);
  return conflicts.length === 0 ? 0 : 1;
}
