/**
 * `dorkos harness sync --global` — sharing the packages installed for all your
 * projects.
 *
 * A different subject from the rest of `harness sync`, not a mode of it: it
 * reads `<dorkHome>/plugins`, needs no repository and reads no manifest. It
 * lives in its own module for the same reason `harness-sync-allow-hooks.ts`
 * does — one command, several subjects, and the report for each is its own piece
 * of prose.
 *
 * **Every path it will remove is printed before it is removed, and the receipt
 * of what went is printed after.** That order is the whole point of the surface:
 * a person watching the terminal sees the promise before the deletion rather
 * than only the deletion. `--check` narrows the run to the promise and writes
 * nothing at all.
 *
 * **It asks, once, before it ever writes into a home directory.** With
 * `harness.global.askedAt` still `null` the run prints the ask and exits `0`.
 * Writing the answer is a separate, named command
 * (`dorkos harness global --enable <tool>`): one explicit verb, one array
 * element, nothing round-tripped. A decline is remembered — an empty list with a
 * timestamp — so the block prints once and not on every run.
 *
 * **The ask does not stop `--fix` doing its dork-home half**, and that is a
 * deliberate reading of the frozen rule rather than a relaxation of it. What the
 * question is about is a person's HOME directory, and nothing is written there
 * until they answer: an empty harness list plans no user tier whatever roots are
 * passed. `<dorkHome>/skills` is DorkOS's own folder, deliberately not
 * switchable (spec §2.3, decision 22), and the drop reason a global package
 * already carries says in so many words "Run dorkos harness sync --fix --global
 * so its skills that run on a timer work". A run that printed the question and
 * then did nothing would make that sentence false on every fresh machine, which
 * is the exact defect the whole drop block was rewritten to end. So the bare
 * `dorkos harness sync --global` — a check, which writes nothing in any case —
 * prints the ask under its report and exits `0`, and `--fix --global` links the
 * dork-home tier and prints the ask under that. A run that asked exits `0`
 * whatever the drift under it says: the question is what that run is for, and a
 * non-zero exit beside a question reads as a failure rather than as something
 * waiting on an answer. The moment somebody answers, the exit code goes back to
 * reporting the work.
 *
 * @module harness-sync-global
 */
import {
  applyGlobalPlan,
  checkGlobalPlan,
  formatWarnings,
  globalBoundarySkipLine,
  HARNESS_IDS,
  globalPluginsDir,
  globalSkillsDir,
  projectGlobal,
  USER_TIER_MEASUREMENT_NOTE,
  type GlobalPlanRoots,
  type GlobalProjectionPlan,
  type ProjectionAction,
  type SweptPath,
} from '@dorkos/harness';
import { globalSharingAsk } from './harness-global-command.js';

/**
 * The one sentence a run ends on when nothing is shared with any other agent
 * tool.
 *
 * It can never be read as more than it is: the links are in DorkOS's own folder,
 * which is where skills that run on a timer are found and is not a folder any
 * agent tool reads.
 */
const GLOBAL_REACH_NOTE =
  'This puts your all-projects skills where DorkOS looks for skills that run on a timer. It does not share them with Claude Code, Codex or any other agent tool yet.';

/** One planned link, as a person reads it. */
function globalActionLine(action: ProjectionAction): string {
  const note = action.reason ? ` — ${action.reason}` : '';
  return `  ${action.artifact} "${action.name}" -> ${action.target ?? '(no path)'}${note}`;
}

/**
 * The heading and lines for every link a run is about to remove, or has.
 *
 * Each line carries the engine's own sentence for that path, from
 * `apply/sweep-reasons.ts` — the same words the project-scope report prints, and
 * two of them at global scope: a package that was uninstalled and a package that
 * is still installed and no longer has a skill of that name go for different
 * reasons, and a person reading a list of deletions is owed the difference.
 */
function removalPreview(removals: readonly SweptPath[], about: 'will' | 'did'): string[] {
  if (removals.length === 0) return [];
  const heading =
    about === 'will'
      ? `Removing ${removals.length} link(s):`
      : `Removed ${removals.length} link(s):`;
  return ['', heading, ...removals.map(({ path, reason }) => `  ${path} — ${reason}`)];
}

