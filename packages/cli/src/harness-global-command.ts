/**
 * `dorkos harness global` — who can see the packages you installed for all your
 * projects.
 *
 * A first write into a person's home directory is past the line where an agent
 * proceeds on its own judgement, so this feature asks, once, and remembers. The
 * ask is printed by `dorkos harness sync --global`; this module is the answer,
 * and it is a separate, named verb on purpose: one explicit command, one array
 * element, nothing round-tripped. That is the shape ADR-0302's amendment
 * established for `--fix --enable <harness>` at project scope.
 *
 * `--list` writes nothing, and goes out of its way not to: it reads
 * `config.json` directly rather than opening the config store, whose constructor
 * would create the file and the directory around it (see `harness-consent.ts`).
 *
 * **`--disable` sweeps before it forgets, and the order is the whole of it.**
 * The sweep only looks in directories the CURRENT plan targets, so removing an
 * agent tool from the list first would make its directory untargeted and strand
 * every link DorkOS put there — nothing would ever look at them again, and the
 * ask's promise that DorkOS removes its own links would be broken by the command
 * that is supposed to undo the yes. So the order is: build the plan as it
 * stands, compute the plan the list would have without the tool, sweep the
 * difference, and only then write the config. A failure before the write leaves
 * the config untouched, so the command is re-runnable and never half-done.
 *
 * **Step two is a DIFFERENCE, not a directory wipe**, and that is the whole
 * subtlety. `~/.agents/skills` is shared by five agent tools, so disabling
 * Cursor while Codex is still enabled must remove nothing: the same links serve
 * Codex. Only disabling the last tool that reads a directory empties it.
 *
 * @module harness-global-command
 */
import { existsSync } from 'node:fs';
import { sep } from 'node:path';
import { parseArgs } from 'node:util';
import { rethrowUnknownOption } from './lib/parse-args-error.js';
import { configPathFor, resolveDorkHome } from './harness-consent.js';
import {
  GLOBAL_SKILLS_RESTART_NOTE,
  HARNESS_IDS,
  HARNESS_LABELS,
  USER_TIER_MEASUREMENT_NOTE,
  globalPluginsDir,
  globalSkillsDir,
  type HarnessId,
  type SweptPath,
} from '@dorkos/harness';

/** Parsed arguments accepted by {@link runHarnessGlobal}. */
export interface HarnessGlobalArgs {
  /** Show the answer and the directories it implies. Never writes. */
  list: boolean;
  /** The agent tool to start sharing with, when one was named. */
  enable?: string;
  /** The agent tool to stop sharing with, when one was named. */
  disable?: string;
}

/** One-line usage string surfaced in error messages. */
const USAGE_LINE = 'Usage: dorkos harness global [--list] [--enable <tool>] [--disable <tool>]';

/** How the ask and the errors spell the six agent tools a person may name. */
const TOOL_CHOICES = 'claude-code, codex, cursor, gemini (Gemini CLI), copilot, opencode';

/**
 * Parse raw CLI arguments for `dorkos harness global`.
 *
 * Bare `global` means `--list`, because listing is the read-only half and a
 * command that does nothing is worse than one that shows you where you stand.
 *
 * @param rawArgs - Raw argv slice that comes after `harness global`.
 * @returns Parsed {@link HarnessGlobalArgs}.
 */
export function parseHarnessGlobalArgs(rawArgs: string[]): HarnessGlobalArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        list: { type: 'boolean', default: false },
        enable: { type: 'string' },
        disable: { type: 'string' },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    rethrowUnknownOption(err, 'harness global', USAGE_LINE);
  }

  const { values } = parsed;
  const enable = typeof values.enable === 'string' ? values.enable : undefined;
  const disable = typeof values.disable === 'string' ? values.disable : undefined;
  return {
    list: Boolean(values.list) || (enable === undefined && disable === undefined),
    enable,
    disable,
  };
}

/** Whether a string a person typed is one of the six agent tool ids. */
function asHarnessId(value: string): HarnessId | undefined {
  return (HARNESS_IDS as readonly string[]).includes(value) ? (value as HarnessId) : undefined;
}

/** The two lines an unrecognised `<tool>` earns: what is wrong, and what to type. */
function reportUnknownTool(flag: string, value: string): void {
  console.error(`'${value}' is not an agent tool DorkOS knows.`);
  console.error(`  ${flag} takes one of: ${TOOL_CHOICES}`);
}

