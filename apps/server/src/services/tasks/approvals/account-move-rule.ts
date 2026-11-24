/**
 * Whether a change to a schedule's approved work moved only its account
 * (DOR-5097). Kept apart from the store so the approval rules and their tests
 * read one definition.
 *
 * @module services/tasks/approvals/account-move-rule
 */
import { scheduleContentKey, type IncomingTaskContent } from '../schedule-permission-clamp.js';

/**
 * Whether `after` is `before` with another account and nothing else changed:
 * the same prompt, timing, name, runtime, model, effort, run limit and
 * conversation setting.
 *
 * @param before - What would have run before the change.
 * @param after - What would run now.
 */
export function movesOnlyAccount(before: IncomingTaskContent, after: IncomingTaskContent): boolean {
  if ((before.account ?? null) === (after.account ?? null)) return false;
  return scheduleContentKey({ ...before, account: after.account }) === scheduleContentKey(after);
}
