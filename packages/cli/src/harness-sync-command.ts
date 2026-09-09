import { existsSync, readFileSync } from 'node:fs';
import { LOG_LEVEL_MAP } from '@dorkos/shared/config-schema';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { rethrowUnknownOption } from './lib/parse-args-error.js';
import {
  formatWithheldBlock,
  readDorkosHarness,
  readStoredDecisions,
  resolveDorkHome,
  withheldSummaryLine,
} from './harness-consent.js';
import { resolveAllowHooks } from './harness-sync-allow-hooks.js';
import { runGlobalSync } from './harness-sync-global.js';
import type { WithheldHooks } from '../server/services/harness/project-with-consent.js';
import type { HarnessClaudeOnly } from '@dorkos/shared/harness-schemas';

import {
  ADOPTABLE_BLOCK_HEADING,
  adoptCommandFor,
  adoptableSentence,
  harnessesThatCannotSee,
  inventorySourceTree,
  readAdoptCandidates,
  agentsMdExists,
  appendGitignoreLines,
  checkPlan,
  enableHarnessInManifest,
  formatDropList,
  formatWarnings,
  hooksFactsFor,
  skillsFactsFor,
  canonicalLayerIgnoredBy,
  dorkosHarnessScaffoldNotice,
  CLAUDE_SKILLS_DIR,
  loadManifest,
  manifestNotices,
  missingGitignoreLines,
  pluginHookReach,
  scaffoldManifest,
  CODEX_HOOKS_TARGET,
  GENERATED_HOOK_TARGET_HARNESSES,
  HARNESS_IDS,
  HARNESS_LABELS,
  HARNESS_MANIFEST_PATH,
  type HarnessId,
  type HarnessManifest,
  type SkillRoot,
  type ProjectionAction,
  type ProjectionPlan,
  type SweptPath,
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
  /**
   * Harnesses to turn on in `.agents/harness.manifest.json`, repeatable.
   * Requires `--fix`.
   *
   * The ONE path that writes a manifest somebody else wrote (see
   * `enableHarnessInManifest`): an explicit flag, one inserted array element,
   * every other byte of the file left where it was. The same run then projects
   * with the harness enabled.
   */
  enable: string[];
  /**
   * Share the packages installed for all your projects instead of this folder's
   * files.
   *
   * A different subject, not a modifier: it reads `<dorkHome>/plugins` and links
   * every skill it finds into `<dorkHome>/skills`, the one folder DorkOS looks
   * in for skills that run on a timer. It needs no repository and reads no
   * manifest, so it works from any directory — which is why it is checked and
   * answered before this command looks for a manifest at all.
   */
  global: boolean;
  /**
   * Add the missing ephemeral-projection lines to the repo's `.gitignore`.
   * Requires `--fix`.
   *
   * Without it both modes only NAME the lines. Editing a file nobody asked about
   * is not what a person runs a sync for, and `.gitignore` is one of the files
   * people are most particular about.
   */
  writeGitignore: boolean;
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
  'Usage: dorkos harness sync [--check] [--fix] [--global] [--harness <id>] [--strict] [--allow-hooks <package>] [--enable <harness>] [--write-gitignore]';

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
        enable: { type: 'string', multiple: true },
        global: { type: 'boolean', default: false },
        'write-gitignore': { type: 'boolean', default: false },
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
    enable: Array.isArray(values.enable)
      ? values.enable.filter((id): id is string => typeof id === 'string')
      : [],
    global: Boolean(values.global),
    writeGitignore: Boolean(values['write-gitignore']),
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
 * The block naming every skill that lives where only some of this project's
 * agents look, one headline per root (S1c, S1 and S1b).
 *
 * The set is the adopt engine's own candidate list rather than a second reading
 * of the inventory, so the sentence a sync prints and the answer
 * `dorkos harness adopt` gives cannot disagree about which skills are on offer.
 *
 * The CLI passes NO `projectPath`: it ran in the repository, so a bare command
 * is right there — and that is the form the capability contract quotes for J-06.
 * Every surface DorkOS prints from the SERVER passes the absolute one instead.
 *
 * Nothing is printed when every enabled tool can already see the skill, and this
 * block never changes an exit code: a skill somebody keeps in one tool's folder
 * is a real choice, the same rule AP-15 already follows for a gitignored
 * `.agents/`.
 *
 * @param repoRoot - the project's absolute path.
 * @param manifest - the manifest, for the harnesses it enables, in its order.
 * @returns the lines to print, empty when there is nothing to say.
 */
function formatAdoptable(repoRoot: string, manifest: HarnessManifest): string[] {
  // A second inventory walk, and worth it: the plan does not carry one, and this
  // report is the only place the answer is needed.
  const { candidates } = readAdoptCandidates(repoRoot, inventorySourceTree(repoRoot), manifest);
  const byRoot = new Map<SkillRoot, string[]>();
  for (const candidate of candidates) {
    byRoot.set(candidate.root, [...(byRoot.get(candidate.root) ?? []), candidate.name]);
  }

  const lines: string[] = [];
  for (const [root, names] of byRoot) {
    const sorted = [...names].sort();
    const headline = adoptableSentence({
      root,
      names: sorted,
      cannotSee: harnessesThatCannotSee(root, manifest.harnesses),
    });
    if (headline === '') continue;
    lines.push(`  ${headline}`);
    // A headline cannot name three skills in one command, and a list of names
    // with no command is a second thing to look up — so each skill carries its
    // own, in full.
    if (sorted.length > 1) for (const name of sorted) lines.push(`    ${adoptCommandFor(name)}`);
  }
  return lines.length === 0 ? [] : ['', ADOPTABLE_BLOCK_HEADING, ...lines];
}

/**
 * The heading and lines for generated-hook paths the engine stepped over.
 *
 * Deliberately NOT a conflict: nothing was blocked, so this never changes an
 * exit code. It exists so a person whose repo DorkOS projects no hooks into is
 * told why their file is being ignored rather than left to guess.
 */
function formatLeftAlone(
  leftAlone: string[],
  manifest: HarnessManifest,
  harnessFilter?: HarnessId
): string[] {
  // `--harness <id>` narrows every other line of this report, so it narrows this
  // one too: a Cursor file is not an answer to a question about Codex.
  const shown = harnessFilter
    ? leftAlone.filter((path) => harnessOf(path) === harnessFilter)
    : leftAlone;
  if (shown.length === 0) return [];

  // The advice below is only true where writing the hooks down would actually
  // make DorkOS carry them. A `hookPolicies` entry of `none` or `native` is the
  // person's own instruction not to, so telling them to move their hooks into
  // `.claude/settings.json` would send them to do work that changes nothing —
  // and they would come back to the same untouched file (DOR-1858 review).
  const stopped = new Set(pluginHookReach(manifest).suppressed.map((s) => s.harness));
  const carried = shown.filter((path) => {
    const harness = harnessOf(path);
    return harness === undefined || !stopped.has(harness);
  });

  return [
    '',
    'Left alone — files DorkOS did not write, at paths it would otherwise generate:',
    ...shown.map((path) => {
      const harness = harnessOf(path);
      const note =
        harness && stopped.has(harness)
          ? " — your manifest's hookPolicies says not to write here"
          : '';
      return `  ${path}  (${harness})${note}`;
    }),
    carried.length > 0
      ? '  Nothing to fix. Put these hooks in .claude/settings.json if you want DorkOS to carry them to every harness.'
      : '  Nothing to fix, and nothing to move: your manifest tells DorkOS not to write these files.',
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
function reportWithheld(withheld: readonly WithheldHooks[], dorkHome: string): void {
  for (const entry of withheld) {
    for (const line of formatWithheldBlock(entry, dorkHome)) console.log(line);
  }
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

/**
 * Say out loud that a Claude Code session already open may not see the skills
 * this run just linked (contract SK-11).
 *
 * Only when the run CREATED `.claude/skills/`. That is the case where the vendor
 * documents a restart outright — Claude Code attaches its watcher to the
 * directories that exist when the session starts — and saying it on every sync
 * would be the noise that teaches people to skip the line on the one run where
 * it matters. The same rule as the Codex trust notice above, for the same
 * reason.
 *
 * The claim is read from the vendor-facts table, so it carries the page it came
 * from and the day it was read.
 *
 * @param existedBefore - Whether `.claude/skills/` was there before the apply.
 * @param repoRoot - The repository the sync ran in.
 */
function reportClaudeSkillsRestart(existedBefore: boolean, repoRoot: string): void {
  if (existedBefore) return;
  if (!existsSync(join(repoRoot, CLAUDE_SKILLS_DIR))) return;
  const facts = skillsFactsFor('claude-code');
  console.log('');
  console.log(`Created ${CLAUDE_SKILLS_DIR}/, which is where Claude Code reads skills.`);
  console.log('  Claude Code watches that folder for changes, but only if it was already');
  console.log('  there when the session started — so restart any Claude Code session you');
  console.log('  have open on this project before looking for these skills.');
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
 * The "Installed in Claude Code only" block: the plugins a person turned on in
 * Claude Code's own settings, and what DorkOS can offer to do about each one.
 *
 * Assembled HERE, beside `formatDropList`'s output and never inside it. Putting
 * it in the engine would make `@dorkos/harness` read a home directory, which
 * three of its own module docs forbid by name (`inventory/index.ts`,
 * `inventory/types.ts`, `inventory/hooks.ts`).
 *
 * **Nothing is printed when there is nothing to say.** A block that always
 * appears is a block people learn to skip, so a machine with no plugins turned
 * on gets zero lines, heading included. An empty group is skipped the same way.
 *
 * **The root is printed on every run.** `$CLAUDE_CONFIG_DIR` is inherited, so a
 * run started inside an agent session can read a different root than the
 * person's own terminal — measured at 7 entries in one and 16 in the other on
 * the machine this was written on. Choosing the right resolver does not by
 * itself make the answer right; saying which file it came from does.
 *
 * "Turned on", never "installed": Claude Code's `defaultEnabled` falls back to
 * `true` and its public half cannot enumerate installs, so a plugin nobody
 * listed is a state DorkOS cannot compute and must not imply. "Agent tools"
 * rather than "harnesses", because a person did not install a harness.
 *
 * Nothing here installs anything. Every offer is a printed command into the
 * flow that already exists, with its own preview and its own approval.
 *
 * @param claudeOnly - what the settings read found.
 * @param repoRoot - the project's absolute path, for the install command.
 * @returns the lines to print, empty when there is nothing to say.
 */
function formatClaudeOnly(claudeOnly: HarnessClaudeOnly, repoRoot: string): string[] {
  const { root, plugins, personalHookCommands: hooks } = claudeOnly;
  const HEADING = 'Installed in Claude Code only';

  if (claudeOnly.unreadable !== undefined) {
    return [
      '',
      HEADING,
      `  DorkOS could not read ${root}/settings.json, so it cannot tell you what Claude Code has. (${claudeOnly.unreadable})`,
      '  Nothing else in this report is affected.',
    ];
  }
  const notices = claudeOnly.unreadableParts.length + (claudeOnly.skippedEntries ?? 0);
  if (plugins.length === 0 && notices === 0) return [];

  // Where a plugin came from, in the strongest form the data supports. Neither
  // side carries a version DorkOS can compare, so a resolved repository is "the
  // same name from the same repository" and never "the same plugin"; an
  // unresolved one names only what Claude Code calls it.
  const from = (plugin: HarnessClaudeOnly['plugins'][number]): string =>
    plugin.repo === undefined
      ? `    - ${plugin.name} (from a source Claude Code calls "${plugin.marketplace}")`
      : `    - ${plugin.name} (from ${plugin.repo})`;

  const machineWide = plugins.filter((plugin) => plugin.settingsScope === 'user');
  const inGroup = (offer: HarnessClaudeOnly['plugins'][number]['offer']): typeof plugins =>
    machineWide.filter((plugin) => plugin.offer === offer);

  const lines: string[] = ['', HEADING, `  Read from ${root}`];
  if (plugins.length > 0) {
    lines.push(
      '',
      `  You turned on ${plugins.length} ${plugins.length === 1 ? 'plugin' : 'plugins'} in Claude Code. Your other agent tools cannot see them.`
    );
  }

  // What DorkOS could not read, said BEFORE the lists it affects, so nobody
  // reads a short list as a complete one. Each line names one key and says what
  // still holds, because "something went wrong" over a report full of confident
  // answers is worse than no line at all.
  for (const part of claudeOnly.unreadableParts) {
    lines.push(
      '',
      `  DorkOS could not read the ${part} part of ${root}/settings.json; the plugin list is still right.`
    );
  }
  const skipped = claudeOnly.skippedEntries ?? 0;
  if (skipped > 0) {
    lines.push(
      '',
      skipped === 1
        ? '  DorkOS could not read 1 of the entries in that file, so it is not listed.'
        : `  DorkOS could not read ${skipped} of the entries in that file, so they are not listed.`
    );
  }
  if (plugins.length === 0) return lines;

  if (hooks > 0) {
    lines.push(
      '',
      `  Your personal Claude Code settings run ${hooks} ${hooks === 1 ? 'command' : 'commands'} automatically. Only Claude Code runs ${hooks === 1 ? 'it' : 'them'}.`
    );
  }

  if (claudeOnly.sourcesUnreadable !== undefined) {
    // No offer can be made about anything, so none of the four group headings is
    // true. The plugins and their repositories still are, and the actual cause
    // is said once instead of being spread across every row as "DorkOS cannot
    // tell where these came from".
    lines.push(
      '',
      `  DorkOS could not read its own list of sources (${claudeOnly.sourcesUnreadable}), so it cannot offer installs right now.`,
      '',
      '  Turned on in Claude Code:',
      ...plugins.map(from),
      '',
      '  Your company can also turn plugins on or off, in a settings file DorkOS cannot read. So this list may',
      '  not be the whole story.'
    );
    return lines;
  }

  const canInstall = inGroup('install');
  if (canInstall.length > 0) {
    lines.push(
      '',
      '  DorkOS can install these for this project, so every agent tool here gets them:'
    );
    // The command sits beside its own package rather than after the whole list:
    // a name and the command that shares it are one thing to read, and eight
    // names followed by eight commands is not.
    for (const plugin of canInstall) {
      lines.push(from(plugin), `  Run: dorkos install ${plugin.name} --project ${repoRoot}`);
    }
    lines.push('  DorkOS has to be running, and it asks you to approve the install first.');
  }

  const needsSource = inGroup('add-source-then-install');
  if (needsSource.length > 0) {
    lines.push('', '  DorkOS does not have these sources yet:');
    for (const plugin of needsSource) {
      lines.push(
        from(plugin),
        `  Add the source first: dorkos marketplace add ${plugin.sourceUrl}`
      );
    }
  }

  const noPackage = inGroup('no-package');
  if (noPackage.length > 0) {
    lines.push('', '  DorkOS has that source but nothing by that name:', ...noPackage.map(from));
  }

  const unknownSource = inGroup('unknown-source');
  if (unknownSource.length > 0) {
    lines.push('', '  DorkOS cannot tell where these came from:', ...unknownSource.map(from));
  }

  const projectOnly = plugins.filter((plugin) => plugin.settingsScope === 'project');
  if (projectOnly.length > 0) {
    lines.push('', '  On for this project only:', ...projectOnly.map(from));
  }

  // Once, at the end. Managed settings may exist and DorkOS may not be allowed
  // to read them, so the report says the answer can be overridden rather than
  // answering as if the file were absent.
  lines.push(
    '',
    '  Your company can also turn plugins on or off, in a settings file DorkOS cannot read. So this list may',
    '  not be the whole story.'
  );
  return lines;
}

/**
 * One line per harness this manifest does not enable that something says it
 * should (contract TR-11).
 *
 * A NOTICE, and never anything else: it changes no exit code, because a person
 * who runs Cursor on a different project is not wrong and a failing command
 * nobody can clear is how people learn to stop reading the output. Detection
 * used to happen once, when the manifest was scaffolded, so a harness added a
 * month later was never enabled and never mentioned.
 *
 * Two claims, two sentences. A `footprint` names the path that gave the harness
 * away. A `dorkos-runtime` entry has no path to name — it is a fact about this
 * DorkOS, not about the folder — and it is the one that had no line at all: a
 * project that has never run Claude Code leaves no `.claude/` for detection to
 * find, so a manifest written before DOR-1901 stays silently short of the very
 * tool DorkOS starts its sessions on. Both end in the same command, because the
 * fix is the same.
 */
function formatNotEnabled(plan: ProjectionPlan): string[] {
  if (plan.notEnabled.length === 0) return [];
  const enableWith = (harness: HarnessId): string =>
    `add it to ${HARNESS_MANIFEST_PATH} or run dorkos harness sync --fix --enable ${harness}`;
  return [
    '',
    ...plan.notEnabled.map((found) =>
      found.why === 'dorkos-runtime'
        ? `DorkOS runs ${HARNESS_LABELS[found.harness]} here and this project does not enable it — ` +
          enableWith(found.harness)
        : `${found.signal} found; ${HARNESS_LABELS[found.harness]} is not enabled — ` +
          enableWith(found.harness)
    ),
  ];
}

/**
 * One line per statement in the manifest that reaches nothing: a key the engine
 * retired, or a hook policy naming a harness this manifest does not enable
 * (DOR-1858).
 *
 * A NOTICE, like {@link formatNotEnabled}, and never an exit code. The manifest
 * is hand-authored and per-repo, so nothing migrates it for the person — this
 * line IS the migration notice, and it names exactly what to delete.
 *
 * **`--harness` does not narrow it**, and that is deliberate rather than an
 * oversight: every other block is a report about a PROJECTION, so filtering it
 * to one harness is filtering the answer to the question that was asked. These
 * lines are about the file. A person who runs `--harness codex` has the same
 * dead keys in the same manifest, and hiding them until they happen to run an
 * unfiltered sync would be the silence this whole change is about.
 */
function formatManifestNotices(manifest: HarnessManifest): string[] {
  const notices = manifestNotices(manifest);
  return notices.length === 0 ? [] : ['', ...notices];
}

/**
 * The `.gitignore` lines this repo is missing for the files DorkOS writes, or
 * confirmation that they were just added (contract AP-09).
 *
 * @param missing - the lines, from `missingGitignoreLines`.
 * @param added - whether `--write-gitignore` has already appended them.
 * @returns the block, or nothing when there is nothing missing.
 */
function formatGitignore(missing: readonly string[], added: boolean): string[] {
  if (missing.length === 0) return [];
  const lines = missing.map((line) => `  ${line}`);
  if (added) return ['', `gitignore: added ${missing.length} line(s) to .gitignore:`, ...lines];
  return [
    '',
    'gitignore: DorkOS writes these, and they are not meant to be committed — your .gitignore does not cover them yet:',
    ...lines,
    '  Add them with `dorkos harness sync --fix --write-gitignore`, or paste them in yourself.',
  ];
}

/**
 * What a gitignored `.agents/` means for everyone else who clones this project
 * (contract AP-15).
 *
 * Ignoring it is a real choice some teams make, so this is an explanation rather
 * than a warning, and it changes no exit code. It is worth saying because the
 * consequence is invisible from here: the links DorkOS writes into `.claude/`
 * are ordinary committable files, so a teammate gets them pointing at a folder
 * their clone does not have.
 */
function formatIgnoredCanonicalLayer(repoRoot: string): string[] {
  const ignoredBy = canonicalLayerIgnoredBy(repoRoot);
  if (ignoredBy === undefined) return [];
  return [
    '',
    `.agents/ is ignored by ${ignoredBy}, so the shared folder stays on this computer.`,
    '  The links DorkOS writes into .claude/skills are still committed, so anyone who clones',
    '  this project gets links pointing at files git does not have. Moving a skill into',
    '  .agents/ would take it out of git for everyone, too.',
    `  Either stop ignoring .agents/ in ${ignoredBy}, or keep these skills on this machine`,
    '  on purpose.',
  ];
}

/**
 * One line of an orphan list, in either mode: the path, then why it goes.
 *
 * The reason is the ENGINE's (`apply/sweep-reasons.ts`, DOR-1906), never one
 * built here — the app's removal disclosure prints the same sentence, and two
 * surfaces describing one deletion in two voices is how a person stops trusting
 * either. The heading above these lines cannot do this job: six sweeps take
 * files for five different reasons, and one of the paths is not a deletion at
 * all — `.claude/settings.local.json` keeps every key the person owns and loses
 * only the entries DorkOS merged in, which the line for it says, exactly as it
 * always has.
 *
 * @param removal - the repo-relative orphan path and its reason.
 * @returns the indented line to print.
 */
function orphanLine({ path, reason }: SweptPath): string {
  return `  ${path} — ${reason}`;
}

/**
 * Print the check-mode report and return its exit code.
 *
 * Non-zero for drift (a `--fix` would repair it), for an orphan (a `--fix` would
 * remove it), and for a blocked projection (a `--fix` cannot do anything, until
 * the person moves their file). Zero for paths merely left alone — those are
 * reported, never counted against the tree.
 *
 * The orphan list is `checkPlan`'s, in full and unedited: since DOR-1889 it is
 * every path a `--fix` would delete, not just the dead skill links, so this
 * report names the nine files an uninstalled plugin leaves behind instead of
 * calling that tree clean. One of those paths is not a deletion —
 * `.claude/settings.local.json` loses only the hook entries DorkOS merged into
 * it — and {@link orphanLine} says so on that line rather than letting the
 * heading speak for it.
 *
 * **Orphans are withheld under `--harness`, by the engine.** A narrowed plan
 * omits every other harness's live projections, so its orphan finders would read
 * those as orphans and this report would recommend a `--fix --harness` that
 * refuses to sweep — measured before the guard: `--check --harness codex` said
 * "Orphaned links … gamma" and exited 1, `--fix --harness codex` exited 0 and
 * left the link, forever. The plan carries the harness it was narrowed to, so
 * `checkPlan` answers with an empty list and `clean` is already right; nothing is
 * recomputed here.
 */
function reportCheck(
  repoRoot: string,
  plan: ProjectionPlan,
  withheld: readonly WithheldHooks[],
  dorkHome: string,
  manifest: HarnessManifest,
  claudeOnly: HarnessClaudeOnly,
  harnessFilter?: HarnessId
): number {
  const drift = checkPlan(repoRoot, plan);
  const { orphans, removals } = drift;

  console.log('Projection summary:');
  console.log(summarizeActions(plan.actions, withheld, manifest.harnesses));
  console.log('');
  console.log(formatDropList(plan));
  const warningBlock = formatWarnings(plan);
  if (warningBlock) {
    console.log('');
    console.log(warningBlock);
  }
  for (const line of formatLeftAlone(drift.leftAlone, manifest, harnessFilter)) console.log(line);
  reportWithheld(withheld, dorkHome);
  for (const line of formatAdoptable(repoRoot, manifest)) console.log(line);
  for (const line of formatClaudeOnly(claudeOnly, repoRoot)) console.log(line);
  for (const line of formatNotEnabled(plan)) console.log(line);
  for (const line of formatManifestNotices(manifest)) console.log(line);
  for (const line of formatGitignore(missingGitignoreLines(repoRoot, plan), false)) {
    console.log(line);
  }
  for (const line of formatIgnoredCanonicalLayer(repoRoot)) console.log(line);
  console.log('');

  if (drift.clean) {
    console.log('No drift — every projection already matches the plan.');
    return 0;
  }

  if (drift.drifted.length > 0) {
    console.log(`Drift detected (${drift.drifted.length} out of sync):`);
    for (const action of drift.drifted) console.log(formatAction(action));
  }
  if (removals.length > 0) {
    if (drift.drifted.length > 0) console.log('');
    console.log(`Orphaned projections — what they came from is gone (${removals.length}):`);
    for (const removal of removals) console.log(orphanLine(removal));
  }
  if (drift.drifted.length > 0 || orphans.length > 0) {
    console.log('');
    // The removal is said out loud whenever there is one. A person reading
    // "to apply" over a list of nine files has not been told that running it
    // deletes them, and that is the whole point of naming them first.
    console.log(
      orphans.length > 0
        ? 'Run `dorkos harness sync --fix` to apply — the orphaned paths above are removed.'
        : 'Run `dorkos harness sync --fix` to apply.'
    );
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
    removals: SweptPath[];
    leftAlone: string[];
  },
  withheld: readonly WithheldHooks[],
  codexHooksBefore: string | undefined,
  claudeSkillsExistedBefore: boolean,
  dorkHome: string,
  writeGitignore: boolean,
  manifest: HarnessManifest,
  claudeOnly: HarnessClaudeOnly,
  harnessFilter?: HarnessId
): number {
  const { applied, conflicts, removals, leftAlone } = applyResult;

  console.log(`Applied ${applied.length} projection(s):`);
  for (const action of applied) console.log(formatAction(action));
  reportCodexTrust(codexHooksBefore, readIfPresent(repoRoot, CODEX_HOOKS_TARGET));
  reportClaudeSkillsRestart(claudeSkillsExistedBefore, repoRoot);
  console.log('');
  console.log('Projection summary:');
  // The enabled set reaches here too, and it did not have to. `--fix` printed no
  // summary at all when DOR-1847 annotated `--check`'s; it does now, and a
  // `codex:` line reads "Codex is on" to the same person on the same project
  // whichever mode they ran.
  console.log(summarizeActions(plan.actions, withheld, manifest.harnesses));
  console.log('');
  console.log(formatDropList(plan));
  const warningBlock = formatWarnings(plan);
  if (warningBlock) {
    console.log('');
    console.log(warningBlock);
  }

  if (removals.length > 0) {
    console.log('');
    console.log(`Swept ${removals.length} orphaned projection(s) — what they came from is gone:`);
    // Sorted for DISPLAY only, so the receipt lines up with the promise the
    // `--check` before it printed. The engine's list stays in sweep order — that
    // is the order things happened in, and it is the engine's to decide.
    for (const removal of [...removals].sort((a, b) => (a.path < b.path ? -1 : 1))) {
      console.log(orphanLine(removal));
    }
  }

  // Reported, never counted: a file DorkOS was not going to write anyway is not
  // a reason to hand somebody a failing command on every sync.
  for (const line of formatLeftAlone(leftAlone, manifest, harnessFilter)) console.log(line);

  // Printed AFTER what landed, so the report reads in the order it happened:
  // this is what was installed, and this is what was not.
  reportWithheld(withheld, dorkHome);

  for (const line of formatAdoptable(repoRoot, manifest)) console.log(line);
  for (const line of formatClaudeOnly(claudeOnly, repoRoot)) console.log(line);
  for (const line of formatNotEnabled(plan)) console.log(line);
  for (const line of formatManifestNotices(manifest)) console.log(line);

  // The one write in this block, and it is the one the person asked for by
  // passing the flag. Without it the lines are named and nothing is touched:
  // `.gitignore` is a file people are particular about, and a sync that edits
  // one uninvited is a sync people stop running.
  const missingLines = missingGitignoreLines(repoRoot, plan);
  if (writeGitignore && missingLines.length > 0) appendGitignoreLines(repoRoot, missingLines);
  for (const line of formatGitignore(missingLines, writeGitignore)) console.log(line);
  for (const line of formatIgnoredCanonicalLayer(repoRoot)) console.log(line);

  if (conflicts.length === 0) return 0;

  console.log('');
  console.log(
    `${conflicts.length} conflict(s) left untouched — something DorkOS does not own occupies the target. Each line says what is in the way; clear it, then re-run:`
  );
  for (const action of conflicts) console.log(formatAction(action));
  return 1;
}

/**
 * The flags that are about THIS folder, and so cannot be combined with
 * `--global`.
 *
 * Each is refused by name rather than ignored. `--harness` narrows a plan to one
 * agent tool and a global plan is never narrowed; `--enable` and
 * `--write-gitignore` write files inside a repository; `--allow-hooks` records a
 * decision about hooks, which a global plan does not project at all; `--strict`
 * exits non-zero when a package's hooks were withheld, and a global plan
 * projects no hooks, so it can never do anything. Silently accepting any of them
 * would make the command look like it had done something it never does — and an
 * inert `--strict` is the worst of the five, because a CI script passes it
 * precisely to be stopped.
 */
const PROJECT_ONLY_FLAGS = [
  '--harness',
  '--enable',
  '--allow-hooks',
  '--strict',
  '--write-gitignore',
] as const;

/** Which project-only flags this invocation passed, in the order they are listed. */
function projectOnlyFlagsIn(args: HarnessSyncArgs): string[] {
  return [
    ...(args.harness === undefined ? [] : ['--harness']),
    ...(args.enable.length > 0 ? ['--enable'] : []),
    ...(args.allowHooks.length > 0 ? ['--allow-hooks'] : []),
    ...(args.strict ? ['--strict'] : []),
    ...(args.writeGitignore ? ['--write-gitignore'] : []),
  ];
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

  // `--global` is a different subject, not a modifier, so its refusals are
  // answered here — before anything reads a manifest, and before the flags below
  // that only make sense inside a repository.
  if (args.global) {
    const clashes = projectOnlyFlagsIn(args);
    if (clashes.length > 0) {
      console.error(
        `--global shares the packages installed for all your projects, so it does not take ${clashes.join(' or ')}.`
      );
      console.error(
        `Run: dorkos harness sync ${args.fix ? '--fix' : '--check'} --global, or drop --global to sync this folder.`
      );
      console.error(`  ${PROJECT_ONLY_FLAGS.join(', ')} are about this folder's files.`);
      return { exitCode: 1 };
    }
    try {
      return { exitCode: await runGlobalSync(args, resolveDorkHome()) };
    } catch (err) {
      console.error(`Harness sync failed: ${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof Error && err.stack && wantsDebugDetail()) console.error(err.stack);
      else console.error('  Re-run with LOG_LEVEL=debug to see the stack.');
      return { exitCode: 1 };
    }
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

  // A typo is reported BEFORE the mode requirement, so `--check --enable curser`
  // says which word is wrong rather than sending the person to re-run the same
  // typo with `--fix`. Nothing has read or written the tree yet either way.
  const unknownEnable = args.enable.filter(
    (id) => !(HARNESS_IDS as readonly string[]).includes(id)
  );
  if (unknownEnable.length > 0) {
    console.error(
      `Unknown harness: ${unknownEnable.map((id) => `'${id}'`).join(', ')}. Known harnesses: ${HARNESS_IDS.join(', ')}`
    );
    return { exitCode: 1 };
  }

  // `--enable` writes the manifest and `--write-gitignore` writes `.gitignore`,
  // so both belong to the write mode. Refused rather than quietly ignored, and
  // each message names the command to run instead of restating the rule.
  if (args.enable.length > 0 && !args.fix) {
    console.error('--enable turns a harness on in your manifest, so it needs --fix.');
    console.error(
      `Run: dorkos harness sync --fix ${args.enable.map((id) => `--enable ${id}`).join(' ')}`
    );
    return { exitCode: 1 };
  }
  if (args.writeGitignore && !args.fix) {
    console.error('--write-gitignore adds lines to your .gitignore, so it needs --fix.');
    console.error('Run: dorkos harness sync --fix --write-gitignore');
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

  // `--enable` turns a harness on for the whole project, and the run that does
  // it should be the run that sets it up. Narrowed to another harness it would
  // write the manifest and then project nothing for what it had just enabled —
  // a half-done job whose missing half a person has no reason to expect.
  if (args.enable.length > 0 && harnessFilter !== undefined) {
    console.error(
      '--enable turns a harness on for the whole project, so it does not take --harness.'
    );
    console.error(
      `Run: dorkos harness sync --fix ${args.enable.map((id) => `--enable ${id}`).join(' ')}`
    );
    return { exitCode: 1 };
  }

  const repoRoot = process.cwd();
  // The agent tool DorkOS's own sessions run on, read STRAIGHT OFF disk: opening
  // the config store creates it, and `--check` is documented as never writing
  // anything (DOR-678). It decides one entry in a scaffolded manifest and one
  // notice line; it changes nothing a sync writes on its own.
  const ourHarness = await readDorkosHarness(resolveDorkHome());
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

    const scaffold = scaffoldManifest(repoRoot, {
      ...(ourHarness === undefined ? {} : { dorkosHarness: ourHarness }),
    });
    // What the set came from, and it is now three answers rather than two: a
    // detected set can carry one harness detection did NOT find, and calling
    // that whole list "detected harnesses" — or, worse, calling
    // `claude-code, codex, opencode` the "default harness set" when the default
    // is two of those — states something the person can check and find false.
    const dorkos = scaffold.addedForDorkos;
    const base = scaffold.detected ? 'detected harnesses' : 'default set';
    const setSource =
      dorkos === null
        ? base
        : `${base} plus ${HARNESS_LABELS[dorkos]}, because DorkOS runs it here`;
    console.log(
      `No manifest found; wrote a default at ${scaffold.path} ` +
        `(${setSource}: ${scaffold.harnesses.join(', ')}) - edit to customize.`
    );
    // …and what that one entry means for the files in their folder.
    if (dorkos) {
      console.log(dorkosHarnessScaffoldNotice(dorkos, agentsMdExists(repoRoot)));
    }
    console.log('');
  }

  // Everything from here reads or writes the tree, and a person running this in
  // their own terminal gets a sentence when it goes wrong, never a stack. The
  // engine is not supposed to throw for anything it finds on disk — a dead link,
  // a file it does not own, a directory where a link should be are all answers it
  // returns — so this is the backstop for what is left: an unreadable manifest, a
  // permission error, a bug.
  try {
    // Enabling comes BEFORE the plan is built, so one command both turns the
    // harness on and projects to it — a person who has just been told a harness
    // is missing should not have to run the same command twice.
    for (const id of args.enable) {
      const enabled = enableHarnessInManifest(repoRoot, id as HarnessId);
      if (enabled.outcome === 'unwritable') {
        console.error(`DorkOS did not change ${enabled.path}: ${enabled.reason}.`);
        console.error(`  Add "${id}" to its "harnesses" list yourself, then run this again.`);
        return { exitCode: 1 };
      }
      console.log(
        enabled.outcome === 'enabled'
          ? `Enabled ${HARNESS_LABELS[enabled.harness]} in ${enabled.path}.`
          : `${HARNESS_LABELS[enabled.harness]} was already enabled in ${enabled.path}.`
      );
    }
    if (args.enable.length > 0) console.log('');

    // Project marketplace-installed plugins too (DOR-173). Project-scoped installs
    // (`<repoRoot>/.dork/plugins`) are repo-relative and are the ones that
    // project. Passing a resolved dork home does NOT project the global ones —
    // nothing targets `<dorkHome>/skills` or the user tier yet (DOR-174) — it
    // makes them visible, so the report can say what each holds, who can see it,
    // and when one of them is also installed in this project (DOR-1922).
    const dorkHome = resolveDorkHome();
    const { planWithConsent, projectWithConsent, scanHookRequests } =
      await import('../server/services/harness/project-with-consent.js');

    // The manifest itself, for the things the run needs from it directly rather
    // than through a plan: which harnesses it enables, so a summary line for one
    // it does not can say so (DOR-1847); the statements in it that reach nothing
    // (DOR-1858); and whether a `--allow-hooks` yes could reach anything at all.
    //
    // WHEN it is read depends on the path, and both are fine. `--allow-hooks`
    // reads it BEFORE the plan is built, because refusing to record a durable
    // decision has to happen before the store is opened. Every other path reads
    // it after the projection. The error text is the same either way: this is
    // `loadManifest`, the engine's own loader, so a malformed manifest fails with
    // the engine's message wherever it is called from, and both land in the catch
    // below as one sentence.
    const readManifest = (): HarnessManifest => loadManifest(repoRoot);

    // `--allow-hooks` is resolved and RECORDED before the plan is built, so the
    // projection that follows reads one store — there is no per-run override to
    // disagree with what the app would do (contract D5).
    let decisions = await readStoredDecisions(dorkHome);
    if (args.allowHooks.length > 0) {
      const resolved = await resolveAllowHooks({
        repoRoot,
        dorkHome,
        manifest: readManifest(),
        allowHooks: args.allowHooks,
        decisions,
        scanHookRequests,
      });
      if ('exitCode' in resolved) return { exitCode: resolved.exitCode };
      decisions = resolved.decisions;
    }

    // Orphan sweep only runs on a full (unfiltered) plan: a filtered one omits
    // every other harness's live projections, and the sweep would read them as
    // orphans. The seam refuses the combination outright.
    const consentOpts = {
      dorkHome,
      decisions,
      ...(harnessFilter === undefined ? {} : { harness: harnessFilter }),
      ...(ourHarness === undefined ? {} : { dorkosHarness: ourHarness }),
    };

    // What Claude Code alone has (SRC-08, J-07, HK-14's user half). The FOURTH
    // dynamic server import in this file, by relative path like the three above
    // it, and the resolver it needs is called inside that module rather than
    // respelled here: `$CLAUDE_CONFIG_DIR ?? ~/.claude` is a rule the server's
    // Hard Rule 3 carve-out exists to keep in one file.
    //
    // It answers with a record and never throws, which is what lets the rest of
    // this report survive an unreadable settings file in somebody's home
    // directory.
    const { collectClaudeOnlyPlugins } =
      await import('../server/services/harness/claude-enabled-plugins.js');
    const claudeOnly = await collectClaudeOnlyPlugins({ projectPath: repoRoot, dorkHome });

    if (!args.fix) {
      const { plan, withheld } = planWithConsent(repoRoot, consentOpts);
      const exitCode = reportCheck(
        repoRoot,
        plan,
        withheld,
        dorkHome,
        readManifest(),
        claudeOnly,
        harnessFilter
      );
      return { exitCode: strictExit(exitCode, withheld, args.strict) };
    }

    const codexHooksBefore = readIfPresent(repoRoot, CODEX_HOOKS_TARGET);
    const claudeSkillsExistedBefore = existsSync(join(repoRoot, CLAUDE_SKILLS_DIR));
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
      claudeSkillsExistedBefore,
      dorkHome,
      args.writeGitignore,
      readManifest(),
      claudeOnly,
      harnessFilter
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
