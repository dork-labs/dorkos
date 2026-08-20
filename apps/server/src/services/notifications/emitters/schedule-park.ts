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
