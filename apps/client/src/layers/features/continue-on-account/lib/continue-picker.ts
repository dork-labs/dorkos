/**
 * The "Continue on another account" picker's display rules (spec
 * `claude-account-ui` §6.6). Pure: every function here turns the server's
 * answer into words or groups, and none of them decides anything the server
 * decides (invariant 6). Order, eligibility and the recommended account all
 * arrive in `GET /api/sessions/:id/continue-options`; nothing here reorders it.
 *
 * @module features/continue-on-account/lib/continue-picker
 */
import {
  IMPLICIT_ACCOUNT_ID,
  type ContinueOptionAccount,
  type ContinueOptionsResponse,
} from '@dorkos/shared/account-usage';
import { accountWindow, formatResetDay, limitSubject } from '@/layers/shared/lib';

/** The server's list of candidate accounts, in its order. */
export type ContinueOptionsList = ContinueOptionsResponse['ranking'];

/**
 * Whether a person may pick a row (decided, Q2). An account that is out is
 * disabled, since nothing can run there. Any other row stays selectable even
 * when the server marks it not eligible (flow's reserved Main): the server
 * never refuses a person's own pick, so the picker does not either.
 *
 * @param row - One account from the server's list.
 */
export function isSelectable(row: ContinueOptionAccount): boolean {
  return row.usage.state !== 'limited';
}

/**
 * What a row says on its right: for an eligible account, how much of its week
 * is left and when it resets ("28% left · resets Sun"), or "usage unknown"
 * with no weekly reading; for any other account, the server's own reason,
 * word for word.
 *
 * @param row - One account from the server's list.
 * @param now - The moment reset days are read from.
 */
export function rowStatusText(row: ContinueOptionAccount, now: Date): string {
  if (!row.eligible) return row.reason;
  const week = accountWindow(row.usage, 'seven_day');
  if (!week || week.usedPct === null) return 'usage unknown';
  const left = Math.min(100, Math.max(0, Math.round(100 - week.usedPct)));
  const resets = formatResetDay(week.resetsAt, now);
  return resets ? `${left}% left · resets ${resets}` : `${left}% left`;
}

/**
 * Whether a row belongs to another runtime than the session's. A row without
 * `runtime` is the session's own runtime (older servers leave it out).
 *
 * @param row - One account from the server's list.
 * @param sessionRuntime - The limited session's runtime.
 */
export function isOtherRuntime(row: ContinueOptionAccount, sessionRuntime: string): boolean {
  return row.runtime !== undefined && row.runtime !== sessionRuntime;
}

/**
 * The server's rows split into the session's own runtime and "Other
 * runtimes", each keeping the server's order.
 *
 * @param rows - The server's rows, in its order.
 * @param sessionRuntime - The limited session's runtime.
 */
export function splitByRuntime(
  rows: readonly ContinueOptionAccount[],
  sessionRuntime: string
): { same: ContinueOptionAccount[]; other: ContinueOptionAccount[] } {
  const same: ContinueOptionAccount[] = [];
  const other: ContinueOptionAccount[] = [];
  for (const row of rows) (isOtherRuntime(row, sessionRuntime) ? other : same).push(row);
  return { same, other };
}

/**
 * A row's radio value: its runtime and id together, since two runtimes may
 * each have an account with the same id (`default`).
 *
 * @param row - One account from the server's list.
 * @param sessionRuntime - The limited session's runtime, for a row without one.
 */
export function choiceKey(row: ContinueOptionAccount, sessionRuntime: string): string {
  return `${row.runtime ?? sessionRuntime}:${row.id}`;
}

/**
 * What a row is called. On the session's own runtime: the server's label,
 * else (for this computer's own sign-in) the host's label on its reading, else
 * the name the rest of the app uses for that folder (`useClaudeAccounts().nameFor`,
 * which names the standalone default "Main (this computer's sign-in)" too). On another runtime,
 * by `limitSubject`'s rules: its label, else the runtime's name, with an
 * implicit account reading "Codex (this computer's sign-in)".
 *
 * @param row - One account from the server's list.
 * @param sessionRuntime - The limited session's runtime.
 * @param nameForPath - The app's name for an account folder on the session's runtime.
 */
