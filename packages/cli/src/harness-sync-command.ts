import { existsSync, readFileSync } from 'node:fs';
import { LOG_LEVEL_MAP } from '@dorkos/shared/config-schema';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { rethrowUnknownOption } from './lib/parse-args-error.js';
import {
  configPathFor,
  formatWithheldBlock,
  readStoredDecisions,
  resolveDorkHome,
  withheldSummaryLine,
} from './harness-consent.js';
import type { WithheldHooks } from '../server/services/harness/project-with-consent.js';

import {
  checkPlan,
  formatDropList,
  formatWarnings,
  hooksFactsFor,
  loadManifest,
  scaffoldManifest,
  CODEX_HOOKS_TARGET,
  GENERATED_HOOK_TARGET_HARNESSES,
  HARNESS_IDS,
  HARNESS_MANIFEST_PATH,
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
  /**
   * Exit non-zero when any package's hooks were withheld.
   *
   * The default is zero, deliberately: a withheld hook is a decision being
   * obeyed, the opposite of a conflict, and failing a mostly-done sync teaches
   * bootstrap scripts to write `|| true`, which throws away every other failure
   * too (contract D5). `--strict` is for the CI user who wants a stop.
   */
  strict: boolean;
  /**
   * Packages whose hooks to install and RECORD, repeatable. Requires `--fix`.
   *
   * Not a per-run override: it writes the same `<package>@<digest>` entry the
   * approval card writes, into the same list, so the answer holds for every
   * later sync and for the app — and `dorkos harness hooks --revoke` undoes it.
   */
  allowHooks: string[];
}

/**
 * Whether this invocation asked for debug-level detail, by either spelling: the
 * `LOG_LEVEL` name a person exports, or the numeric `DORKOS_LOG_LEVEL` a parent
 * process (`cli.ts`, the server) has already resolved.
 */
function wantsDebugDetail(): boolean {
  /* eslint-disable no-restricted-syntax -- the harness branch in cli.ts runs before the log level is resolved and exported, so we mirror its `LOG_LEVEL || DORKOS_LOG_LEVEL` reading here */
  const named = LOG_LEVEL_MAP[process.env.LOG_LEVEL ?? ''];
  const numeric = Number(process.env.DORKOS_LOG_LEVEL);
  /* eslint-enable no-restricted-syntax */
  const level = named ?? (Number.isFinite(numeric) ? numeric : undefined);
  return level !== undefined && level >= LOG_LEVEL_MAP.debug;
}

/**
 * Every actionable projection kind, in the order shown in the per-harness
 * summary.
 *
 * `merge` was missing until DOR-1849, and it is the one kind that writes into a
 * file the person owns — plugin hooks folded into `.claude/settings.local.json`.
 * A summary that counted every other kind and silently skipped that one
 * under-reported exactly the write worth reporting (contract VC-02).
 */
const SUMMARY_KINDS = ['native', 'symlink', 'scaffold', 'generate', 'merge'] as const;

/** One-line usage string surfaced in error messages. */
const USAGE_LINE =
  'Usage: dorkos harness sync [--check] [--fix] [--harness <id>] [--strict] [--allow-hooks <package>]';

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
        strict: { type: 'boolean', default: false },
        'allow-hooks': { type: 'string', multiple: true },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    rethrowUnknownOption(err, 'harness sync', USAGE_LINE);
  }

  const { values } = parsed;
  return {
    check: Boolean(values.check),
    fix: Boolean(values.fix),
    harness: typeof values.harness === 'string' ? values.harness : undefined,
    strict: Boolean(values.strict),
    allowHooks: Array.isArray(values['allow-hooks'])
      ? values['allow-hooks'].filter((name): name is string => typeof name === 'string')
      : [],
  };
}