/**
 * The block `dorkos harness sync --global` prints when nobody has been asked
 * yet. Frozen copy (spec §2.7).
 *
 * Every link name is printed, never a count. The list is what the person is
 * agreeing to, and a number is not.
 *
 * @param input - the two user directories, the data directory, and every link
 *   the answer would create.
 * @returns the lines to print, in order.
 */
export function globalSharingAsk(input: {
  agentsSkillsDir: string;
  claudeSkillsDir: string;
  dorkHome: string;
  linkNames: readonly string[];
}): string[] {
  return [
    'Share the packages you installed for all your projects with your other agent tools?',
    '',
    'DorkOS would put links in these folders in your home directory:',
    `  ${input.agentsSkillsDir}   read by Codex, OpenCode, Cursor, Gemini CLI and Copilot`,
    `  ${input.claudeSkillsDir}   read by Claude Code`,
    '',
    'It would add these links, and nothing else:',
    ...input.linkNames.map((name) => `  - ${name}`),
    '',
    `Each link points at a folder inside ${input.dorkHome}/plugins. DorkOS only ever creates links in those two`,
    'folders, never files, and it only ever removes a link it made itself.',
    '',
    'If you uninstall a package later, DorkOS removes its links too.',
    'Claude Code needs a restart before it sees the new skills folder. In Gemini CLI, run /skills reload.',
    '',
    'To say yes, run this once per agent tool you want:',
    '  dorkos harness global --enable <tool>',
    `where <tool> is one of: ${TOOL_CHOICES}.`,
    'Run dorkos harness global --list to see what you chose.',
  ];
}

/**
 * Print the recorded answer and the directories it implies.
 *
 * Stamps nothing. It also says which of the five tools that share one folder
 * DorkOS has actually tested, because a list of six names reads as six
 * measurements and only one of them is.
 *
 * @param dorkHome - the resolved DorkOS data directory.
 * @returns 0 when the file was read, 1 when it could not be.
 */
async function listSharing(dorkHome: string): Promise<number> {
  const { readGlobalSharingFromDisk, resolveGlobalScopeInputs, boundaryConfigFromDisk } =
    await import('../server/services/harness/global-scope.js');
  const { harnesses, askedAt, unreadable } = readGlobalSharingFromDisk(dorkHome);

  // "Not shared with anything yet" over a file that says otherwise is the worst
  // sentence this command could print, so an unreadable file says what it is
  // and stops. Exit 1, because showing your answer IS this command's only job.
  if (unreadable !== undefined) {
    console.error(`DorkOS could not read ${configPathFor(dorkHome)}: ${unreadable}`);
    console.error('  Fix the file to see your answer. Until then DorkOS shares nothing.');
    return 1;
  }

  const inputs = resolveGlobalScopeInputs(dorkHome, process.env, boundaryConfigFromDisk(dorkHome));

  console.log('Packages you installed for all your projects:');
  console.log(`  read from: ${globalPluginsDir(dorkHome)}`);
  console.log(
    `  linked into: ${globalSkillsDir(dorkHome)}   read by DorkOS, for skills on a timer`
  );

  if (harnesses.length === 0) {
    console.log('');
    console.log(
      askedAt === null
        ? 'Not shared with any other agent tool. DorkOS has not asked you yet.'
        : 'Not shared with any other agent tool. You were asked, and you have not said yes to one.'
    );
    console.log(`  Share with one: dorkos harness global --enable <tool>`);
    console.log(`  <tool> is one of: ${TOOL_CHOICES}`);
    return 0;
  }

  console.log('');
  console.log('Shared with:');
  for (const harness of HARNESS_IDS) {
    if (!harnesses.includes(harness)) continue;
    console.log(`  ${HARNESS_LABELS[harness]}`);
  }
  // Only when there is a directory to name. Under a boundary there is none, and
  // an empty heading reads as a bug rather than as a rule being obeyed.
  if (inputs.roots.agentsSkillsDir !== undefined || inputs.roots.claudeSkillsDir !== undefined) {
    console.log('');
    console.log('Which puts links in:');
  }
  if (inputs.roots.agentsSkillsDir !== undefined) {
    console.log(
      `  ${inputs.roots.agentsSkillsDir}   read by Codex, OpenCode, Cursor, Gemini CLI and Copilot`
    );
  }
  if (inputs.roots.claudeSkillsDir !== undefined) {
    console.log(`  ${inputs.roots.claudeSkillsDir}   read by Claude Code`);
  }
  // One decision, made in the engine beside the frozen strings, so `--list`,
  // `--enable` and `dorkos harness sync --global` cannot end on three different
  // sentences about one machine.
  const { globalClosingNote } = await import('@dorkos/harness');
  console.log('');
  console.log(globalClosingNote(inputs.roots, inputs.boundaryRoot));
  console.log('');
  console.log('Stop sharing with one: dorkos harness global --disable <tool>');
  return 0;
}

