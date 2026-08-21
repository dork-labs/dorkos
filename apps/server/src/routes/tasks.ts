/**
 * Tasks scheduler routes — CRUD for schedules and runs.
 *
 * File-first architecture: API routes write SKILL.md files to disk,
 * then sync to the DB for immediate consistency. The watcher/reconciler
 * handles external file changes.
 *
 * @module routes/tasks
 */
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import {
  CreateTaskRequestSchema,
  UpdateTaskRequestSchema,
  ListTaskRunsQuerySchema,
} from '@dorkos/shared/schemas';
import type { Task } from '@dorkos/shared/schemas';
import type { MeshCore } from '@dorkos/mesh';
import type { TaskStore } from '../services/tasks/task-store.js';
import type { TaskSchedulerService } from '../services/tasks/task-scheduler-service.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import { writeSkillFile, deleteSkillDir } from '@dorkos/skills/writer';
import { parseSkillFile } from '@dorkos/skills/parser';
import { TaskFrontmatterSchema } from '@dorkos/skills/task-schema';
import { slugify } from '@dorkos/skills/slug';
import { parseDuration } from '@dorkos/skills/duration';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { loadTemplates, RESERVED_TASK_DIRNAMES } from '../services/tasks/task-templates.js';
import { parseBody } from '../lib/route-utils.js';
import { broadcastTasksChanged } from '../services/tasks/task-sse-events.js';
import { resolveDecisionAuthority } from '../services/core/approvals/index.js';
import { readCallerAuthority } from '../lib/caller-authority.js';
import { readCallerPrincipal } from '../lib/caller-principal.js';
import { getRequestAgentIdentity } from '../middleware/agent-identity.js';
import { resolveStanding } from '../services/notifications/notification-service.js';
import { armEscalation } from '../services/notifications/escalation-service.js';
import { resolveScheduleParkPayload } from '../services/notifications/emitters/schedule-park.js';
import { withProposerName, withProposerNames } from '../services/tasks/task-provenance.js';
import {
  describeOperatorOnlyTaskRefusal,
  findOperatorOnlyTaskFields,
  OPERATOR_ONLY_TASK_CODE,
  OPERATOR_ONLY_TASK_ERROR,
} from '../services/tasks/task-write-policy.js';
import fs from 'node:fs/promises';

/**
 * Whether this caller clears the agent bar: it names no agent and holds no
 * approval token, in any login posture.
 *
 * ## This is the bar tasks have always run, spelled out rather than borrowed
 *
 * It used to read `trustedCaller(...) !== undefined`, which asked the same
 * question by delegation. DOR-474 changed what a trusted-caller MARKER means: it
 * now also demands a session cookie under login-on, because the marker stands in
 * for "could have granted itself the approval anyway" and answering an approval
 * now needs a cookie. Tasks must not inherit that, so they stop asking through the
 * marker and ask the resolver directly.
 *
 * Inheriting it would have been a silent regression, not a hardening, and it was
 * caught on a live server rather than in review: `dorkos task create` presents a
 * per-user API key and no cookie, so `POST /api/tasks` would have parked every
 * task the operator scheduled at `pending_approval` while the CLI printed
 * `Created task <name>` and nothing else (`packages/cli/src/commands/task.ts:252`).
 * A cron job reported as created that never fires is worse than a refusal. And
 * `PATCH /api/tasks/:id` with `permissionMode` would have hard-403'd with no
 * approval path at all, which is a lockout by the same rule
 * `services/marketplace/source-write-policy.ts` applies to package sources.
 *
 * Whether an agent holding the operator's key should be able to schedule
 * unattended work is a real question, and `services/tasks/task-write-policy.ts`
 * asks to be reconsidered deliberately if the cookie requirement is ever
 * generalized. It is DOR-553's, in flight elsewhere. A security fix must not
 * answer an adjacent subsystem's open question as a side effect.
 *
 * @param req - The incoming request.
 * @param res - The response, for `sessionGate`'s resolved user.
 * @returns True when no machine principal presented itself.
 */
function clearsTheAgentBar(req: Request, res: Response): boolean {
  return resolveDecisionAuthority(readCallerAuthority(req, res)).allowed;
}

