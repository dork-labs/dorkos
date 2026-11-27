/**
 * The durable record of who may install hooks, and who may not (DOR-522,
 * DOR-1849).
 *
 * ## What an entry is
 *
 * `<packageName>@<digest>`, where the digest covers the resolved project path
 * and every hook — command, event and matcher. The same two lists also hold a
 * second kind of entry, `<packageName>@global-<digest>`: a person's decision
 * about a GLOBALLY installed package's programs, which load into every session
 * (`marketplace/global-plugin-consent.ts`, DOR-2306). It is the same decision —
 * let an installed package run commands automatically — so it lives in the same
 * operator-only store and is listed and revoked the same way. The name is in front so a person
 * can read their own `~/.dork/config.json` and see which packages they have
 * decided about; the digest behind it is what makes the entry stop matching the
 * moment any of those change. Binding the command text alone would let a package
 * move an allowed command from `Stop` (once, at the end) to `PreToolUse` (before
 * every single tool call) without asking.
 *
 * ## The files the hooks run are pinned too (DOR-3403)
 *
 * A hook of the form `node "${CLAUDE_PLUGIN_ROOT}/hooks/loop.mjs"` used to keep
 * its digest across an update that rewrote `loop.mjs`, so new code ran on an
 * old yes. A request now carries the sha256 of every file its commands name
 * (`hook-script-pins.ts`), and an entry is `<packageName>@<commands>.<files>`:
 * the commands digest as before, then a digest of the pinned files. An entry
 * for hooks that name no file has no second part, so it is byte-for-byte what
 * it always was.
 *
 * - **Same commands, same files:** the yes applies.
 * - **Same commands, a file changed:** the yes no longer applies, at every
 *   preset. Below Full the person is asked again; on Full the package waits in
 *   a passive row under Needs you, unless DorkOS installed it and its folder
 *   is unchanged (`project-with-consent.ts`, DOR-3433).
 * - **An entry from before pins** (`<name>@<commands>` alone, for hooks that do
 *   name a file): it applies, and the running server pins today's files onto it
 *   the first time it sees it (a `hook_files_pinned` decision the space side
 *   writes, `core/approvals/computer-asks/hook-decisions.ts`), the same
 *   one-time pin the agent folder settings took on upgrade. After that it is
 *   strict like any other.
 * - **A no** is about the commands, so it holds whatever the files hold: a
 *   package a person turned down is not asked about again because it edited a
 *   script.
 *
 * Only the files named in the command are pinned. What those files import, and
 * a package whose install folder is a dev link, are the residual
 * `hook-script-pins.ts` states.
 *
 * ## Two lists, one digest, never both
 *
 * `harness.approvedHooks` holds the yeses and `harness.refusedHooks` the noes,
 * in the same form. Recording either side removes the matching entry from the
 * other, so a package is approved, refused, or undecided — never two of them.
 *
 * A refusal used to live in process memory only, on the reasoning that a durable
 * "no" would be a decision with nothing to undo it. That reasoning is spent:
 * `dorkos harness hooks --list` shows every stored decision and
 * `--revoke <package>` removes one, and a refusal expires on its own the moment
 * the package changes what it wants to run, because the digest stops matching.
 * A durable "no" is what lets a person's answer be obeyed by every later trigger
 * instead of being forgotten on the next restart.
 *
 * ## Where the record lives
 *
 * `~/.dork/config.json`, both leaves classified `operator-only` in
 * `core/operator/config-write-policy.ts` — the same home, and the same
 * reasoning, as `extensions.approvedToRun`. A record of a human decision must
 * not be writable by the thing the decision is about, and user config is where
 * this repo already keeps that: `config_patch` refuses `operator-only` paths,
 * `PATCH /api/config` refuses a caller carrying agent identity, and the drift
 * guards fail the build if the classification goes missing. The residual, stated:
 * with login off, a caller that simply omits its agent header is treated as the
 * operator (DOR-505). Turning on Require login closes it.
 *
 * ## Who writes it
 *
 * The space side, never this module (spec `computer-side-starts-alone` §5.7):
 * a card's answer, a person's CLI verb and a global package's consent are
 * written by `core/approvals/computer-asks/hook-decisions.ts`, and a decision
 * the computer makes with no card reaches it through the asks port
 * (`harness/computer-asks.ts`). This module reads.
 *
 * ## Why there are two ways to READ the same file
 *
 * {@link storedHookDecisions} reads the running server's live store.
 * {@link readHookDecisionsFromDisk} parses `config.json` directly, and exists
 * for exactly one caller: `dorkos harness sync --check`, which is documented as
 * never writing anything (DOR-678). Opening a `conf` store is not a read —
 * measured, its constructor creates the directory and writes `config.json` when
 * either is absent — so a check-mode consult through the config manager would
 * plant a `~/.dork` in whatever directory the person happened to run it from.
 * The two must agree, which is why the read path parses the SAME Zod schema
 * rather than a hand-rolled shape of its own.
 *
 * @module services/harness/hook-consent
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UserConfigSchema } from '@dorkos/shared/config-schema';
import type { HookProjectionRequest } from '@dorkos/shared/computer-asks';
import {
  hookApprovalEntry,
  hookCommandsKey,
  hookEntryPackageName,
  sameHookCommands,
} from '@dorkos/shared/consent-entries';
import { configManager } from '../core/config-manager.js';

// The stored form of a decision is the space side's too: it writes these lists
// (`core/approvals/computer-asks/hook-decisions.ts`), this module reads them.
export type { HookProjectionRequest };
export { hookApprovalEntry, hookCommandsKey, hookEntryPackageName, sameHookCommands };

/** The two stored lists, read together so a caller cannot consult one and forget the other. */
export interface HookDecisions {
  /** `<packageName>@<digest>` entries a person allowed. */
  approved: readonly string[];
  /** `<packageName>@<digest>` entries a person turned down. */
  refused: readonly string[];
  /**
   * Why the lists are empty because the FILE could not be read, when that is
   * what happened.
   *
   * A missing `config.json` is a fresh install and leaves this absent: nothing
   * has been decided, and "nothing decided" is the truth. A truncated or
   * schema-invalid one is a different thing entirely, and collapsing the two
   * made every surface say the opposite of what was true — "you have not
   * allowed this package yet" about a package somebody had allowed, and "no
   * hook decisions stored yet" over a file full of them. Worse, the way out it
   * then suggested (`--fix --allow-hooks`) opens the config store, whose
   * corrupt-recovery backs the file up and resets EVERY setting to defaults.
   *
   * Carrying the reason lets each surface say the true thing and stop.
   */
  unreadable?: string;
  /**
   * Whether the stored permission preset is Full. On Full the hooks of a
   * package DorkOS installed, with its folder unchanged, run without a yes
   * (DOR-3422); every other package needs a yes for exactly the files it runs
   * (DOR-3433). A no still holds. Absent means "ask the running server's
   * config"; the read-only disk path sets it.
   */
  full?: boolean;
  /**
   * Set only on the running server's own lists ({@link storedHookDecisions}),
   * so a caller that passes them in still gets a yes from before pins pinned
   * once (`hook_files_pinned`). Never set on the read-only disk copy
   * or a list built by hand, which must write nothing.
   */
  live?: true;
}