/** Every link a removal preview or receipt names, one per line with its reason. */
function removalLines(removals: readonly SweptPath[], about: 'will' | 'did'): string[] {
  if (removals.length === 0) return [];
  const heading =
    about === 'will'
      ? `Removing ${removals.length} link(s):`
      : `Removed ${removals.length} link(s):`;
  return ['', heading, ...removals.map(({ path, reason }) => `  ${path} — ${reason}`)];
}

/**
 * Start sharing with one agent tool: record it, then put the links where that
 * tool looks.
 *
 * **The config is written AFTER the apply**, and the rule is narrower than
 * "on success": it is written when the run either wrote a link or found nothing
 * in its way. The two failures it is written between are both real. Writing
 * first recorded "shares with Codex" over a run that linked nothing, which is a
 * setting that describes a machine it is not true of. Writing only on a
 * completely clean run would strand any link a PARTIAL run did make: the roots
 * are derived from the stored list, so a tool that is not recorded has no
 * directory, nothing ever scans it, and DorkOS can never take its own links
 * back.
 *
 * The apply does not need the write to have happened. `globalRootsFor` takes the
 * list as an argument, so the plan is built from `next` directly and the store
 * is consulted for nothing.
 *
 * @param dorkHome - the resolved DorkOS data directory.
 * @param tool - the agent tool to share with.
 * @returns 0 on success, 1 when a link was blocked by something DorkOS does not own.
 */