/**
 * Refuse a task write that reaches for a field only a person may set (DOR-504),
 * answering on `res` when it does.
 *
 * ## Why this route needs a caller check when the MCP twin does not
 *
 * `tasks_create` and `tasks_update` refuse `permissionMode` and `status`
 * unconditionally, because an MCP tool call is by construction the agent surface.
 * This route is not: the cockpit's Approve button writes `status: 'active'`
 * through it (`TaskRow.tsx`), and its task form writes `permissionMode`. So the
 * policy is skipped for a caller that clears {@link clearsTheAgentBar} — no agent
 * identity and no approval token — and applied to everyone else. That is exactly the shape
 * `PATCH /api/config` uses for operator-only settings, and the long note there
 * states the divergence it creates: under the default `local-trust` posture a
 * caller with a shell can omit both headers and clear the check, so this stops
 * an agent that follows the protocol, not an adversary already running as you.
 * That is stated rather than papered over, and it is strictly tighter than the
 * nothing this route enforced before.
 *
 * ## Read the RAW body, and refuse it whole
 *
 * The check runs before `parseBody` for two reasons. `CreateTaskRequestSchema`
 * DEFAULTS `permissionMode` to `acceptEdits`, so a parsed body always carries the
 * key and the guard could not tell a caller that sent it from one that did not.
 * And refusing before anything is parsed or written is what makes the refusal
 * whole: a caller is never told a change landed when only part of it did.
 *
 * @param req - The incoming request, whose raw body is inspected.
 * @param res - The response, answered with 403 when a field is refused.
 * @param trusted - Whether the caller cleared {@link clearsTheAgentBar}. Passed in
 *   rather than resolved here because `POST /` needs the same answer a second
 *   time, to decide whether the new task is parked (see {@link parksOnCreate}),
 *   and asking twice would let the two uses disagree.
 * @returns True when the request was refused and the route must stop.
 */
function refusedOperatorOnlyTaskWrite(req: Request, res: Response, trusted: boolean): boolean {
  if (trusted) return false;
  const operatorOnly = findOperatorOnlyTaskFields(req.body);
  if (operatorOnly.length === 0) return false;
  res.status(403).json({
    error: OPERATOR_ONLY_TASK_ERROR,
    code: OPERATOR_ONLY_TASK_CODE,
    fields: operatorOnly,
    message: describeOperatorOnlyTaskRefusal(operatorOnly),
  });
  return true;
}

/**
 * Whether a task created by this caller must wait for a person's approval
 * (DOR-504).
 *
 * ## The gap this closes
 *
 * `tasks_create` on both MCP servers parks every schedule it makes at
 * `pending_approval`, and says so in its own description. That parking lived in
 * the TOOL HANDLER, not in the store: both store insert paths hardcode
 * `status: 'active'`. So the REST twin created a LIVE cron task instead — and
 * `dorkos task create` is that REST surface, sending its agent header. An agent
 * could not arm a task through the tool it was told to use, and could through the
 * CLI it was also told to use.
 *
 * That is worth closing rather than only narrowing the prose around: a cron task
 * is persistence. It fires later, on its own, when nobody is looking, which is a
 * different thing from running a command now.
 *
 * ## Why trust, and not the presence of a `status` field
 *
 * The caller never has to ASK to arm a task here; it arms by default, because
 * the store's insert says `active`. So there is no field to refuse. The question
 * is only "did a person do this", which is the same question
 * {@link refusedOperatorOnlyTaskWrite} already asks, answered by the same
 * predicate — so the cockpit's task form and a signed-in operator are untouched,
 * and an agent's REST-created task now waits exactly like its MCP-created one.
 *
 * @param trusted - Whether the caller cleared {@link clearsTheAgentBar}.
 * @returns True when the new task must be parked at `pending_approval`.
 */
function parksOnCreate(trusted: boolean): boolean {
  return !trusted;
}

/**
 * How many upcoming runs a parked schedule carries in `nextRuns`.
 *
 * Three, because the question the preview answers is "is this cron what the
 * agent says it is?" — one occurrence cannot show a rhythm, and a long list is
 * a wall of timestamps nobody reads. Three shows the interval and the
 * time-of-day at a glance.
 */
const NEXT_RUNS_PREVIEW_COUNT = 3;

/** What a create or park refuses when the proposal makes no case for itself. */
const MISSING_REASON_MESSAGE =
  'A task that has to be approved needs a reason. Say why this schedule should exist — ' +
  'whoever approves it has only that to go on.';