/** Nothing decided — the shape a fresh install resolves to. */
const NO_DECISIONS: HookDecisions = { approved: [], refused: [] };

/** Local shorthand for {@link sameHookCommands}. */
const sameCommands = sameHookCommands;

/**
 * How a request stands against the stored yeses.
 *
 * - `exact`: a yes for these commands and these files.
 * - `unpinned`: a yes for these commands recorded before files were pinned.
 * - `changed`: a yes for these commands, when a file they run held other bytes.
 * - `none`: no yes for these commands.
 */
export type HookApprovalMatch = 'exact' | 'unpinned' | 'changed' | 'none';

/**
 * How a request stands against the stored yeses ({@link HookApprovalMatch}).
 *
 * @param request - The projection about to happen.
 * @param decisions - The stored lists.
 * @returns The kind of match.
 */
export function hookApprovalMatch(
  request: HookProjectionRequest,
  decisions: HookDecisions
): HookApprovalMatch {
  const entry = hookApprovalEntry(request);
  if (decisions.approved.includes(entry)) return 'exact';
  const key = hookCommandsKey(request);
  // A request that pins no files (a dev link, whose folder is the developer's
  // own) is covered by any yes for the same commands.
  if ((request.scripts ?? []).length === 0) {
    return decisions.approved.some((stored) => sameCommands(stored, key)) ? 'exact' : 'none';
  }
  if (decisions.approved.includes(key)) return 'unpinned';
  return decisions.approved.some((stored) => sameCommands(stored, key)) ? 'changed' : 'none';
}

/**
 * What separates a package name from the digest in a GLOBAL package's entry
 * (`<name>@global-<digest>`, `marketplace/global-plugin-consent.ts`), so a
 * reader of the lists can tell the two kinds of decision apart.
 */
export const GLOBAL_ACTIVATION_ENTRY_MARKER = '@global-';

/**
 * Whether a stored decision is about a globally installed package's programs,
 * which load into every session, rather than a project's hooks.
 *
 * @param entry - A stored `<packageName>@<digest>` entry.
 * @returns True for a `<name>@global-<digest>` entry.
 */
export function isGlobalActivationEntry(entry: string): boolean {
  return entry.lastIndexOf(GLOBAL_ACTIVATION_ENTRY_MARKER) > 0;
}

