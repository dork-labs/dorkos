/**
 * The executable content an install approval attests to (DOR-647).
 *
 * A marketplace approval is bound to `(capability, inputs)` — the package, the
 * marketplace, the project, the purge flag. That was the whole of what a person's
 * yes was about while the preview was file counts and destination paths: a fresh
 * resolve producing a slightly different file list is not something anybody
 * consented to one way or the other.
 *
 * DOR-635 changed what the preview says. Its headline disclosure is now a
 * **verbatim shell command** and a **scheduled job with its permission mode named
 * in plain words** — exactly the facts a yes IS about. With those outside the
 * binding, a re-resolve between the card and the install could run a command
 * nobody read, and nothing would notice. So this module names the subset of the
 * preview an approval has to cover, and {@link disclosedEffectsOf} is what
 * `bindingOf` hashes.
 *
 * ## What is in
 *
 * Every hook command string (with the event and matcher that decide WHEN it
 * runs) and every scheduled job (with the cron and permission mode that decide
 * when it fires and how much it may do unattended). These are the parts of the
 * preview that execute on their own, with nothing between the install and the
 * running command except the clock.
 *
 * ## What is out, and the DIFFERENT reason for each group
 *
 * These are three separate arguments, and collapsing them into one ("the preview
 * is derived") is how somebody later relaxes the wrong thing.
 *
 * 1. **`fileChanges`, `conflicts`, `requires` — genuinely renumbering.** A fresh
 *    resolve can legitimately produce a different file list, a conflict against
 *    state that moved, or a requirement that became satisfied. None of it runs.
 *    Re-asking because a package gained a README would train a person to click
 *    through the card that matters, which is the one real cost of a strict
 *    binding.
 * 2. **`extensions`, `secrets`, `externalHosts` — a SECOND person-approval stands
 *    between them and any code running.** A marketplace extension defaults OFF
 *    (`defaultsOn` in `services/extensions/extension-enable-resolution.ts` returns
 *    false for anything that is not a bundled core extension), and running one
 *    inside the server process additionally requires its id in
 *    `config.extensions.approvedToRun` — a separate, explicit yes (DOR-516,
 *    `extension-load-policy.ts`). `secrets` and `externalHosts` are read off those
 *    same extension manifests, so they are downstream of that gate too. Nothing
 *    here can execute on the strength of the install approval alone.
 * 3. **`npmDependencies` — cannot execute at install time at all.** The install
 *    fetches them with `npm install --ignore-scripts`, which is pinned by a test
 *    that ships a package declaring `ignore-scripts=false` in its own `.npmrc` and
 *    asserts the postinstall still does not run
 *    (`lib/__tests__/npm-dependencies.test.ts`). A changed dependency is a changed
 *    library the package may later import — which is real, and is the residual
 *    this binding does not cover — but it is not code the install itself runs.
 *
 * `unreadableHooks` is out for a fourth, narrower reason: a declaration that
 * became readable, or stopped being readable, changes the hook list itself, so the
 * binding already moves without it.
 *
 * ## Order: semantic for hooks, not for schedules
 *
 * Hooks are hashed in declaration order, because hooks on one event RUN in that
 * order — a reordering changes what executes. Schedules are sorted before hashing,
 * because they do not: each fires on its own clock, and the preview's order is
 * partly `readdir` order over `.dork/tasks/` (`readTaskSkills` in
 * `permission-preview.ts`), which the filesystem does not promise to keep stable.
 * A spurious re-ask is not a harmless false positive here — it is the thing that
 * teaches an operator to stop reading the card.
 *
 * @module services/marketplace/disclosed-effects
 */
import { stableStringify } from '@dorkos/shared/capabilities';
import { quoteSummaryValue } from '../core/approvals/index.js';
import type { PermissionPreview } from './types.js';

/** One shell command a package declares, as the approval card showed it. */
export interface DisclosedHook {
  /** Harness event the command fires on (e.g. `PreToolUse`, `Stop`). */
  event: string;
  /** Tool/event matcher the hook narrows to; `null` when it matches everything. */
  matcher: string | null;
  /** The literal shell command, verbatim — never paraphrased or normalized. */
  command: string;
}

/** One scheduled job the install would create, and what it may do unattended. */
export interface DisclosedSchedule {
  /** Job name as the package declares it. */
  name: string;
  /** Cron expression, or `null` when the job only runs when asked. */
  cron: string | null;
  /** How much the job may do without a person in the loop, after the clamp. */
  permissionMode: string;
  /** Whether the job is created switched on. */
  startsEnabled: boolean;
}

/**
 * Everything executable a permission preview disclosed, in the shape an approval
 * binds to. Plain JSON throughout, because `hashApprovalInput` refuses anything
 * canonicalization would flatten.
 */