export function rowName(
  row: ContinueOptionAccount,
  sessionRuntime: string,
  nameForPath: (path: string) => string
): string {
  if (isOtherRuntime(row, sessionRuntime)) {
    const runtime = row.runtime!;
    if (!row.label && row.id === IMPLICIT_ACCOUNT_ID) {
      const subject = limitSubject({ runtime, accountLabel: null, identityGate: false });
      return `${subject} (this computer's sign-in)`;
    }
    // A row the server lists is one the person tells apart by name, so its label wins.
    return limitSubject({ runtime, accountLabel: row.label, identityGate: true });
  }
  if (row.label) return row.label;
  // This computer's own sign-in reads the host's label, never its folder
  // (decision §12): the reading carries it when the row does not.
  if (row.id === IMPLICIT_ACCOUNT_ID && row.usage.label) return row.usage.label;
  return row.usage.path ? nameForPath(row.usage.path) : row.id;
}

/**
 * The row selected when the picker opens: the server's `recommendedId` when
 * that row can be picked, else the first row that can. `null` when none can.
 *
 * @param list - The server's list.
 * @param sessionRuntime - The limited session's runtime.
 */
export function initialChoice(list: ContinueOptionsList, sessionRuntime: string): string | null {
  const recommended = list.accounts.find((row) => row.id === list.recommendedId);
  if (recommended && isSelectable(recommended)) return choiceKey(recommended, sessionRuntime);
  const first = list.accounts.find(isSelectable);
  return first ? choiceKey(first, sessionRuntime) : null;
}

/**
 * The muted line naming accounts the server left out ("Client is kept out, so
 * it isn't listed."), or `null` when it left none out.
 *
 * @param names - The names of the accounts left out, in registry order.
 */
export function keptOutLine(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return `${names[0]} is kept out, so it isn't listed.`;
  const joined = `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${joined} are kept out, so they aren't listed.`;
}

/** The subtitle and carry-over list the picker shows. */
export interface CarryOverCopy {
  /** The sentence under the title. */
  subtitle: string;
  /** What moves with the work. */
  carries: string;
  /** What does not. */
  doesnt: string;
}

/**
 * The picker's subtitle and carry-over list (mockup v2). A flow run (an
 * advisor answered and the session serves a tracker item) picks up from
 * flow's checkpoint; anything else starts a new chat with a summary. "Sorted
 * by most usage left." is dropped whenever an advisor answered, since its
 * order is its own.
 *
 * @param advised - Whether an advisor answered the list.
 * @param hasTrackerItem - Whether the session serves a tracker item.
 */
export function carryOverCopy(advised: boolean, hasTrackerItem: boolean): CarryOverCopy {
  if (advised && hasTrackerItem) {
    return {
      subtitle: "Picks up in the same folder and branch from flow's checkpoint.",
      carries: 'Carries over: files, branch, checkpoint, task',
      doesnt: "Doesn't: the chat itself",
    };
  }
  const base = 'Starts a new chat in the same folder, with a summary of this one.';
  return {
    subtitle: advised ? base : `${base} Sorted by most usage left.`,
    carries: 'Carries over: the folder and a summary of this chat',
    doesnt: "Doesn't: the chat itself",
  };
}

/**
 * Whether the session can only wait: its plan says the work cannot be carried
 * over (it did not start here, or its runtime cannot move accounts yet).
 *
 * @param plan - The limit's plan, from the server's answer.
 */
export function isWaitOnly(plan: ContinueOptionsResponse['plan']): boolean {
  return (plan as { carryOver?: boolean }).carryOver === false;
}

/**
 * Whether the picker may open for a session: when accounts are told apart on
 * its runtime (the identity gate), or when the server offers another
 * runtime's accounts (spec §7.3 N3).
 *
 * @param identityGate - `useAccountIdentityGate` for the session's runtime.
 * @param list - The server's list, or nothing before it loads.
 * @param sessionRuntime - The limited session's runtime.
 */
export function canOpenPicker(
  identityGate: boolean,
  list: ContinueOptionsList | null | undefined,
  sessionRuntime: string
): boolean {
  if (identityGate) return true;
  return list?.accounts.some((row) => isOtherRuntime(row, sessionRuntime)) ?? false;
}