/**
 * What separates the source's path from the digest in a person's remembered
 * decision about their own worktree's `workspace.json` hooks
 * (`<source real path>@workspace-<digest>`, `workspace/workspace-gate.ts`,
 * DOR-2335). The same decision as a package's hooks, about commands DorkOS runs
 * for them, so it lives in the same operator-only lists and is listed and
 * revoked the same way (`--revoke <source path>`).
 */
export const WORKSPACE_HOOKS_ENTRY_MARKER = '@workspace-';

/**
 * Whether a stored decision is about a worktree's `workspace.json` hooks.
 *
 * @param entry - A stored entry.
 * @returns True for a `<path>@workspace-<digest>` entry.
 */
export function isWorkspaceHooksEntry(entry: string): boolean {
  return entry.lastIndexOf(WORKSPACE_HOOKS_ENTRY_MARKER) > 0;
}

/**
 * Both stored lists, as the running server sees them.
 *
 * @returns The approved and refused entries.
 */
export function storedHookDecisions(): HookDecisions {
  const harness = configManager.get('harness');
  return {
    approved: harness.approvedHooks,
    refused: harness.refusedHooks,
    // Read when asked, not here: only an undecided package needs the preset,
    // and most reads of these lists never get that far.
    get full() {
      return storedPresetIsFull();
    },
    live: true,
  };
}

/**
 * Whether the running server's stored permission preset is Full.
 *
 * @returns True on Full.
 */
export function storedPresetIsFull(): boolean {
  return configManager.get('permissions')?.preset === 'full';
}

/**
 * Both stored lists, read straight off `config.json` without opening the store.
 *
 * For the one caller that must not write: see "Why there are two ways to READ
 * the same file" above.
 *
 * Three outcomes, and telling the last two apart is the whole point. A file that
 * is not there is a fresh install: nothing decided, and every package's hooks
 * are simply unasked. A file that IS there and cannot be read — truncated,
 * hand-edited into invalid JSON, a `harness` block the schema rejects — is
 * reported as {@link HookDecisions.unreadable}, so the caller says so instead of
 * announcing that nobody has decided anything. Both fail CLOSED either way:
 * nothing is installed on the strength of a file DorkOS could not parse.
 *
 * A file that is missing its `harness` block entirely is NOT unreadable: the
 * schema supplies the section's defaults, which is the same answer the running
 * server would give.
 *
 * @param dorkHome - The resolved DorkOS data directory holding `config.json`.
 * @returns The approved and refused entries, or the reason there are none.
 */
export function readHookDecisionsFromDisk(dorkHome: string): HookDecisions {
  const configPath = join(dorkHome, 'config.json');
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (err) {
    // Absent is the ordinary case and the honest one. Anything else about the
    // file itself — a permission the operating system changed, a directory
    // where the file should be — is a reason a person needs to hear.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return NO_DECISIONS;
    return { ...NO_DECISIONS, unreadable: describeReadFailure(err) };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ...NO_DECISIONS, unreadable: describeReadFailure(err) };
  }

  const stored = (raw as { harness?: unknown } | null)?.harness;
  const parsed = UserConfigSchema.shape.harness.safeParse(stored);
  if (!parsed.success) {
    return {
      ...NO_DECISIONS,
      unreadable: `the "harness" settings are not in a shape DorkOS understands (${parsed.error.issues[0]?.message ?? 'invalid'})`,
    };
  }
  const preset = (raw as { permissions?: { preset?: unknown } } | null)?.permissions?.preset;
  return {
    approved: parsed.data.approvedHooks,
    refused: parsed.data.refusedHooks,
    full: preset === 'full',
  };
}

/** One short clause naming what went wrong, for a message a person reads. */
function describeReadFailure(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Whether a person has already allowed exactly this package to install exactly
 * these hooks into exactly this project, running exactly these files.
 *
 * A yes whose files have changed since does not apply, at any preset; see "The
 * files the hooks run are pinned too" above. What Full lets through without a
 * yes is decided in `planWithConsent`, which knows what DorkOS installed.
 *
 * @param request - The projection about to happen.
 * @param decisions - The stored lists; defaults to the running server's.
 * @returns True when a stored yes covers it.
 */
export function isHookProjectionApproved(
  request: HookProjectionRequest,
  decisions: HookDecisions = storedHookDecisions()
): boolean {
  const match = hookApprovalMatch(request, decisions);
  return match === 'exact' || match === 'unpinned';
}

/**
 * Whether a person has already turned these hooks down for this project.
 *
 * Matched on the commands alone: a no holds whatever the files they run hold
 * now, so editing a script never puts a turned-down package back in front of
 * a person.
 *
 * @param request - The projection about to happen.
 * @param decisions - The stored lists; defaults to the running server's.
 * @returns True when a stored no covers it.
 */
export function isHookProjectionRefused(
  request: HookProjectionRequest,
  decisions: HookDecisions = storedHookDecisions()
): boolean {
  const key = hookCommandsKey(request);
  return decisions.refused.some((stored) => sameCommands(stored, key));
}