async function enableTool(dorkHome: string, tool: HarnessId): Promise<number> {
  const {
    readGlobalSharingFromDisk,
    writeGlobalSharing,
    globalRootsFor,
    boundaryConfigFromDisk,
    configuredBoundaryRoot,
  } = await import('../server/services/harness/global-scope.js');
  const { boundaryWasConfigured } = await import('../server/lib/boundary.js');
  const { initConfigManager } = await import('../server/services/core/config-manager.js');
  const {
    applyGlobalPlan,
    projectGlobal,
    findGlobalOrphans,
    globalBoundarySkipLine,
    globalClosingNote,
  } = await import('@dorkos/harness');

  const before = readGlobalSharingFromDisk(dorkHome);
  if (before.unreadable !== undefined) {
    console.error(`DorkOS could not read ${configPathFor(dorkHome)}: ${before.unreadable}`);
    console.error('  Fix the file before changing what is shared.');
    return 1;
  }

  // ONE array element, in `HARNESS_IDS` order so the stored list reads the same
  // way whatever order somebody enabled things in.
  const next = HARNESS_IDS.filter((id: HarnessId) => id === tool || before.harnesses.includes(id));
  const already = before.harnesses.includes(tool);
  /** Record the choice. Idempotent: an answer already on file is not re-stamped. */
  const record = (): void => {
    if (already) return;
    initConfigManager(dorkHome);
    writeGlobalSharing(next, 'dorkos harness global --enable');
  };

  const boundaryConfig = boundaryConfigFromDisk(dorkHome);
  if (boundaryWasConfigured(process.env, boundaryConfig)) {
    // The choice is still recorded — somebody confined the deployment, they did
    // not un-choose the tool — but nothing is linked, so the line may not say
    // "Sharing with X" over a home directory DorkOS never touched.
    record();
    console.log(
      already
        ? `Already sharing with ${HARNESS_LABELS[tool]}.`
        : `Recorded: sharing with ${HARNESS_LABELS[tool]}, once DorkOS may reach your home folder.`
    );
    console.log('');
    console.log(globalBoundarySkipLine(configuredBoundaryRoot(process.env, boundaryConfig)));
    return 0;
  }

  const roots = globalRootsFor(dorkHome, next, process.env, boundaryConfig);
  const plan = projectGlobal({ roots, harnesses: next });
  // Which user folders were missing BEFORE this run, so the restart caveat is
  // printed only when this run created one. A tool already reading a folder
  // picks up a new link in it on its own; what it cannot pick up is a folder
  // that did not exist when it started.
  const newFolders = [roots.agentsSkillsDir, roots.claudeSkillsDir].filter(
    (dir): dir is string => dir !== undefined && !existsSync(dir)
  );
  if (plan.unreadableRoot !== undefined) {
    console.log('');
    console.log(
      `DorkOS could not read ${plan.unreadableRoot}, so nothing was linked and nothing was removed.`
    );
    console.log('  Check the folder’s permissions, then run this again.');
    return 1;
  }

  // THE PROMISE, BEFORE THE DELETION. `--enable` swept first and printed the
  // receipt after, which is the one order this whole surface exists not to use:
  // a person watching the terminal has to see what is about to go while it is
  // still there. `findGlobalOrphans` is the read-only twin of the sweep and
  // returns the identical list, so the promise cannot describe a different set
  // from the one the apply removes.
  for (const line of removalLines(findGlobalOrphans(plan, roots), 'will')) console.log(line);

  const { applied, conflicts, removals } = applyGlobalPlan(plan, roots, {
    sweepOrphans: true,
  });

  // Recorded now, and the test is about the USER tier only. `<dorkHome>/skills`
  // is DorkOS's own folder and is written whatever anybody shares with, so
  // counting a link there as "the tool got its links" would record "shares with
  // Codex" over a run that put nothing where Codex looks — the state writing the
  // config first produced, reached by a longer road.
  //
  // Nothing is stranded by the refusal: a link this run did NOT write cannot be
  // orphaned, and one it did write is exactly what makes `recorded` true.
  const wroteWhereTheToolLooks = applied.some(
    (action) => !(action.target ?? '').startsWith(globalSkillsDir(dorkHome) + sep)
  );
  const recorded = wroteWhereTheToolLooks || conflicts.length === 0;
  if (recorded) record();

  console.log('');
  if (applied.length > 0) {
    console.log(`Added ${applied.length} link(s):`);
    for (const action of applied) console.log(`  ${action.target} — ${action.reason ?? ''}`);
  } else if (conflicts.length > 0) {
    console.log(
      `Nothing new was linked. ${conflicts.length} link(s) are blocked, and the rest are already in place.`
    );
  } else {
    console.log(`Nothing to link. ${plan.actions.length} link(s) already in place.`);
  }

  // The receipt, after.
  for (const line of removalLines(removals, 'did')) console.log(line);

  if (conflicts.length > 0) {
    console.log('');
    console.log(
      `${conflicts.length} link(s) left untouched — the path is occupied by something DorkOS does not own, or the folder will not take it. Each line says what is in the way; clear it, then re-run:`
    );
    for (const action of conflicts) console.log(`  ${action.target} — ${action.reason ?? ''}`);
  }

  console.log('');
  console.log(
    recorded
      ? already
        ? `Already sharing with ${HARNESS_LABELS[tool]}.`
        : `Sharing with ${HARNESS_LABELS[tool]}.`
      : `Not sharing with ${HARNESS_LABELS[tool]} yet: DorkOS could not add any of its links. Clear what is in the way, then run this again.`
  );

  if (newFolders.length > 0 && applied.length > 0) {
    console.log('');
    console.log(GLOBAL_SKILLS_RESTART_NOTE);
  }

  console.log('');
  console.log(globalClosingNote(roots));
  return conflicts.length === 0 ? 0 : 1;
}

/**
 * Stop sharing with one agent tool: remove the links that tool's directory no
 * longer needs, and only then forget the tool.
 *
 * @param dorkHome - the resolved DorkOS data directory.
 * @param tool - the agent tool to stop sharing with.
 * @returns 0 on success, 1 when the answer or the packages folder could not be read.
 */