/**
 * Create the Tasks router with schedule and run management endpoints.
 *
 * @param store - TaskStore for data persistence
 * @param scheduler - TaskSchedulerService for cron management and dispatch
 * @param dorkHome - Resolved data directory path
 * @param meshCore - Optional MeshCore for resolving agent project paths
 * @param activityService - Optional ActivityService for emitting activity events
 */
export function createTasksRouter(
  store: TaskStore,
  scheduler: TaskSchedulerService,
  dorkHome: string,
  meshCore?: MeshCore,
  activityService?: ActivityService
): Router {
  const router = Router();

  /**
   * Describe when a task will run, for one task on its way out of this router.
   *
   * **`nextRuns` is computed for `pending_approval` rows and nobody else**, and
   * the narrowness is the design (DOR-1394 review). Reading a cron means
   * constructing a throwaway `croner` job and asking it for three occurrences —
   * measured at roughly 1.4ms, synchronously, per task — and this route runs on
   * every cockpit poll over every task there is. The only surface that reads the
   * field is the approval card, which only ever shows parked schedules, so
   * computing it for the rest would be milliseconds per poll spent on an answer
   * nothing asks for. Everything else reports `[]`.
   *
   * A parked schedule is exactly where the question cannot be answered any other
   * way: the scheduler never registers one, so it holds no job to ask.
   *
   * `nextRun` keeps its old meaning everywhere it already had one: the live
   * job's own answer, and `null` for a task that is not going to fire. The one
   * addition is `pending_approval`, which now reports its first previewed
   * occurrence instead of `null`. Paused and disabled tasks deliberately stay
   * `null` — Home reads this field to say what happens next, and a time for a
   * task nothing will fire is a promise nobody is keeping.
   */
  function withRunTimes(task: Task): Task {
    const live = scheduler.getNextRun(task.id)?.toISOString() ?? null;
    if (task.status !== 'pending_approval') return { ...task, nextRuns: [], nextRun: live };

    const nextRuns = scheduler.previewNextRuns(task.cron, task.timezone, NEXT_RUNS_PREVIEW_COUNT);
    return { ...task, nextRuns, nextRun: live ?? nextRuns[0] ?? null };
  }

  /** One task, ready to send: run times attached and its proposer named. */
  async function present(task: Task): Promise<Task> {
    return withRunTimes(await withProposerName(task));
  }

  /** {@link present} for a whole list, with one identity lookup per distinct agent. */
  async function presentAll(tasks: Task[]): Promise<Task[]> {
    return (await withProposerNames(tasks)).map(withRunTimes);
  }

  // === Template endpoints ===

  router.get('/templates', async (_req, res) => {
    const templates = await loadTemplates(dorkHome);
    return res.json(templates);
  });

  // === Schedule endpoints ===

  router.get('/', async (_req, res) => {
    res.json(await presentAll(store.getTasks()));
  });

  router.post('/', async (req, res) => {
    const trusted = clearsTheAgentBar(req, res);
    if (refusedOperatorOnlyTaskWrite(req, res, trusted)) return;
    const data = parseBody(CreateTaskRequestSchema, req.body, res);
    if (!data) return;

    // A task this caller cannot arm itself is a PROPOSAL, and a proposal has to
    // make its own case (DOR-1394). Asked here rather than in the Zod schema
    // because it depends on WHO is asking, and asked before the file is written
    // so a reasonless proposal never lands on disk for the reconciler to find.
    // The MCP door demands the same thing through its own tool schema, so the
    // two agent-facing doors now agree.
    const proposedReason = data.reason?.trim();
    if (parksOnCreate(trusted) && !proposedReason) {
      return res.status(400).json({ error: MISSING_REASON_MESSAGE });
    }

    // Resolve slug and target directory
    const slug = slugify(data.name);

    // `templates/` is a container the tasks system owns, so a task cannot live
    // at that path. Refused rather than silently allowed, because a row
    // pointing into a reserved container is worse than useless: the reconciler
    // skips reserved names, so nothing ever re-syncs it, and the delete route
    // below derives the directory to remove from `filePath` — which for such a
    // row is the container itself, taking every template with it.
    if (RESERVED_TASK_DIRNAMES.includes(slug)) {
      return res.status(400).json({
        error: `"${slug}" is a reserved name in the tasks folder. Pick a different name.`,
      });
    }

    let tasksDir: string;
    let agentId: string | null = null;

    if (data.target === 'global') {
      tasksDir = path.join(dorkHome, 'tasks');
    } else if (meshCore) {
      const projectPath = meshCore.getProjectPath(data.target);
      if (!projectPath) {
        return res.status(400).json({ error: `Agent ${data.target} not found in registry` });
      }
      tasksDir = path.join(projectPath, '.dork', 'tasks');
      agentId = data.target;
    } else {
      return res.status(400).json({ error: 'Cannot resolve agent — mesh not available' });
    }

    // Check for duplicate slug
    const existingPath = path.join(tasksDir, slug, SKILL_FILENAME);
    try {
      await fs.access(existingPath);
      return res.status(409).json({ error: `Task "${slug}" already exists in target directory` });
    } catch {
      // File doesn't exist — good
    }

    // Build frontmatter (only file-safe fields)
    const frontmatter: Record<string, unknown> = {
      name: slug,
      description: data.description,
    };
    if (data.displayName) frontmatter['display-name'] = data.displayName;
    if (data.cron) frontmatter.cron = data.cron;
    if (data.timezone) frontmatter.timezone = data.timezone;
    if (data.enabled === false) frontmatter.enabled = false;
    if (data.maxRuntime) frontmatter['max-runtime'] = data.maxRuntime;
    if (data.permissionMode && data.permissionMode !== 'acceptEdits') {
      frontmatter.permissions = data.permissionMode;
    }

    // Write file first (source of truth)
    const filePath = await writeSkillFile(tasksDir, slug, frontmatter, data.prompt);

    // Sync to DB for immediate consistency
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = parseSkillFile(filePath, content, TaskFrontmatterSchema);
    let schedule: Task;
    if (parsed.ok) {
      const def = { ...parsed.definition, scope: 'global' as const, projectPath: undefined };
      schedule = store.upsertFromFile(def, agentId ?? undefined);
      // `upsertFromFile` refuses a file-declared `bypassPermissions`, because a
      // SKILL.md on disk is nobody's approval
      // (`services/tasks/schedule-permission-clamp.ts`). The mode here did not
      // come from the file: the route wrote that file from this request body a
      // few lines up, and `refusedOperatorOnlyTaskWrite` has already asked
      // whether this caller may set the field at all. So the clamp is undone
      // for the one caller that cleared the bar — the same after-the-fact patch
      // the parking below uses, and for the same reason: the store's file path
      // cannot tell the two sources apart.
      if (trusted && data.permissionMode === 'bypassPermissions') {
        schedule = store.updateTask(schedule.id, { permissionMode: 'bypassPermissions' })!;
      }
    } else {
      // Fallback: create directly in DB
      schedule = store.createTask({
        name: slug,
        displayName: data.displayName,
        description: data.description,
        prompt: data.prompt,
        cron: data.cron,
        timezone: data.timezone,
        agentId,
        enabled: data.enabled,
        maxRuntime: data.maxRuntime ? parseDuration(data.maxRuntime) : null,
        permissionMode: data.permissionMode,
        filePath,
      });
    }

    // Both store insert paths hardcode `status: 'active'`, so parking is a patch
    // after the fact — the same two-step `tasks_create` uses on the MCP servers.
    // It has to happen BEFORE the register below, or the task fires while it is
    // still waiting to be approved.
    // The escalation clock starts here (DOR-1387). Parked schedules have no
    // observer seam, so the hook lands at the write that parks one. Still
    // nothing RAISED at this edge: `schedule.parked` is a STANDING kind, which
    // stores nothing while it stands (ADR 260819-234828), and its two
    // resolutions are recorded where the operator decides them — which is also
    // where the timer is disarmed, through `resolveStanding`.
    if (parksOnCreate(trusted)) {
      store.updateTask(schedule.id, { status: 'pending_approval' });
      // Stamped from the RESOLVED credential, never from the body: a caller that
      // could name its own agent path could credit its proposal to any agent the
      // operator trusts. `getRequestAgentIdentity` answers only for a caller that
      // presented a live token, so an unidentified one leaves this null and the
      // card honestly says it does not know who asked.
      store.recordProposal(schedule.id, {
        reason: proposedReason ?? null,
        proposedByAgentPath: getRequestAgentIdentity(res)?.agentPath ?? null,
      });
      schedule = store.getTask(schedule.id)!;
      armEscalation('schedule.parked', await resolveScheduleParkPayload(schedule));
    }

    if (schedule.enabled && schedule.status === 'active') {
      scheduler.registerTask(schedule);
    }

    activityService?.emit({
      actorType: 'user',
      actorLabel: 'You',
      category: 'tasks',
      eventType: 'tasks.task_created',
      resourceType: 'schedule',
      resourceId: schedule.id,
      resourceLabel: schedule.displayName ?? schedule.name,
      summary: `Created task ${schedule.displayName ?? schedule.name}`,
      linkPath: '/',
    });

    broadcastTasksChanged();

    // Run times and the proposer's name are derived, not persisted on the row,
    // so they must be attached here the same way the list endpoint does —
    // otherwise a freshly created task reports none of them until the next list
    // fetch.
    return res.status(201).json(await present(schedule));
  });

  router.patch('/:id', async (req, res) => {
    const trusted = clearsTheAgentBar(req, res);
    if (refusedOperatorOnlyTaskWrite(req, res, trusted)) return;
    const data = parseBody(UpdateTaskRequestSchema, req.body, res);
    if (!data) return;

    const existing = store.getTask(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // If there's a file on disk, update it
    if (existing.filePath) {
      try {
        const content = await fs.readFile(existing.filePath, 'utf-8');
        const parsed = parseSkillFile(existing.filePath, content, TaskFrontmatterSchema);

        if (parsed.ok) {
          const updatedFrontmatter: Record<string, unknown> = {
            ...(parsed.definition.meta as Record<string, unknown>),
          };
          if (data.name !== undefined) updatedFrontmatter.name = data.name;
          if (data.displayName !== undefined) updatedFrontmatter['display-name'] = data.displayName;
          if (data.description !== undefined) updatedFrontmatter.description = data.description;
          if (data.cron !== undefined) updatedFrontmatter.cron = data.cron;
          if (data.timezone !== undefined) updatedFrontmatter.timezone = data.timezone;
          if (data.enabled !== undefined) updatedFrontmatter.enabled = data.enabled;
          if (data.maxRuntime !== undefined) updatedFrontmatter['max-runtime'] = data.maxRuntime;
          if (data.permissionMode !== undefined)
            updatedFrontmatter.permissions = data.permissionMode;

          const updatedPrompt = data.prompt ?? parsed.definition.body;
          const parentDir = path.dirname(parsed.definition.dirPath);
          await writeSkillFile(
            parentDir,
            parsed.definition.name,
            updatedFrontmatter,
            updatedPrompt
          );
        }
      } catch {
        // File may not exist (legacy DB-only task) — update DB directly
      }
    }

    let updated = store.updateTask(req.params.id, data);
    if (!updated) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Re-register or unregister cron job based on new state
    if (updated.enabled && updated.status === 'active') {
      scheduler.registerTask(updated);
    } else {
      scheduler.unregisterTask(updated.id);
    }

    if (data.enabled === false && activityService) {
      activityService.emit({
        actorType: 'user',
        actorLabel: 'You',
        category: 'tasks',
        eventType: 'tasks.task_paused',
        resourceType: 'schedule',
        resourceId: req.params.id,
        resourceLabel: updated.displayName ?? updated.name,
        summary: `Paused task ${updated.displayName ?? updated.name}`,
        linkPath: '/',
      });
    }

    // A schedule leaving `pending_approval` for `active` IS the approval — there
    // is no separate endpoint for it, so this transition is where the parked
    // condition ends and its history row is written.
    if (existing.status === 'pending_approval' && updated.status === 'active') {
      const actorPrincipal = readCallerPrincipal(req, res);
      void resolveScheduleParkPayload(updated).then((payload) =>
        resolveStanding('schedule.parked', payload, { outcome: 'approved', actorPrincipal })
      );
    }

    // ...and the symmetric edge, which this route handled in only one direction
    // until the DOR-1387 review: a schedule PATCHed INTO `pending_approval` is a
    // condition that has just STARTED standing, so its clock starts here exactly
    // as it does at the two create sites. Without this, a schedule parked by an
    // update could wait indefinitely with no escalation behind it.
    //
    // Unlike the create path above there is NO reason gate here, and that is a
    // fact about who can reach this line rather than an omission. `status` is
    // operator-only (`task-write-policy.ts`), so `refusedOperatorOnlyTaskWrite`
    // has already 403'd any caller that did not clear the agent bar — a schedule
    // can only be PATCHed into `pending_approval` by the operator, and an
    // operator parking their own task owes nobody an explanation. A `reason` sent
    // with that park is still kept, so the field means the same thing on every
    // door it can arrive through.
    if (existing.status !== 'pending_approval' && updated.status === 'pending_approval') {
      const parkReason = data.reason?.trim();
      if (parkReason) {
        updated = store.recordProposal(req.params.id, { reason: parkReason }) ?? updated;
      }
      armEscalation('schedule.parked', await resolveScheduleParkPayload(updated));
    }

    broadcastTasksChanged();

    return res.json(await present(updated));
  });

  router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    const schedule = store.getTask(id);
    if (!schedule) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Delete file from disk first
    if (schedule.filePath) {
      try {
        const dirPath = path.dirname(schedule.filePath);
        const dirName = path.basename(dirPath);
        const parentDir = path.dirname(dirPath);
        await deleteSkillDir(parentDir, dirName);
      } catch {
        // File may already be gone — continue with DB cleanup
      }
    }

    scheduler.unregisterTask(id);
    store.deleteTask(id);

    activityService?.emit({
      actorType: 'user',
      actorLabel: 'You',
      category: 'tasks',
      eventType: 'tasks.task_deleted',
      resourceType: 'schedule',
      resourceId: id,
      resourceLabel: schedule.displayName ?? schedule.name,
      summary: `Deleted task ${schedule.displayName ?? schedule.name}`,
    });

    // Rejecting a proposed schedule is deleting it — the cockpit's Reject button
    // is this endpoint. Only a schedule that was actually waiting counts: a
    // person tidying up a task they never had to approve is not a rejection.
    if (schedule.status === 'pending_approval') {
      const actorPrincipal = readCallerPrincipal(req, res);
      void resolveScheduleParkPayload(schedule).then((payload) =>
        resolveStanding('schedule.parked', payload, { outcome: 'rejected', actorPrincipal })
      );
    }

    broadcastTasksChanged();

    return res.json({ success: true });
  });

  router.post('/:id/trigger', async (_req, res) => {
    const run = await scheduler.triggerManualRun(_req.params.id);
    if (!run) {
      return res.status(404).json({ error: 'Schedule not found' });
    }
    return res.status(201).json({ runId: run.id });
  });

  // === Run endpoints ===

  router.get('/runs', (req, res) => {
    const data = parseBody(ListTaskRunsQuerySchema, req.query, res);
    if (!data) return;

    const runs = store.listRuns({
      taskId: data.scheduleId,
      status: data.status,
      limit: data.limit,
      offset: data.offset,
    });
    return res.json(runs);
  });

  router.get('/runs/:id', (req, res) => {
    const run = store.getRun(req.params.id);
    if (!run) {
      return res.status(404).json({ error: 'Run not found' });
    }
    res.json(run);
  });

  router.post('/runs/:id/cancel', async (req, res) => {
    const run = store.getRun(req.params.id);
    const outcome = await scheduler.cancelRun(req.params.id);

    if (outcome.state === 'not_found') {
      return res.status(404).json({ error: 'Run not found' });
    }
    if (outcome.state === 'unconfirmed') {
      // 502: the request left this server and nothing answered for it. Saying
      // "cancelled" here would be a claim about a run we cannot see.
      return res.status(502).json({ error: outcome.reason });
    }
    // Nothing was stopped, so nothing happened worth telling the activity feed.
    if (outcome.state === 'already_finished') {
      return res.json({ success: true, state: 'already_finished' });
    }

    if (activityService && run) {
      const schedule = store.getTask(run.scheduleId);
      activityService.emit({
        actorType: 'user',
        actorLabel: 'You',
        category: 'tasks',
        eventType: 'tasks.run_cancelled',
        resourceType: 'schedule',
        resourceId: run.scheduleId,
        resourceLabel: schedule?.displayName ?? schedule?.name ?? run.scheduleId,
        summary: `${schedule?.displayName ?? schedule?.name ?? run.scheduleId} was cancelled`,
        linkPath: '/',
      });
    }

    return res.json({ success: true, state: 'stopping' });
  });

  return router;
}
