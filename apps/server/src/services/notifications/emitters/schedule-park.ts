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

/**
 * Describe a parked schedule.
 *
 * `proposedBy` says "An agent" rather than naming one: a schedule parks because
 * its creator did not clear the agent bar, and the row records the fact rather
 * than an identity nothing on this path resolved.
 *
 * @param task - The schedule that is (or was) waiting.
 */
export function scheduleParkPayload(task: Task): NotificationPayload<'schedule.parked'> {
  return {
    taskId: task.id,
    taskName: task.displayName ?? task.name,
    ...(task.agentId ? { agentId: task.agentId } : {}),
    proposedBy: 'An agent',
  };
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
  void resolveStanding('schedule.parked', scheduleParkPayload(task), { outcome: 'cancelled' });
}
