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
 * **Keyed on `origin`, not on `enabled`, and that is load-bearing.** `enabled`
 * is agent-writable (`task-write-policy.ts`) by design — flipping it on an
 * already-APPROVED schedule is a reversible nuisance, not an escalation. But
 * the first cut of this fix read `enabled` alone, which let an agent hide its
 * OWN proposal: `tasks_create` parks a schedule and raises the standing
 * condition with `enabled: true`, and a follow-up `tasks_update({enabled:
 * false})` — an ordinary agent-writable field, `status` untouched — made the
 * card, the reason line, the filter, and every consumer of
 * `usePendingScheduleApprovals` vanish at once, with the escalation ladder
 * still armed and nothing on screen explaining why (adversarial review,
 * DOR-2059). `origin` is `'file'` ONLY for a row `upsertFromFile` wrote with
 * `source: 'discovery'` (`task-store.ts`) — never for a row `tasks_create` or
 * `POST /api/tasks` made — and no update path ever sets it. An agent cannot
 * manufacture the one condition that quiets a schedule, whatever it does to
 * `enabled`.
 *
 * A package that ships a schedule switched ON (`schedule.enabled: true`) is
 * asking to run, and keeps today's card even though its origin is `'file'`.
 *
 * @param task - The fields of a task this decision reads.
 * @returns True when a person still has to look at this schedule.
 */
export function isScheduleAwaitingApproval(task: {
  status: string;
  enabled: boolean;
  origin: string | null;
}): boolean {
  return task.status === 'pending_approval' && (task.origin !== 'file' || task.enabled);
}