async function disableTool(dorkHome: string, tool: HarnessId): Promise<number> {
  const {
    readGlobalSharingFromDisk,
    writeGlobalSharing,
    globalRootsFor,
    boundaryConfigFromDisk,
    configuredBoundaryRoot,
  } = await import('../server/services/harness/global-scope.js');
  const { boundaryWasConfigured } = await import('../server/lib/boundary.js');
  const { initConfigManager } = await import('../server/services/core/config-manager.js');
  const { projectGlobal, sweepGlobalOrphans, findGlobalOrphans, globalBoundarySkipLine } =
    await import('@dorkos/harness');

  const before = readGlobalSharingFromDisk(dorkHome);
  if (before.unreadable !== undefined) {
    console.error(`DorkOS could not read ${configPathFor(dorkHome)}: ${before.unreadable}`);
    console.error('  Fix the file before changing what is shared.');
    return 1;
  }
  if (!before.harnesses.includes(tool)) {
    console.error(`Not sharing with ${HARNESS_LABELS[tool]}, so there is nothing to stop.`);
    console.error('  Run `dorkos harness global --list` to see what you chose.');
    return 1;
  }

  const remaining = before.harnesses.filter((id) => id !== tool);

  // Step 1: the plan AS IT STANDS, with the tool still enabled. Its roots are
  // what the SWEEP scans, and they are computed from the list before anything is
  // forgotten — because a root is only resolved for a tool that is enabled, so
  // forgetting the tool first would take its directory out of the answer, and
  // every link DorkOS put there would be stranded.
  const boundaryConfig = boundaryConfigFromDisk(dorkHome);
  const rootsNow = globalRootsFor(dorkHome, before.harnesses, process.env, boundaryConfig);
  const planNow = projectGlobal({ roots: rootsNow, harnesses: before.harnesses });
  if (planNow.unreadableRoot !== undefined) {
    console.error(
      `DorkOS could not read ${planNow.unreadableRoot}, so nothing was removed and nothing was changed.`
    );
    console.error('  Check the folder’s permissions, then run this again.');
    return 1;
  }

  // Step 2: the plan the list would have WITHOUT the tool, swept against the
  // roots of step 1. A DIFFERENCE, not a directory wipe: five agent tools share
  // `~/.agents/skills`, so disabling one while another still reads it removes
  // nothing at all.
  const planAfter = projectGlobal({ roots: rootsNow, harnesses: remaining });
  const going = findGlobalOrphans(planAfter, rootsNow);
  for (const line of removalLines(going, 'will')) console.log(line);
  const removed = sweepGlobalOrphans(planAfter, rootsNow);
  // The receipt, after — the same pair `dorkos harness sync --global` prints, so
  // one surface never shows a promise the other shows a receipt for.
  for (const line of removalLines(removed, 'did')) console.log(line);

  // Step 3, and only now: forget the tool. A failure above leaves the config
  // untouched, so the command is re-runnable and never half-done.
  initConfigManager(dorkHome);
  writeGlobalSharing(remaining, 'dorkos harness global --disable');

  console.log('');
  console.log(`Stopped sharing with ${HARNESS_LABELS[tool]}.`);
  if (removed.length === 0) {
    // Three different reasons nothing went, and each is a different thing to
    // tell somebody. A confined deployment is the one worth saying out loud:
    // links this machine wrote before it was confined are still in the home
    // folder, and DorkOS is no longer allowed to reach them.
    if (boundaryWasConfigured(process.env, boundaryConfig)) {
      console.log('  Nothing was removed from your home folder, because DorkOS may not reach it.');
      console.log(
        `  ${globalBoundarySkipLine(configuredBoundaryRoot(process.env, boundaryConfig))}`
      );
      console.log('  Any links it put there before are still there, and you can delete them.');
    } else {
      console.log(
        remaining.length === 0
          ? '  Nothing to remove: DorkOS had put no links in that folder.'
          : '  Nothing to remove: the same links serve the other agent tools you share with.'
      );
    }
  }
  if (remaining.length === 0) {
    console.log('');
    console.log(
      'Not shared with any other agent tool now. DorkOS remembers your answer and will not ask again.'
    );
  }
  return 0;
}

/**
 * Implements `dorkos harness global`.
 *
 * Returns an exit code rather than calling `process.exit` — exit-code policy
 * lives in the dispatcher.
 *
 * @param args - Parsed {@link HarnessGlobalArgs}.
 * @returns An object carrying the process exit code.
 */
export async function runHarnessGlobal(args: HarnessGlobalArgs): Promise<{ exitCode: number }> {
  if (args.enable !== undefined && args.disable !== undefined) {
    console.error('Pass either --enable or --disable, not both.');
    console.error(USAGE_LINE);
    return { exitCode: 1 };
  }

  const dorkHome = resolveDorkHome();
  try {
    if (args.enable !== undefined) {
      const tool = asHarnessId(args.enable);
      if (tool === undefined) {
        reportUnknownTool('--enable', args.enable);
        return { exitCode: 1 };
      }
      return { exitCode: await enableTool(dorkHome, tool) };
    }
    if (args.disable !== undefined) {
      const tool = asHarnessId(args.disable);
      if (tool === undefined) {
        reportUnknownTool('--disable', args.disable);
        return { exitCode: 1 };
      }
      return { exitCode: await disableTool(dorkHome, tool) };
    }
    return { exitCode: await listSharing(dorkHome) };
  } catch (err) {
    console.error(`Harness global failed: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`  settings file: ${configPathFor(dorkHome)}`);
    return { exitCode: 1 };
  }
}