/** Every distinct link name a plan would create, in plan order. */
function linkNamesIn(plan: GlobalProjectionPlan): string[] {
  return [...new Set(plan.actions.map((action) => action.name))];
}

/**
 * The lines saying where this run writes, before it says what it will do there.
 *
 * Absolute paths throughout, because a person reading a terminal has no other
 * context to complete a `~` from, and because this is the surface that tells
 * them DorkOS is about to touch their home directory.
 */
function whereLines(dorkHome: string, roots: GlobalPlanRoots): string[] {
  const lines = [
    'Packages installed for all your projects:',
    `  read from: ${globalPluginsDir(dorkHome)}`,
    `  linked into: ${globalSkillsDir(dorkHome)}`,
  ];
  if (roots.agentsSkillsDir !== undefined) {
    lines.push(`  linked into: ${roots.agentsSkillsDir}`);
  }
  if (roots.claudeSkillsDir !== undefined) {
    lines.push(`  linked into: ${roots.claudeSkillsDir}`);
  }
  return lines;
}

/**
 * Implements `dorkos harness sync --global`.
 *
 * Reads the packages installed for all your projects and links their skills into
 * `<dorkHome>/skills`, plus — once somebody has said yes — the one or two folders
 * in their home directory their agent tools read.
 *
 * **A packages folder it could not read stops the run before anything is
 * removed**, and says so. An unreadable folder produces an empty plan, an empty
 * plan looks exactly like a machine with nothing installed, and a sweep run on
 * that evidence deletes every global link there is.
 *
 * @param args - the parsed arguments; only `fix` is read here, because a run
 *   that is not a fix is a check (a bare `dorkos harness sync` reports).
 * @param dorkHome - the resolved DorkOS data directory.
 * @returns the process exit code: non-zero for a conflict, or for a `--check`
 *   that found work to do.
 */
