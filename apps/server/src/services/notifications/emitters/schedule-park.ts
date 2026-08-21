/**
 * How a parked schedule describes itself to the notification pipeline.
 *
 * One builder, because four places need the same payload and three of them are
 * different edges of the same condition: the REST route parks a schedule, the
 * `tasks_create` MCP tool parks one, both then decide it (approve or reject),
 * and boot re-arms the ones still waiting. The `taskId` inside is what the
 * escalation ladder and the dedupe key are both built from, so two copies that
 * disagreed by a character would leave a phone ping nothing could disarm.
 *
 * @module services/notifications/emitters/schedule-park
 */
import type { Task } from '@dorkos/shared/types';
import type { NotificationPayload } from '../notification-registry.js';
import { resolveStanding } from '../notification-service.js';
import { withProposerName } from '../../tasks/task-provenance.js';

/**
 * What a parked schedule is called when nothing resolves a proposer.
 *
 * Every "we do not know" case lands here alike: a schedule an operator's own
 * unauthenticated request parked, one proposed through the sessionless external
 * `/mcp` server, or one whose agent has since been renamed away or revoked. All
 * that is honestly known then is that a person did not do it.
 */
export const UNNAMED_PROPOSER = 'An agent';

/**
 * Describe a parked schedule, from what the task already carries.
 *
 * Deliberately not exported: naming the proposer takes a database read, and a
 * caller that reached this directly would silently get "An agent" for a schedule
 * whose agent is perfectly well known. {@link resolveScheduleParkPayload} is the
 * only door, so that cannot happen by omission.
 *
 * @param task - The schedule that is (or was) waiting.
 */
function scheduleParkPayload(task: Task): NotificationPayload<'schedule.parked'> {
  return {
    taskId: task.id,
    taskName: task.displayName ?? task.name,
    ...(task.agentId ? { agentId: task.agentId } : {}),
    ...(task.proposedBySessionId ? { proposedBySessionId: task.proposedBySessionId } : {}),
    proposedBy: task.proposedByName ?? UNNAMED_PROPOSER,
  };
}

/**
 * The same payload, with the proposer's name looked up first.
 *
 * Use this wherever the caller is already async — which every edge that arms or
 * resolves this condition is — so a person is told WHICH agent wants to run
 * something on their machine rather than that some agent does. The lookup
 * degrades to {@link UNNAMED_PROPOSER} and never throws.
 *
 * Nothing keyed on the payload changes: the dedupe key is the task id, so a
 * condition armed before a name resolved and resolved after it did are still
 * the same condition to the escalation ladder.
 *
 * @param task - The schedule that is (or was) waiting.
 */
export async function resolveScheduleParkPayload(
  task: Task
): Promise<NotificationPayload<'schedule.parked'>> {
  return scheduleParkPayload(await withProposerName(task));
}

/**
 * End a parked schedule's standing condition because the schedule went AWAY,
 * rather than because anybody decided it.
 *
 * **Every path that removes a schedule has to call this, and three of them were
 * not** (DOR-1387 review): the `tasks_delete` MCP tool, the reconciler retiring
 * a schedule whose file is gone, and a Shape tearing its schedules down. The
 * cockpit's own Reject button resolves correctly, so the leak was invisible from
 * the UI — but a schedule removed by any other route left its escalation timer
 * armed, and a phone then buzzed about a schedule that no longer exists.
 *
 * A no-op for a schedule that was not waiting on anybody, which is the common
 * case: deleting an ordinary active task is not a decision about an approval.
 *
 * **The outcome is `cancelled`, not `rejected`.** `rejected` is a person saying
 * no — it is what the cockpit's Reject button records, and the pipeline files it
 * already-read because the operator was there. None of these three paths is the
 * operator deciding anything: an agent deleted it, a file vanished, a Shape was
 * torn down. `cancelled` is the vocabulary's own word for "the thing that was
 * waiting went away", and it leaves the row UNREAD, so a pending approval that
 * disappeared out from under somebody is something they find rather than
 * something they are quietly told they did.
 *
 * @param task - The schedule being removed, or nothing when the caller had no row.
 */
export function resolveParkedScheduleRemoved(task: Task | null | undefined): void {
  if (!task || task.status !== 'pending_approval') return;
  // Already fire-and-forget before the name lookup joined it, and deliberately
  // still is: the callers are removals (a delete, a reconciler sweep, a Shape
  // teardown), and none of them may be made to wait on — or fail because of —
  // the row that records what happened to the approval.
  void resolveScheduleParkPayload(task).then((payload) =>
    resolveStanding('schedule.parked', payload, { outcome: 'cancelled' })
  );
}
