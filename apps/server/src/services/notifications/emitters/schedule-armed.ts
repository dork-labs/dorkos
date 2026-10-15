/**
 * How a schedule one of our agents armed describes itself to the notification
 * pipeline (ADR 261006-225605, spec `trusted-by-default-flip` §5.4).
 *
 * On a Trusted install an agent's schedule runs without waiting for a person.
 * Nothing stands open, so this is an event rather than a standing condition:
 * the person is told once, with the agent's name, the task's name and when it
 * runs, and offered Pause. The name lookup is the same one a parked schedule's
 * card uses, so the two say the same thing about who made it.
 *
 * @module services/notifications/emitters/schedule-armed
 */
import { describeCronSchedule } from '@dorkos/shared/cron';
import type { Task } from '@dorkos/shared/types';
import type { NotificationPayload } from '../notification-registry.js';
import { notify } from '../notification-service.js';
import { withProposerName } from '../../tasks/task-provenance.js';
import { UNNAMED_PROPOSER } from './schedule-park.js';

/**
 * When a schedule runs, as the end of the sentence "Runs …".
 *
 * The plain-language reading where `describeCronSchedule` recognizes the
 * expression, the raw cron otherwise (a person can still read it, and leaving
 * it out would hide when an unattended run happens), and "only when someone
 * starts it" for a schedule with no cron.
 *
 * @param task - The schedule.
 */
export function scheduleCadence(task: Pick<Task, 'cron' | 'timezone'>): string {
  const cron = task.cron?.trim();
  if (!cron) return 'only when someone starts it';
  const described = describeCronSchedule(cron);
  const when = described
    ? described.charAt(0).toLowerCase() + described.slice(1)
    : `on the schedule ${cron}`;
  // A time with no zone reads as the viewer's own hour, which it may not be.
  return task.timezone && task.timezone !== 'UTC' ? `${when} (${task.timezone})` : when;
}

/**
 * Describe a schedule an agent armed, with the agent's name looked up first.
 *
 * @param task - The schedule, as stored after the create.
 */
export async function resolveScheduleArmedPayload(
  task: Task
): Promise<NotificationPayload<'schedule.armed_by_agent'>> {
  const named = await withProposerName(task);
  return {
    taskId: named.id,
    taskName: named.displayName ?? named.name,
    ...(named.agentId ? { agentId: named.agentId } : {}),
    ...(named.proposedBySessionId ? { proposedBySessionId: named.proposedBySessionId } : {}),
    armedBy: named.proposedByName ?? UNNAMED_PROPOSER,
    cadence: scheduleCadence(named),
  };
}

/**
 * Tell the person that one of our agents armed a schedule. Never throws and
 * never makes the create wait on a delivery: the schedule is already live.
 *
 * @param payload - From {@link resolveScheduleArmedPayload}.
 */
export function announceScheduleArmed(
  payload: NotificationPayload<'schedule.armed_by_agent'>
): void {
  void notify('schedule.armed_by_agent', payload);
}
