import { TASK_ON_CREDITS } from './task-credits-wording.js';
import * as personReview from '../services/tasks/approvals/person-review.js';
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
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ListTaskRunsQuerySchema, TriggerTaskRequestSchema } from '@dorkos/shared/schemas';
import type { Task } from '@dorkos/shared/schemas';
import { wifiRunNowRefusal } from './task-wifi-guard.js';
import {
  trialRunMode,
  TRIAL_TOO_LOOSE_REFUSAL,
  TRIAL_UNKNOWN_MODE_REFUSAL,
} from './task-trial-mode.js';
import {
  deleteOrDeclineTask,
  PROJECT_COPY_DELETE_REFUSAL,
} from '../services/tasks/lifecycle/delete-task.js';
import { readActivityActor } from '../services/activity/activity-actor.js';
import { loadTemplates } from '../services/tasks/task-templates.js';
import { validationFailureBody } from '../lib/route-utils.js';
import { broadcastTasksChanged } from '../services/tasks/task-sse-events.js';
import { clearsTheAgentBar, requireOperatorCookieUnderLogin } from '../lib/caller-authority.js';
import { CREDITS_ACCOUNT_ID } from '@dorkos/shared/account-usage';
import { errorRefusalUnlessOwner } from './cloud-owner-bar.js';
import { readCallerPrincipal } from '../lib/caller-principal.js';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { readQuery } from '../http/request-query.js';
import { readJsonBody } from '../http/request-body.js';
import { resolveStanding } from '../services/notifications/notification-service.js';
import { resolveScheduleParkPayload } from '../services/notifications/emitters/schedule-park.js';
import { withTaskFolderRules } from './task-approval-rules.js';
import { withTaskRunPlace } from '../services/tasks/execution/run-place-preview.js';
import { withProposerNames } from '../services/tasks/task-provenance.js';
import {
  withTaskProjects,
  withTaskRunTimes,
} from '../services/tasks/approvals/task-presentation.js';
import {
  OPERATOR_ONLY_TASK_CODE,
  OPERATOR_ONLY_TASK_ERROR,
  OPERATOR_ONLY_TRIGGER_REFUSAL,
} from '../services/tasks/task-write-policy.js';
import { mountTaskModeUndo } from './task-mode-undo.js';
import type { TasksRouterDeps } from './tasks-deps.js';
import { createTaskHttp } from './tasks-create-http.js';
import { updateTaskHttp } from './tasks-update-http.js';

export type { TasksRouterDeps } from './tasks-deps.js';

/**
 * Create the Tasks routes with schedule and run management endpoints.
 *
 * @param deps - See {@link TasksRouterDeps}.
 * @returns The routes, to mount at `/api/tasks`.
 */
