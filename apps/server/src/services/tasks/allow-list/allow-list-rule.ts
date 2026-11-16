/**
 * When an agent may change a task's allow list itself, with no card (DOR-4315,
 * Security's ruling: adding is widening). In order:
 *
 * 1. **Removing only narrows.** A list that keeps a subset of the stored one is
 *    always allowed, at any level, from any caller that may edit the task, and
 *    audited like every other change. It is judged only as a subset, so a rule
 *    a person approved on a card can be dropped whatever its shape.
 * 2. **Exact entries only** (`task-allow-list.ts`); one bad entry refuses all.
 * 3. **Only a new one-shot task's first list** is the agent's own call. Every
 *    other addition, from any caller, asks a person: `requestedAllow` puts it on
 *    the task's approval card. {@link addingEntriesAsksAPerson} holds every case.
 * 4. **Don't ask only.** A list is the set of commands a Don't ask run may run
 *    without asking; set beside another mode it would mean nothing or something
 *    wider, so it is refused rather than stored idle.
 * 5. **Claude Code only.** No other runtime carries a list into its run.
 * 6. **No wider than the agent's own level.** An entry runs a command without
 *    asking, so adding one needs a ceiling that already runs any command
 *    without asking (`asks: 'never'`, `reach: 'everything'`).
 *
 * @module services/tasks/allow-list/allow-list-rule
 */
import type { TurnPermissionLevel } from '@dorkos/shared/agent-runtime';
import { allowListChange, judgeTaskAllowList } from './task-allow-list.js';

/** The only mode a list an agent sets may ride. */
export const ALLOW_LIST_MODE = 'dontAsk';
/** The only runtime that carries a list into its run. */
export const ALLOW_LIST_RUNTIME = 'claude-code';

/** Why a list change was refused, for the envelope's `code`. */
export type AllowListRefusalCode =
  | 'allow_list_not_exact'
  | 'allow_list_needs_dont_ask'
  | 'allow_list_runtime'
  | 'allow_list_above_level'
  | 'allow_list_ask_person';

/** What {@link decideAllowList} concluded. */
export type AllowListVerdict =
  | { kind: 'none' }
  | { kind: 'refused'; code: AllowListRefusalCode; message: string }
  | { kind: 'ok'; before: string[]; after: string[]; added: string[]; removed: string[] };

/** Who is adding, as {@link addingEntriesAsksAPerson} reads it. */
export interface AllowListAdder {
  /** The task's own agent, in its own chat, by an identity its home vouches for. */
  ownChatOwnTask: boolean;
  /** The calling turn read words DorkOS can't vouch for. */
  marked: boolean;
  /** The caller is a scheduled run, the narrowed run itself included. */
  scheduledRun: boolean;
}

/** What the decision reads. */
export interface AllowListInput {
  /** The call's body; only `allowList` is read. */
  body: Record<string, unknown>;
  /** The task's `approvedAllow` as stored (empty for a new task). */
  before: readonly string[];
  /** Whether the call creates a one-shot task, the one door a first list rides. */
  createsOneShot: boolean;
  /** Whether the task has ever had a list (its pins keep the first-set time). */
  listEverSet: boolean;
  /** The mode the task will run at once this call lands. */
  mode: string;
  /** The caller's ceiling: the lower of its own level and the task's agent's. */
  ceiling: TurnPermissionLevel;
  /** The runtime the task names, when it names one. */
  runtime: string | null | undefined;
  /** Who is adding. */
  adder: AllowListAdder;
}

/**
 * Whether adding entries needs a person, within the agent's level. Security's
 * ruling, every case here: the first exact list of a new one-shot task is the
 * agent's own call, from its own unmarked chat, about its own task. Any other
 * addition asks: on an existing task, from a scheduled run (the narrowed run
 * itself), from another chat or agent, or from a marked turn. An entry whose
 * arguments changed is a new entry, so editing one is adding.
 *
 * @param change - What the call adds, where, and who adds.
 */
export function addingEntriesAsksAPerson(change: {
  added: readonly string[];
  createsOneShot: boolean;
  listEverSet: boolean;
  adder: AllowListAdder;
}): boolean {
  if (change.added.length === 0) return false;
  const { ownChatOwnTask, marked, scheduledRun } = change.adder;
  return !change.createsOneShot || change.listEverSet || scheduledRun || marked || !ownChatOwnTask;
}

/**
 * A proposed list that only narrows the stored one: what stays, in the stored
 * order, or `null` when the proposal adds anything (or is not a list). Judged
 * only as a subset, so a rule a person approved can be dropped whatever its
 * shape.
 *
 * @param proposed - The call's `allowList`.
 * @param before - The list as stored.
 */
export function narrowingOf(proposed: unknown, before: readonly string[]): string[] | null {
  if (!Array.isArray(proposed) || !proposed.every((rule) => before.includes(rule))) return null;
  return before.filter((rule) => proposed.includes(rule));
}

/**
 * Decide one call's change to a task's allow list.
 *
 * @param input - The call and what it would change.
 */
export function decideAllowList(input: AllowListInput): AllowListVerdict {
  if (!Object.hasOwn(input.body, 'allowList')) return { kind: 'none' };
  const proposed = input.body.allowList;
  const narrowed = narrowingOf(proposed, input.before);
  if (narrowed) {
    const change = allowListChange(input.before, narrowed);
    return { kind: 'ok', before: [...input.before], after: narrowed, ...change };
  }
  const judged = judgeTaskAllowList(proposed);
  if (!judged.ok) {
    const names = judged.refused.map((entry) => `${entry.rule} (${entry.reason})`).join(', ');
    return refused(
      'allow_list_not_exact',
      `Each entry must be one exact command. Not exact: ${names}.`
    );
  }
  const after = judged.rules;
  const { added, removed } = allowListChange(input.before, after);
  if (addingEntriesAsksAPerson({ ...input, added })) {
    return refused(
      'allow_list_ask_person',
      'Only a new one-shot task’s first list is yours to set. To add commands, put them in ' +
        '`requestedAllow` and a person approves them on the task’s card.'
    );
  }
  if (input.mode !== ALLOW_LIST_MODE) {
    return refused(
      'allow_list_needs_dont_ask',
      'A task carries an allow list only at Don’t ask. Set `permissionMode: "dontAsk"`.'
    );
  }
  if (input.runtime && input.runtime !== ALLOW_LIST_RUNTIME) {
    return refused('allow_list_runtime', 'Only Claude Code runs carry a task’s allow list.');
  }
  if (input.ceiling.asks !== 'never' || input.ceiling.reach !== 'everything') {
    return refused(
      'allow_list_above_level',
      'Your own level asks before running commands, so your task can’t run them without asking.'
    );
  }
  return { kind: 'ok', before: [...input.before], after, added, removed };
}

function refused(code: AllowListRefusalCode, message: string): AllowListVerdict {
  return { kind: 'refused', code, message };
}