/**
 * Format a single action as `[kind] artifact "name" -> path  (harness)`, with
 * its note appended when it carries one.
 *
 * `reason` is required on a drop and optional elsewhere, and the optional ones
 * are exactly the lines that look arbitrary without it: a `native` action writes
 * no file, and EVERY installed plugin skill is linked into `.agents/skills`
 * whatever harnesses are enabled — for the five harnesses that read it and for
 * the DorkOS scheduler, which watches that directory and no other (DOR-1518,
 * DOR-1847). Drops are rendered by `formatDropList`, not here, so this never
 * double-prints a reason.
 */
function formatAction(action: ProjectionAction): string {
  const path = action.target ?? action.source ?? '(no path)';
  const note = action.reason ? ` — ${action.reason}` : '';
  return `  [${action.kind}] ${action.artifact} "${action.name}" -> ${path}  (${action.harness})${note}`;
}

/**
 * The heading and lines for generated-hook paths the engine stepped over.
 *
 * Deliberately NOT a conflict: nothing was blocked, so this never changes an
 * exit code. It exists so a person whose repo DorkOS projects no hooks into is
 * told why their file is being ignored rather than left to guess.
 */
function formatLeftAlone(leftAlone: string[], harnessFilter?: HarnessId): string[] {
  // `--harness <id>` narrows every other line of this report, so it narrows this
  // one too: a Cursor file is not an answer to a question about Codex.
  const shown = harnessFilter
    ? leftAlone.filter((path) => harnessOf(path) === harnessFilter)
    : leftAlone;
  if (shown.length === 0) return [];
  return [
    '',
    'Left alone — files DorkOS did not write, at paths it would otherwise generate:',
    ...shown.map((path) => `  ${path}  (${harnessOf(path)})`),
    '  Nothing to fix. Put these hooks in .claude/settings.json if you want DorkOS to carry them to every harness.',
  ];
}

/** Which harness a generated hooks path belongs to, for the left-alone label. */
function harnessOf(path: string): HarnessId | undefined {
  return GENERATED_HOOK_TARGET_HARNESSES[path as keyof typeof GENERATED_HOOK_TARGET_HARNESSES];
}

/**
 * The suffix on a summary line for a harness the manifest does not enable.
 *
 * One projection answers to no harness list: every installed plugin skill is
 * linked into `.agents/skills` whatever is enabled, and every action must name a
 * harness, so those links are attributed to Codex — the harness whose own
 * directory that is. On a Claude-Code-only project the summary therefore grew a
 * `codex:` line, which reads as "Codex is on" to anybody who has not read
 * `installed-projector.ts`. It is not; the line is about the shared directory.
 */
const NOT_ENABLED_NOTE = ' (not enabled — carries the shared .agents/skills link)';

/**
 * Render a per-harness count of each actionable projection kind, plus one line
 * for anything held back.
 *
 * The withheld count is a total rather than a per-harness figure, and that is
 * the honest shape: a withheld package's hooks are not in the plan at all, so
 * there is no harness they landed in to attribute them to. The blocks below the
 * summary name each package and each command.
 *
 * @param actions - the plan's actionable projections.
 * @param withheld - every package whose hooks were held back.
 * @param enabled - the harnesses the manifest enables, so a line for one it does
 *   not can say so. Omitted, no line is annotated.
 * @returns the summary block, one line per harness.
 */
