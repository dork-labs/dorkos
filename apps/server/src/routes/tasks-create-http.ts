import { TASK_ON_CREDITS } from './task-credits-wording.js';
/**
 * Tasks scheduler routes — CRUD for schedules and runs.
 *
 * File-first architecture: API routes write SKILL.md files to disk,
 * then sync to the DB for immediate consistency. The watcher/reconciler
 * handles external file changes.
 *
 * ## Who the Activity feed says did it
 *
 * Every Activity write here reads the caller (`readActivityActor`) instead of
 * asserting the person did it. This router has bars of its own, but none of them
 * makes the person the only possible caller, so the four hardcoded `user` /
 * `'You'` pairs it carried until DOR-1829 were wrong in practice, not merely
 * stylistically inconsistent:
 *
 * - `POST /` accepts an agent's request and PROPOSES the schedule
 *   (`pending_approval`, clamped) rather than refusing it — {@link clearsTheAgentBar}
 *   returns a boolean the create path branches on, it does not answer the request.
 *   The feed entry was written either way.
 * - `PATCH /:id` refuses only the operator-only FIELDS; an agent pausing a
 *   schedule (`enabled: false`) went through and was recorded as the person.
 * - `DELETE /:id` and `POST /runs/:id/cancel` run
 *   `requireOperatorCookieUnderLogin`, which is a deliberate no-op in the shipped
 *   login-off posture (the documented DOR-505 residual).
 *
 * @module routes/tasks
 */
import { type Context } from 'hono';
import type { CreateTaskInput, Task } from '@dorkos/shared/schemas';
import { createScheduledTask } from '../services/tasks/lifecycle/create-task.js';
import { wifiScheduleRefusal } from './task-wifi-guard.js';
import { readActivityActor } from '../services/activity/activity-actor.js';
import { clearsTheAgentBar } from '../lib/caller-authority.js';
import { errorRefusalUnlessOwner, runAccountWrite } from './cloud-owner-bar.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts, type RequestFacts } from '../http/request-facts.js';
import { operatorOnlyTaskRefusal, namesCredits } from './task-route-answers.js';
import { marksOf } from '../services/core/turn-power/turn-levels.js';
import * as taskApprovalActor from './task-approval-actor.js';
import type { TasksRouterDeps } from './tasks-deps.js';

/** Create a schedule, confirming persistent credits first. */
export async function createTaskHttp(
  c: Context<ApiEnv>,
  deps: TasksRouterDeps,
  present: (task: Task) => Promise<Task>,
  confirming?: RequestFacts
): Promise<Response> {
  const { store, registrar, dorkHome, meshCore, activity: activityService } = deps;
  const caller = confirming ?? honoRequestFacts(c);
  const body = readJsonBody(c);
  const trusted = clearsTheAgentBar(caller);
  const operatorOnly = operatorOnlyTaskRefusal(body, trusted);
  if (operatorOnly) return c.json(operatorOnly, 403);
  // From Wi-Fi a schedule runs at Default at most (DOR-3037).
  const wifiRefusal = wifiScheduleRefusal(caller, body);
  if (wifiRefusal) return c.json(wifiRefusal, 403);
  const creditsRefusal = namesCredits(body)
    ? errorRefusalUnlessOwner(caller, TASK_ON_CREDITS)
    : undefined;
  if (creditsRefusal) return c.json(creditsRefusal, 403);
  if (namesCredits(body) && !confirming) {
    return runAccountWrite(c, {
      kind: 'cloud.credits',
      target: 'scheduled-task-create',
      input: body,
      reason: 'Run this scheduled task on DorkOS credits.',
      run: (verified) => createTaskHttp(c, deps, present, verified),
    });
  }

  // Everything from "is this a valid request" to "the cron job is running" lives
  // in `createScheduledTask`, because `tasks_create` on both MCP servers has to
  // do the identical thing and used to do a shorter, wrong version of it — a row
  // with no SKILL.md behind it (DOR-1568). What is left here is what is genuinely
  // this door's: who is asking, what the activity feed is told, and the response.
  // Read from the RESOLVED credential, never from the body: the caller's
  // agent identity is set only for a caller that presented a live agent
  // token. That is what makes the caller one of our agents, whose schedule a
  // Trusted install arms at once; an unidentified caller's parks.
  // A revoked or expired token names nobody here (DOR-3666): its schedule parks,
  // credited to no agent, as on update (`scheduleEditorOf`).
  const agentIdentity = caller.agentIdentity?.inactive ? undefined : caller.agentIdentity;
  const outcome = await createScheduledTask(
    {
      store,
      registrar,
      dorkHome,
      defaultTimezone: deps.defaultTimezone,
      ...(meshCore && { meshCore }),
    },
    {
      input: body as CreateTaskInput,
      trusted,
      ...(trusted && { createdBy: taskApprovalActor.personTaskApprover(caller) }),
      callerIsOurAgent: agentIdentity != null,
      // An agent's HTTP call names no chat, so its turn is read through its
      // agent: the marks of any marked turn of it running now (DOR-3036).
      ...(agentIdentity ? { originMarks: marksOf(undefined, agentIdentity.agentPath) } : {}),
      // An unidentified caller leaves this null, and the approval card
      // honestly says it does not know who asked.
      proposal: { agentPath: agentIdentity?.agentPath ?? null },
    }
  );

  if (!outcome.ok) {
    return c.json(
      {
        error: outcome.error,
        ...(outcome.code !== undefined && { code: outcome.code }),
        ...(outcome.ownedBy !== undefined && { ownedBy: outcome.ownedBy }),
        ...(outcome.details !== undefined && { details: outcome.details }),
      },
      outcome.status
    );
  }
  const schedule = outcome.task;

  activityService?.emit({
    // An untrusted caller reaches here too — its schedule is parked and clamped,
    // not refused — so the proposer is named rather than assumed (DOR-1829).
    ...readActivityActor(caller),
    category: 'tasks',
    // An agent's schedule armed without asking is recorded as exactly that,
    // so the audit trail can answer "what did my agents set running?".
    eventType: outcome.armedPayload ? 'schedule.armed_by_agent' : 'tasks.task_created',
    resourceType: 'schedule',
    resourceId: schedule.id,
    resourceLabel: schedule.displayName ?? schedule.name,
    summary: outcome.armedPayload
      ? `Scheduled task ${schedule.displayName ?? schedule.name}, which runs ${outcome.armedPayload.cadence}`
      : `Created scheduled task ${schedule.displayName ?? schedule.name}`,
    linkPath: '/',
  });

  // Run times and the proposer's name are derived, not persisted on the row,
  // so they must be attached here the same way the list endpoint does —
  // otherwise a freshly created task reports none of them until the next list
  // fetch.
  return c.json(await present(schedule), 201);
}
