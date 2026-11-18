/**
 * Which edits to a scheduled task on DorkOS credits make it spend more, so a
 * person says yes first (DOR-4355 on the route, DOR-4609 on `tasks_update`).
 *
 * The prompt, the schedule, the time limit and what it runs on are the work a
 * person approved to spend on. Lowering the limit, switching the task off or
 * moving it off credits only narrows, and stays free.
 *
 * @module services/tasks/credits/credits-work
 */
import { CREDITS_ACCOUNT_ID } from '@dorkos/shared/account-usage';
import type { Task } from '@dorkos/shared/types';
import { parseDuration } from '@dorkos/skills/duration';
import { changesApprovedWork } from '../task-file-update.js';
import { chatReadOutsideWords } from '../../core/turn-power/chat-outside-words.js';
import { escalatedGrantFor } from '../../core/capabilities/tool-call-escalation.js';

/** The fields of an edit these checks read: a route's body or a tool call's arguments. */
export type CreditsEdit = Parameters<typeof changesApprovedWork>[0] & {
  resetTiming?: boolean;
  enabled?: boolean;
};

/**
 * Whether `data` changes the credits work: anything a person approved but a
 * lower time limit.
 *
 * @param data - The edit.
 * @param existing - The task as it stands.
 */
export function changesCreditsWork(data: CreditsEdit, existing: Task): boolean {
  if (data.resetTiming) return true;
  const { maxRuntime, ...work } = data;
  if (changesApprovedWork(work, existing)) return true;
  if (maxRuntime === undefined) return false;
  // A null (or zero-duration) limit removes the cap rather than lowering it.
  const next = maxRuntime === null ? Infinity : parseDuration(maxRuntime) || Infinity;
  return next > (existing.maxRuntime || Infinity);
}

/**
 * Whether an agent's `tasks_update` changes the work a task on credits spends
 * on, so it waits for a person's yes on a card (DOR-4609). Switching the task
 * off doesn't excuse a new prompt beside it, and nor does a task that is
 * already off: the person's later switch-on would put that work live on
 * credits unseen (Security S2 on DOR-4355 M3). A call that only switches it
 * off changes no work, so it stays free. A task waiting for approval spends
 * nothing until a person approves what it now says.
 *
 * @param data - The tool call's fields.
 * @param existing - The task as it stands.
 */
export function agentEditRaisesCredits(data: CreditsEdit, existing: Task): boolean {
  const account = data.account !== undefined ? data.account : existing.account;
  if (account !== CREDITS_ACCOUNT_ID) return false;
  if (existing.status === 'pending_approval') return false;
  return changesCreditsWork(data, existing);
}

/**
 * Whether the asking turn read words from outside the team, so a credits raise
 * gets no card and is refused: the outsider mark, a room turn or a chat started
 * from a chat app that read such words (`chatReadOutsideWords`), or a caller
 * DorkOS cannot name, which `marked` already counts (Security S1 on DOR-4355 M3).
 *
 * @param caller - The caller as the gate or the tool resolved it.
 */
export function readOutside(caller: {
  marked: boolean;
  sessionId?: string;
  agentPath?: string;
}): boolean {
  return caller.marked || chatReadOutsideWords(caller.sessionId, caller.agentPath);
}

/** The longest prompt the credits sheet quotes before it cuts the rest. */
const PROMPT_NOTE_MAX = 280;
/** What a cut quote ends with, so nobody reads part of a prompt as all of it. */
const SHORTENED = '… (shortened)';

/**
 * A task's prompt as one quiet line on the sheet that puts it on credits: on
 * one line, at most {@link PROMPT_NOTE_MAX} characters, saying so when it cuts.
 *
 * @param prompt - The prompt it will run with.
 */
export function creditsPromptNote(prompt: string): string {
  const line = prompt.replace(/\s+/gu, ' ').trim();
  if (line.length <= PROMPT_NOTE_MAX) return line;
  return `${line.slice(0, PROMPT_NOTE_MAX - SHORTENED.length).trimEnd()}${SHORTENED}`;
}

/** The tool's answer when a credits raise reached it without a person's yes. */
export const CREDITS_EDIT_NEEDS_YES = {
  error: 'DorkOS changed nothing. This task runs on DorkOS credits, so a person says yes first.',
  code: 'credits_edit_needs_yes',
  message:
    'Changing what a scheduled task on DorkOS credits does, when it runs or how long it may run ' +
    'spends the owner’s money. Ask again from a chat a person can answer, or ask them to make it.',
} as const;

/**
 * The refusal an agent's `tasks_update` gets when it would make a live credits
 * task spend more without a person's yes on the card (DOR-4609): a marked turn
 * gets no card, and a call no card escalated has no yes. `null` lets it go on.
 * Asked in the order the tool asked it: the raise, the mark, then the card.
 *
 * @param data - The tool call's fields.
 * @param existing - The task as it stands.
 * @param caller - The caller as the tool resolved it.
 */
export function agentCreditsRaiseRefusal(
  data: CreditsEdit,
  existing: Task,
  caller: Parameters<typeof readOutside>[0]
): typeof CREDITS_EDIT_NEEDS_YES | null {
  return agentEditRaisesCredits(data, existing) &&
    (readOutside(caller) || escalatedGrantFor(data)?.via !== 'card')
    ? CREDITS_EDIT_NEEDS_YES
    : null;
}