export async function runGlobalSync(args: { fix: boolean }, dorkHome: string): Promise<number> {
  const { resolveGlobalScopeInputs, globalRootsFor, boundaryConfigFromDisk } =
    await import('../server/services/harness/global-scope.js');
  const boundaryConfig = boundaryConfigFromDisk(dorkHome);
  const inputs = resolveGlobalScopeInputs(dorkHome, process.env, boundaryConfig);
  const roots = inputs.roots;
  // The directories the ask NAMES are the ones a yes would use, which is not the
  // same set as the ones this run may write to: a machine that has shared with
  // nothing has no user root at all, and the whole point of the question is to
  // say where the links would go if it did.
  const askRoots = globalRootsFor(dorkHome, HARNESS_IDS, process.env, boundaryConfig);
  const plan = projectGlobal({ roots, harnesses: inputs.harnesses });
  const drift = checkGlobalPlan(plan, roots);

  for (const line of whereLines(dorkHome, roots)) console.log(line);

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
    console.log(closingNote(inputs));
    return 1;
  }

  // The settings file itself. Said out loud rather than treated as "nothing
  // shared", because a run that is about to write into somebody's home
  // directory may not guess at the answer they gave.
  if (inputs.unreadableConfig !== undefined) {
    console.log('');
    console.log(`DorkOS could not read your settings: ${inputs.unreadableConfig}`);
    console.log('  Nothing is shared with any other agent tool until DorkOS can read your answer.');
  }

  const warningBlock = formatWarnings(plan);
  if (warningBlock) {
    console.log('');
    console.log(warningBlock);
  }

  // Whether this run owes the person the one-time question. It is asked while
  // `askedAt` is null and never after: a decline is a timestamp with an empty
  // list, and it is remembered.
  //
  // A confined deployment is never asked, because the answer could not be acted
  // on. A settings file DorkOS could not read is never asked either — the
  // question may already have been answered in there.
  const owesTheAsk =
    inputs.askedAt === null &&
    inputs.unreadableConfig === undefined &&
    inputs.boundaryRoot === undefined &&
    askRoots.agentsSkillsDir !== undefined &&
    askRoots.claudeSkillsDir !== undefined;

  /** Print the ask, once, after the run has said what it did in DorkOS's own folder. */
  const printAsk = (): void => {
    if (!owesTheAsk) return;
    console.log('');
    for (const line of globalSharingAsk({
      agentsSkillsDir: askRoots.agentsSkillsDir as string,
      claudeSkillsDir: askRoots.claudeSkillsDir as string,
      dorkHome,
      linkNames: linkNamesIn(plan),
    })) {
      console.log(line);
    }
  };

  if (!args.fix) {
    if (drift.drifted.length > 0) {
      console.log('');
      console.log(`${drift.drifted.length} skill(s) to link:`);
      for (const action of drift.drifted) console.log(globalActionLine(action));
    }
    for (const line of removalPreview(drift.removals, 'will')) console.log(line);
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
    console.log(closingNote(inputs));
    printAsk();
    // A run that asked exits 0, whatever the drift under it says. The question
    // is what that run is FOR, and a non-zero exit beside a question reads as a
    // failure rather than as something waiting on an answer — a person told
    // "this failed" by a command that only asked them something stops running
    // it. The report above still names every link there is to make, and the
    // moment somebody answers, the exit code goes back to reporting the work.
    return owesTheAsk || drift.clean ? 0 : 1;
  }

  // Which user folders were missing BEFORE the run, so the restart caveat is
  // printed only when this run created one. A tool that was already reading a
  // folder picks up a new link in it on its own; what it cannot pick up is a
  // folder that did not exist when it started.
  const newFolders = await missingUserFolders(roots);

  // The promise, before anything is removed.
  for (const line of removalPreview(drift.removals, 'will')) console.log(line);

  const { applied, conflicts, removals } = applyGlobalPlan(plan, roots, { sweepOrphans: true });

  console.log('');
  console.log(
    applied.length === 0
      ? `Nothing to link. ${plan.actions.length} skill(s) already linked.`
      : `Linked ${applied.length} skill(s):`
  );
  for (const action of applied) console.log(globalActionLine(action));

  // The receipt, after.
  for (const line of removalPreview(removals, 'did')) console.log(line);

  if (conflicts.length > 0) {
    console.log('');
    console.log(
      `${conflicts.length} link(s) left untouched — the path is occupied by something DorkOS does not own, or the folder will not take it. Each line says what is in the way; clear it, then re-run:`
    );
    for (const action of conflicts) console.log(globalActionLine(action));
  }

  if (newFolders.length > 0 && applied.length > 0) {
    console.log('');
    const { GLOBAL_SKILLS_RESTART_NOTE } = await import('@dorkos/harness');
    console.log(GLOBAL_SKILLS_RESTART_NOTE);
  }

  console.log('');
  console.log(closingNote(inputs));
  printAsk();
  return conflicts.length === 0 ? 0 : 1;
}

/**
 * The sentence a run ends on, which depends on how far it reaches.
 *
 * Three answers, never one hedged one: a confined deployment says so and names
 * its root, a machine sharing with nothing says the links are DorkOS's own, and
 * a machine that shares says which of the five tools DorkOS has actually tested.
 */
function closingNote(inputs: { roots: GlobalPlanRoots; boundaryRoot?: string }): string {
  if (inputs.boundaryRoot !== undefined) return globalBoundarySkipLine(inputs.boundaryRoot);
  // The measurement note is about the SHARED folder, so it is said only when
  // that folder is in play. Somebody sharing with Claude Code alone is told
  // nothing about five tools this run never touched, and somebody sharing with
  // nothing gets the reach note, which is still true of them.
  return inputs.roots.agentsSkillsDir === undefined
    ? GLOBAL_REACH_NOTE
    : USER_TIER_MEASUREMENT_NOTE;
}

/** The user folders that do not exist yet, checked before the apply creates them. */
async function missingUserFolders(roots: GlobalPlanRoots): Promise<string[]> {
  const { existsSync } = await import('node:fs');
  return [roots.agentsSkillsDir, roots.claudeSkillsDir].filter(
    (dir): dir is string => dir !== undefined && !existsSync(dir)
  );
}
