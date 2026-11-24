import type { TaskRun } from '@dorkos/shared/types';

/** An account as a person reads it: the name it had when the run moved, else its id. */
function nameOf(account: NonNullable<TaskRun['accountMove']>['from']): string {
  return account.label ?? account.id;
}

/**
 * The line a run carries when it started on another account than its own
 * (DOR-5097): which account it ran on and why its own could not take it, or
 * `null` when it ran on its own.
 *
 * @param run - The run to read.
 */
export function runAccountMoveLine(run: TaskRun): string | null {
  const move = run.accountMove;
  if (!move) return null;
  const why = move.reason === 'signed-out' ? 'was signed out' : 'was out of usage';
  return `Ran on ${nameOf(move.to)}: ${nameOf(move.from)} ${why}.`;
}