export function createTasksRoutes(deps: TasksRouterDeps): Hono<ApiEnv> {
  const { store, scheduler, registrar, dorkHome, meshCore, activity: activityService } = deps;
  const router = new Hono<ApiEnv>();

  /** One task, ready to send: run times attached, its proposer named, its project stamped. */
  async function present(task: Task): Promise<Task> {
    const [presented] = await presentAll([task]);
    return presented as Task;
  }

  /**
   * {@link present} for a whole list, with one identity lookup per distinct
   * agent, and when each task last ran (one query for all of them, DOR-2914).
   */
  async function presentAll(tasks: Task[]): Promise<Task[]> {
    // When each last ran, and whether its last finished run did its job.
    const history = store.runHistory();
    const named = await withProposerNames(tasks);
    return withTaskProjects(
      meshCore,
      named.map((task) => ({
        ...withTaskRunTimes(scheduler, task),
        ...history(task.id),
        approvalRevision: personReview.taskReviewRevision(task),
      }))
    );
  }

  // === Template endpoints ===

  router.get('/templates', async (c) => {
    const templates = await loadTemplates(dorkHome);
    return c.json(templates);
  });

  // === Schedule endpoints ===

  router.get('/', async (c) => {
    const tasks = await presentAll(store.getTasks());
    return c.json(
      clearsTheAgentBar(honoRequestFacts(c))
        ? await Promise.all(
            tasks.map(async (task) =>
              withTaskRunPlace(await withTaskFolderRules(task, meshCore), meshCore)
            )
          )
        : tasks
    );
  });

  router.post('/', (c) => createTaskHttp(c, deps, present));

  router.patch('/:id', (c) => updateTaskHttp(c, deps, present));

  router.delete('/:id', async (c) => {
    const caller = honoRequestFacts(c);
    // Deleting a schedule is never a power-grant, so this is nuisance/DoS
    // protection, not the operator bar the create/update path runs: under
    // login-on a caller holding a per-user API key but no session cookie must
    // not be able to remove a person's schedule on their behalf. Asked first,
    // before the 404 below, so a barred caller cannot even probe which schedules
    // exist. Under the default login-off posture this is a no-op — the accepted
    // DOR-505 residual, where a credential-free loopback request is
    // indistinguishable from the app — exactly as it is everywhere
    // `requireOperatorCookieUnderLogin` runs.
    const cookieRefusal = requireOperatorCookieUnderLogin(caller, 'delete a scheduled task');
    if (cookieRefusal) {
      return c.json(
        {
          error: 'Only a person signed in to DorkOS can delete a scheduled task',
          code: cookieRefusal.code,
        },
        cookieRefusal.status as ContentfulStatusCode
      );
    }

    const id = c.req.param('id');
    const schedule = store.getTask(id);
    if (!schedule) {
      return c.json({ error: 'Scheduled task not found' }, 404);
    }
    // One project's copy shares its file with every other project's (DOR-3376).
    if (schedule.projectOnly) {
      return c.json({ error: PROJECT_COPY_DELETE_REFUSAL, code: 'schedule_project_copy' }, 409);
    }

    const declined = (await deleteOrDeclineTask(schedule, store, meshCore)) === 'declined';

    // Row first, then the seam: with no row to read, or a row no longer active,
    // `syncTask` unregisters — the same answer the direct call gave.
    registrar.syncTask(id);

    activityService?.emit({
      // The cookie bar above allows everything in the shipped login-off posture,
      // so this is not always the person.
      ...readActivityActor(caller),
      category: 'tasks',
      eventType: declined ? 'tasks.task_declined' : 'tasks.task_deleted',
      resourceType: 'schedule',
      resourceId: id,
      resourceLabel: schedule.displayName ?? schedule.name,
      summary: `${declined ? 'Declined' : 'Deleted'} scheduled task ${schedule.displayName ?? schedule.name}`,
    });

    // Rejecting a proposed schedule is deleting it — the app's Reject button
    // is this endpoint. Only a schedule that was actually waiting counts: a
    // person tidying up a task they never had to approve is not a rejection.
    if (schedule.status === 'pending_approval') {
      const actorPrincipal = readCallerPrincipal(caller);
      void resolveScheduleParkPayload(schedule).then((payload) =>
        resolveStanding('schedule.parked', payload, { outcome: 'rejected', actorPrincipal })
      );
    }

    broadcastTasksChanged();

    return c.json({ success: true });
  });

  router.post('/:id/trigger', async (c) => {
    const caller = honoRequestFacts(c);
    const id = c.req.param('id');
    // The door that skips every other door (DOR-1481). This was the only write
    // endpoint on the router that asked nothing at all, and it undid the
    // approval the other two exist to protect: an agent creates a schedule,
    // `POST /` correctly parks it at `pending_approval` so a person can read
    // what it proposes, and then the same agent POSTs here with the same
    // identity header and the unapproved prompt runs immediately, at whatever
    // power the schedule carries. Parking is only worth something if it cannot
    // be walked around.
    //
    // So: the same bar, asked the same way. It is about WHO is asking and never
    // about the schedule's state — a person may still run a `pending_approval`
    // schedule once before deciding on it, which is the "Run it once" button on
    // the approval card and the only way to find out what a proposal actually
    // does short of approving it
    // (`services/tasks/__tests__/trigger-pending-schedule.test.ts`).
    if (!clearsTheAgentBar(caller)) {
      return c.json(
        {
          error: OPERATOR_ONLY_TASK_ERROR,
          code: OPERATOR_ONLY_TASK_CODE,
          // Empty on purpose, and present on purpose: the other two refusal sites
          // on this router always send `fields`, so a caller that reads it should
          // not have to handle the key being missing here. Nothing was refused
          // FIELD-by-field — the whole action was — and an empty list says that.
          fields: [],
          message: OPERATOR_ONLY_TRIGGER_REFUSAL,
        },
        403
      );
    }

    const wifiRefusal = wifiRunNowRefusal(caller, store.getTask(id) ?? undefined);
    if (wifiRefusal) return c.json(wifiRefusal, 403);
    const creditsRefusal =
      store.getTask(id)?.account === CREDITS_ACCOUNT_ID
        ? errorRefusalUnlessOwner(caller, TASK_ON_CREDITS)
        : undefined;
    if (creditsRefusal) return c.json(creditsRefusal, 403);

    // A trial of a pending schedule is never looser than one click could approve, and runs at
    // the mode the person picked when that is stricter still (DOR-4336).
    const body = TriggerTaskRequestSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!body.success) return c.json(validationFailureBody(body.error), 400);
    const trial = await trialRunMode(store.getTask(id), body.data.permissionMode, meshCore);
    if (trial.kind === 'refused') return c.json(TRIAL_TOO_LOOSE_REFUSAL, 409);
    if (trial.kind === 'unknown_mode') return c.json(TRIAL_UNKNOWN_MODE_REFUSAL, 400);
    const run =
      trial.kind === 'tightened'
        ? await scheduler.triggerManualRun(id, trial.permissionMode)
        : await scheduler.triggerManualRun(id);
    if (!run) {
      return c.json({ error: 'Scheduled task not found' }, 404);
    }
    return c.json({ runId: run.id }, 201);
  });

  // === Run endpoints ===

  router.get('/runs', (c) => {
    const parsed = ListTaskRunsQuerySchema.safeParse(readQuery(c));
    if (!parsed.success) return c.json(validationFailureBody(parsed.error), 400);
    const data = parsed.data;

    const runs = store.listRuns({
      taskId: data.scheduleId,
      status: data.status,
      limit: data.limit,
      offset: data.offset,
    });
    return c.json(runs);
  });

  router.get('/runs/:id', (c) => {
    const run = store.getRun(c.req.param('id'));
    if (!run) {
      return c.json({ error: 'Run not found' }, 404);
    }
    return c.json(run);
  });

  router.post('/runs/:id/cancel', async (c) => {
    const caller = honoRequestFacts(c);
    const id = c.req.param('id');
    // Cancelling a run is never a power-grant either, so — like DELETE above —
    // this is nuisance/DoS protection: under login-on a caller with an API key
    // but no session cookie must not be able to stop a person's run for them.
    // Asked before the run is looked up. A no-op under login-off (the DOR-505
    // residual), so the shipped default posture is unchanged.
    const cookieRefusal = requireOperatorCookieUnderLogin(caller, 'cancel a scheduled run');
    if (cookieRefusal) {
      return c.json(
        {
          error: 'Only a person signed in to DorkOS can cancel a scheduled run',
          code: cookieRefusal.code,
        },
        cookieRefusal.status as ContentfulStatusCode
      );
    }

    const run = store.getRun(id);
    const outcome = await scheduler.cancelRun(id);

    if (outcome.state === 'not_found') {
      return c.json({ error: 'Run not found' }, 404);
    }
    if (outcome.state === 'unconfirmed') {
      // 502: the request left this server and nothing answered for it. Saying
      // "cancelled" here would be a claim about a run we cannot see.
      return c.json({ error: outcome.reason }, 502);
    }
    // Nothing was stopped, so nothing happened worth telling the activity feed.
    if (outcome.state === 'already_finished') {
      return c.json({ success: true, state: 'already_finished' });
    }

    if (activityService && run) {
      const schedule = store.getTask(run.scheduleId);
      activityService.emit({
        // Same login-off residual as DELETE above.
        ...readActivityActor(caller),
        category: 'tasks',
        eventType: 'tasks.run_cancelled',
        resourceType: 'schedule',
        resourceId: run.scheduleId,
        resourceLabel: schedule?.displayName ?? schedule?.name ?? run.scheduleId,
        summary: `${schedule?.displayName ?? schedule?.name ?? run.scheduleId} was cancelled`,
        linkPath: '/',
      });
    }

    return c.json({ success: true, state: 'stopping' });
  });

  // A person putting back a mode an agent set without asking (DOR-3703).
  mountTaskModeUndo(router, deps);
  return router;
}
