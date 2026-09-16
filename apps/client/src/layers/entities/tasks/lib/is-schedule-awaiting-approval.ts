/**
 * Whether a scheduled task is genuinely waiting on a person, as opposed to
 * merely carrying `pending_approval` on its row.
 *
 * A package can ship a schedule switched off (`schedule.enabled: false`),
 * documented as opt-in. Discovery still parks it at `pending_approval` — the
 * arm gate cannot skip that, because a package can change its mind about what
 * the schedule does before anyone approves it — but a schedule that is not
 * even asking to run has nothing for a person to decide about *right now*
 * (DOR-2059). So the row stays `pending_approval` and the security invariant
 * that gate protects is untouched — a person still has to move it to
 * `active`, `status` is still operator-only, and an agent flipping `enabled`
 * cannot arm it — while the surfaces that ask for the operator's ATTENTION
 * (the approval card, the OS-level knock, the escalation ladder) stop
 * treating it as one more thing in the way.
 *
 * A package that ships a schedule switched ON (`schedule.enabled: true`) is
 * asking to run, and keeps today's card.
 *
 * @param task - The fields of a task this decision reads.
 * @returns True when a person still has to look at this schedule.
 */
export function isScheduleAwaitingApproval(task: { status: string; enabled: boolean }): boolean {
  return task.status === 'pending_approval' && task.enabled;
}