function summarizeActions(
  actions: ProjectionAction[],
  withheld: readonly WithheldHooks[],
  enabled?: readonly HarnessId[]
): string {
  const withheldLine = withheldSummaryLine(withheld);
  if (actions.length === 0) {
    return withheldLine ? `  (no projected actions)\n${withheldLine}` : '  (no projected actions)';
  }

  const byHarness = new Map<HarnessId, Map<string, number>>();
  for (const action of actions) {
    const counts = byHarness.get(action.harness) ?? new Map<string, number>();
    counts.set(action.kind, (counts.get(action.kind) ?? 0) + 1);
    byHarness.set(action.harness, counts);
  }

  const enabledSet = enabled ? new Set(enabled) : undefined;
  const lines: string[] = [];
  for (const [harness, counts] of [...byHarness.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const parts = SUMMARY_KINDS.filter((kind) => counts.has(kind)).map(
      (kind) => `${counts.get(kind)} ${kind}`
    );
    const note = enabledSet && !enabledSet.has(harness) ? NOT_ENABLED_NOTE : '';
    lines.push(`  ${harness}: ${parts.join(', ')}${note}`);
  }
  if (withheldLine) lines.push(withheldLine);
  return lines.join('\n');
}

/**
 * Print one block per package whose hooks were not installed.
 *
 * Printed in both modes: a `--check` that reported clean drift while quietly
 * planning to skip a package's hooks would be the same silence this whole
 * change is about (contract D5).
 */
function reportWithheld(withheld: readonly WithheldHooks[]): void {
  for (const entry of withheld) for (const line of formatWithheldBlock(entry)) console.log(line);
}

/**
 * Say out loud that a regenerated Codex hooks file is disarmed until it is
 * trusted again (contract HK-10).
 *
 * Only when the BYTES changed. An unchanged file has not left Codex's trust
 * record, so saying it every sync would be noise that teaches people to ignore
 * the line on the one run where it is true — which is also why byte-identical
 * idempotency (AP-01) is load-bearing here rather than merely tidy.
 *
 * The claim is read from the vendor-facts table rather than written here, so it
 * carries the page it came from and the day it was read. No cell, no line: a
 * vendor's behaviour is never asserted from memory.
 */
function reportCodexTrust(before: string | undefined, after: string | undefined): void {
  if (after === undefined || after === before) return;
  const facts = hooksFactsFor('codex');
  if (facts?.trust !== 'per-hook-hash') return;
  console.log('');
  console.log(`Codex hooks changed (${CODEX_HOOKS_TARGET}).`);
  console.log('  Codex only runs these in a project you have trusted, and it remembers what each');
  console.log('  hook said when you trusted it — so this file changing puts them back in the');
  console.log('  review queue. Run `/hooks` in Codex to look them over and trust them again.');
  console.log(`  (${facts.source.url}, read ${facts.source.fetchedAt})`);
}

/** The bytes at a repo-relative path, or `undefined` when nothing is there. */
function readIfPresent(repoRoot: string, rel: string): string | undefined {
  try {
    return readFileSync(join(repoRoot, rel), 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Print the check-mode report and return its exit code.
 *
 * Non-zero for drift (a `--fix` would repair it), for an orphaned link (a `--fix`
 * would remove it), and for a blocked projection (a `--fix` cannot do anything,
 * until the person moves their file). Zero for paths merely left alone — those
 * are reported, never counted against the tree.
 *
 * **Orphans are withheld under `--harness`**, exactly mirroring the one condition
 * under which `reportFix` sweeps them. The engine answers for the whole tree; the
 * CLI decides what this invocation can act on, and naming a link that the `--fix`
 * this report recommends would NOT remove is a non-zero exit the person can never
 * clear — measured before the guard: `--check --harness codex` said "Orphaned
 * links … gamma" and exited 1, `--fix --harness codex` exited 0 and left the link,
 * forever. So `clean` is recomputed here rather than read off `DriftResult`, whose
 * own `clean` folds in the orphans this run is not reporting.
 */
function reportCheck(
  repoRoot: string,
  plan: ProjectionPlan,
  withheld: readonly WithheldHooks[],
  harnessFilter?: HarnessId,
  enabled?: readonly HarnessId[]
): number {
  const drift = checkPlan(repoRoot, plan);
  const orphans = harnessFilter === undefined ? drift.orphans : [];
  const clean = drift.drifted.length === 0 && drift.blocked.length === 0 && orphans.length === 0;

  console.log('Projection summary:');
  console.log(summarizeActions(plan.actions, withheld, enabled));
  console.log('');
  console.log(formatDropList(plan));
  const warningBlock = formatWarnings(plan);
  if (warningBlock) {
    console.log('');
    console.log(warningBlock);
  }
  for (const line of formatLeftAlone(drift.leftAlone, harnessFilter)) console.log(line);
  reportWithheld(withheld);
  console.log('');

  if (clean) {
    console.log('No drift — every projection already matches the plan.');
    return 0;
  }

  if (drift.drifted.length > 0) {
    console.log(`Drift detected (${drift.drifted.length} out of sync):`);
    for (const action of drift.drifted) console.log(formatAction(action));
  }
  if (orphans.length > 0) {
    if (drift.drifted.length > 0) console.log('');
    console.log(`Orphaned links — the skill they pointed at is gone (${orphans.length}):`);
    for (const path of orphans) console.log(`  ${path}`);
  }
  if (drift.drifted.length > 0 || orphans.length > 0) {
    console.log('');
    console.log('Run `dorkos harness sync --fix` to apply.');
  }
  if (drift.blocked.length > 0) {
    if (drift.drifted.length > 0 || orphans.length > 0) console.log('');
    console.log(
      `${drift.blocked.length} projection(s) blocked — a --fix cannot write these until you clear the way:`
    );
    for (const action of drift.blocked) console.log(formatAction(action));
  }
  return 1;
}

/**
 * Print the fix-mode report and return its exit code (1 if conflicts).
 *
 * The plan was already applied by the consent seam, which is what decides which
 * packages' hooks were in it; this renders what happened. Withheld hooks do NOT
 * change the exit code — `--strict`, handled by the caller, is what does.
 */
function reportFix(
  repoRoot: string,
  plan: ProjectionPlan,
  applyResult: {
    applied: ProjectionAction[];
    conflicts: ProjectionAction[];
    swept: string[];
    leftAlone: string[];
  },
  withheld: readonly WithheldHooks[],
  codexHooksBefore: string | undefined,
  harnessFilter?: HarnessId,
  enabled?: readonly HarnessId[]
): number {
  const { applied, conflicts, swept, leftAlone } = applyResult;

  console.log(`Applied ${applied.length} projection(s):`);
  for (const action of applied) console.log(formatAction(action));
  reportCodexTrust(codexHooksBefore, readIfPresent(repoRoot, CODEX_HOOKS_TARGET));
  console.log('');
  console.log('Projection summary:');
  // `enabled` reaches here too, and it did not have to. `--fix` printed no
  // summary at all when DOR-1847 annotated `--check`'s; it does now, and a
  // `codex:` line reads "Codex is on" to the same person on the same project
  // whichever mode they ran.
  console.log(summarizeActions(plan.actions, withheld, enabled));
  console.log('');
  console.log(formatDropList(plan));
  const warningBlock = formatWarnings(plan);
  if (warningBlock) {
    console.log('');
    console.log(warningBlock);
  }

  if (swept.length > 0) {
    console.log('');
    console.log(`Swept ${swept.length} orphaned projection(s) — what they came from is gone:`);
    for (const path of swept) console.log(`  ${path}`);
  }

  // Reported, never counted: a file DorkOS was not going to write anyway is not
  // a reason to hand somebody a failing command on every sync.
  for (const line of formatLeftAlone(leftAlone, harnessFilter)) console.log(line);

  // Printed AFTER what landed, so the report reads in the order it happened:
  // this is what was installed, and this is what was not.
  reportWithheld(withheld);

  if (conflicts.length === 0) return 0;

  console.log('');
  console.log(
    `${conflicts.length} conflict(s) left untouched — something DorkOS does not own occupies the target. Each line says what is in the way; clear it, then re-run:`
  );
  for (const action of conflicts) console.log(formatAction(action));
  return 1;
}

/**
 * Fold `--strict` into an exit code.
 *
 * Withheld hooks exit 0 by default, and that is a decision rather than an
 * oversight: a withheld hook is a recorded answer being obeyed, the opposite of
 * a conflict, and exiting 1 on a mostly-done sync teaches bootstrap scripts to
 * write `|| true` — which then swallows the conflicts and the failures too
 * (contract D5). `--strict` is for the CI user who wants a stop, and it still
 * applies everything else first.
 */
function strictExit(exitCode: number, withheld: readonly WithheldHooks[], strict: boolean): number {
  if (!strict || withheld.length === 0) return exitCode;
  console.log('');
  console.log('--strict: exiting 1 because hooks were withheld.');
  return 1;
}

/**
 * Implements `dorkos harness sync` — drives the `@dorkos/harness` projection
 * engine offline.
 *
 * Resolves the repository root from `process.cwd()`, builds the projection plan,
 * then either reports drift (`--check`, the default) or realizes it on disk
 * (`--fix`). An optional `--harness <id>` narrows the plan to one target.
 *
 * **`--check` never writes** (DOR-678). Every argument is validated before disk is
 * touched, and a missing `.agents/harness.manifest.json` is a non-zero exit naming
 * the directory that was searched — not a silent scaffold into whatever directory
 * the command happened to be invoked from. Only `--fix`, which the user runs to
 * change disk, bootstraps a default manifest when none exists.
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

  // `--allow-hooks` installs commands AND records the decision, so it belongs to
  // the write mode. Refused rather than quietly ignored, and the message names
  // the fix rather than restating the rule.
  if (args.allowHooks.length > 0 && !args.fix) {
    console.error("--allow-hooks installs a package's hooks, so it needs --fix.");
    console.error(
      `Run: dorkos harness sync --fix ${args.allowHooks.map((name) => `--allow-hooks ${name}`).join(' ')}`
    );
    return { exitCode: 1 };
  }

  // Validate --harness BEFORE anything reads or writes: a rejected argument must
  // never leave a scaffolded manifest behind as its only lasting effect.
  let harnessFilter: HarnessId | undefined;
  if (args.harness !== undefined) {
    if (!(HARNESS_IDS as readonly string[]).includes(args.harness)) {
      console.error(
        `Unknown harness: '${args.harness}'. Known harnesses: ${HARNESS_IDS.join(', ')}`
      );
      return { exitCode: 1 };
    }
    harnessFilter = args.harness as HarnessId;
  }

  const repoRoot = process.cwd();
  if (!existsSync(join(repoRoot, HARNESS_MANIFEST_PATH))) {
    // No manifest here. `--fix` is the write mode, so it bootstraps a default,
    // visible, editable one (detecting the harnesses already in use) and carries
    // on. `--check` reports and nothing else, so it stops and says where it looked
    // — a missing manifest usually means the command is running in the wrong
    // directory, and creating one there would plant a stray file in a tree the
    // person never meant to change.
    if (!args.fix) {
      console.error(`No harness manifest in ${repoRoot}`);
      console.error(`  looked for: ${HARNESS_MANIFEST_PATH}`);
      console.error('');
      console.error(
        'Harness sync works on the folder you run it in, and --check only reports — it never writes.'
      );
      console.error(
        'Run it again from your project root, or create a manifest here with `dorkos harness sync --fix`.'
      );
      return { exitCode: 1 };
    }

    const scaffold = scaffoldManifest(repoRoot);
    const setSource = scaffold.detected ? 'detected harnesses' : 'default harness set';
    console.log(
      `No manifest found; wrote a default at ${scaffold.path} ` +
        `(${setSource}: ${scaffold.harnesses.join(', ')}) - edit to customize.`
    );
    console.log('');
  }

  // Everything from here reads or writes the tree, and a person running this in
  // their own terminal gets a sentence when it goes wrong, never a stack. The
  // engine is not supposed to throw for anything it finds on disk — a dead link,
  // a file it does not own, a directory where a link should be are all answers it
  // returns — so this is the backstop for what is left: an unreadable manifest, a
  // permission error, a bug.
  try {
    // Project marketplace-installed plugins too (DOR-173). Project-scoped installs
    // (`<repoRoot>/.dork/plugins`) are repo-relative and always project; passing a
    // resolved dork home additionally projects global-scope installs.
    const dorkHome = resolveDorkHome();
    const { planWithConsent, projectWithConsent, scanHookRequests } =
      await import('../server/services/harness/project-with-consent.js');

    // Which harnesses the manifest enables, so a summary line for one it does
    // not can say so (DOR-1847). Read AFTER the projection, which reads the same
    // file: a malformed manifest should fail with the message the engine gives
    // it, not this one — and both land in the catch below as one sentence either
    // way.
    const enabledHarnesses = (): readonly HarnessId[] => loadManifest(repoRoot).harnesses;

    // `--allow-hooks` is resolved and RECORDED before the plan is built, so the
    // projection that follows reads one store — there is no per-run override to
    // disagree with what the app would do (contract D5).
    let decisions = await readStoredDecisions(dorkHome);
    if (args.allowHooks.length > 0) {
      const requests = scanHookRequests(repoRoot, dorkHome);
      const unknown = args.allowHooks.filter(
        (name) => !requests.some((request) => request.packageName === name)
      );
      if (unknown.length > 0) {
        // Nothing is written when any name is wrong: a typo must not half-record
        // a decision and leave the person to work out which half landed.
        console.error(
          `No installed package here declares hooks under ${unknown.map((n) => `'${n}'`).join(', ')}.`
        );
        console.error(
          requests.length > 0
            ? `  Packages with hooks in this project: ${requests.map((r) => r.packageName).join(', ')}`
            : '  No installed package in this project declares any hooks.'
        );
        return { exitCode: 1 };
      }
      const { initConfigManager } = await import('../server/services/core/config-manager.js');
      const { recordHookApproval } = await import('../server/services/harness/hook-consent.js');
      initConfigManager(dorkHome);
      for (const request of requests) {
        if (args.allowHooks.includes(request.packageName)) recordHookApproval(request);
      }
      decisions = await readStoredDecisions(dorkHome);
      console.log(
        `Allowed ${args.allowHooks.length} package${args.allowHooks.length === 1 ? '' : 's'} to install hooks here: ${args.allowHooks.join(', ')}`
      );
      console.log(
        `  Recorded in ${configPathFor(dorkHome)} — undo with \`dorkos harness hooks --revoke <package>\`.`
      );
      console.log('');
    }

    // Orphan sweep only runs on a full (unfiltered) plan: a filtered one omits
    // every other harness's live projections, and the sweep would read them as
    // orphans. The seam refuses the combination outright.
    const consentOpts = {
      dorkHome,
      decisions,
      ...(harnessFilter === undefined ? {} : { harness: harnessFilter }),
    };

    if (!args.fix) {
      const { plan, withheld } = planWithConsent(repoRoot, consentOpts);
      const exitCode = reportCheck(repoRoot, plan, withheld, harnessFilter, enabledHarnesses());
      return { exitCode: strictExit(exitCode, withheld, args.strict) };
    }

    const codexHooksBefore = readIfPresent(repoRoot, CODEX_HOOKS_TARGET);
    const result = projectWithConsent(repoRoot, {
      ...consentOpts,
      sweepOrphans: harnessFilter === undefined,
    });
    const exitCode = reportFix(
      repoRoot,
      result.plan,
      result,
      result.withheld,
      codexHooksBefore,
      harnessFilter,
      enabledHarnesses()
    );
    return { exitCode: strictExit(exitCode, result.withheld, args.strict) };
  } catch (err) {
    console.error(`Harness sync failed: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`  in ${repoRoot}`);
    // The stack is not thrown away, it is asked for: `LOG_LEVEL=debug` is the
    // repo's own spelling (`cli.ts` maps it through `LOG_LEVEL_MAP` into
    // `DORKOS_LOG_LEVEL` for everything downstream), and this namespace is
    // intercepted before that plumbing runs, so it reads the same two variables
    // itself — see `resolveDorkHome` for the same reason applied to DORK_HOME.
    if (err instanceof Error && err.stack && wantsDebugDetail()) console.error(err.stack);
    else console.error('  Re-run with LOG_LEVEL=debug to see the stack.');
    return { exitCode: 1 };
  }
}