export interface DisclosedEffects {
  /** Every hook command the package declares, in declaration order. */
  hooks: DisclosedHook[];
  /** Every scheduled job the install would create, in preview order. */
  schedules: DisclosedSchedule[];
}

/**
 * Total order over schedules, so the binding does not move when `readdir` does.
 *
 * Every field participates, in a fixed order, which makes it a real total order
 * rather than a sort that leaves ties in arbitrary positions: two schedules that
 * compare equal on all four fields are indistinguishable, and swapping them
 * cannot change the hash.
 */
function compareSchedules(a: DisclosedSchedule, b: DisclosedSchedule): number {
  return (
    a.name.localeCompare(b.name) ||
    (a.cron ?? '').localeCompare(b.cron ?? '') ||
    a.permissionMode.localeCompare(b.permissionMode) ||
    Number(a.startsEnabled) - Number(b.startsEnabled)
  );
}

/**
 * Reduce a permission preview to the executable content an approval attests to.
 *
 * Absence is bound as absence: an operation with no preview at all (uninstall,
 * create-package) yields `null` rather than an empty pair of lists, so "nothing
 * was disclosed" can never hash the same as "a package that declares nothing".
 *
 * Hooks keep their declaration order and schedules are sorted; see the module
 * TSDoc for why those differ.
 *
 * @param preview - The preview the person was shown, when there was one.
 * @returns The disclosed executable content, or `null` when nothing was previewed.
 */
export function disclosedEffectsOf(
  preview: PermissionPreview | undefined
): DisclosedEffects | null {
  if (!preview) return null;
  return {
    hooks: preview.hooks.map((hook) => ({
      event: hook.event,
      matcher: hook.matcher ?? null,
      command: hook.command,
    })),
    schedules: preview.schedules
      .map((schedule) => ({
        name: schedule.name,
        cron: schedule.cron ?? null,
        permissionMode: schedule.permissionMode,
        startsEnabled: schedule.startsEnabled,
      }))
      .sort(compareSchedules),
  };
}

/**
 * Whether two disclosures are the same one.
 *
 * Implemented over the SAME canonicalization the approval hash uses
 * ({@link stableStringify}), so this answer and the binding's answer cannot
 * disagree — a comparison written by hand would be a second opinion about what
 * "the same disclosure" means, and the two would drift.
 *
 * @param a - One disclosure, or `null` for "nothing was previewed".
 * @param b - The other.
 * @returns True when an approval for `a` covers `b`.
 */
export function sameDisclosedEffects(
  a: DisclosedEffects | null,
  b: DisclosedEffects | null
): boolean {
  return stableStringify(a ?? null) === stableStringify(b ?? null);
}

/** How many commands a re-ask names before it stops listing them. */
const NAMED_COMMAND_LIMIT = 3;

/** Render the hook half of {@link describeDisclosedEffects}. */
function describeHooks(hooks: DisclosedHook[]): string {
  if (hooks.length === 0) return 'no shell commands';
  const named = hooks
    .slice(0, NAMED_COMMAND_LIMIT)
    .map((hook) => quoteSummaryValue(hook.command))
    .join(', ');
  const rest = hooks.length - NAMED_COMMAND_LIMIT;
  const tail = rest > 0 ? `, and ${rest} more` : '';
  return `${hooks.length === 1 ? '1 shell command' : `${hooks.length} shell commands`} (${named}${tail})`;
}

/** Render the schedule half of {@link describeDisclosedEffects}. */
function describeSchedules(schedules: DisclosedSchedule[]): string {
  if (schedules.length === 0) return 'no scheduled jobs';
  const modes = [...new Set(schedules.map((schedule) => schedule.permissionMode))].join(', ');
  const count = schedules.length === 1 ? '1 scheduled job' : `${schedules.length} scheduled jobs`;
  return `${count} (${modes})`;
}

/**
 * Say, in one plain phrase, what a package declares right now.
 *
 * Used to name what a fresh approval is actually for when a stale one no longer
 * covers it. Every command string goes through `quoteSummaryValue`, which quotes,
 * escapes and caps it — this phrase is handed back to the agent that asked, and a
 * command carrying its own quotes and newlines must not be able to forge the rest
 * of the sentence.
 *
 * @param effects - The disclosed executable content, or `null` when none was previewed.
 * @returns A phrase naming what would run, for a message a person or model reads.
 */
export function describeDisclosedEffects(effects: DisclosedEffects | null): string {
  if (!effects) return 'nothing that runs on its own';
  return `${describeHooks(effects.hooks)} and ${describeSchedules(effects.schedules)}`;
}
