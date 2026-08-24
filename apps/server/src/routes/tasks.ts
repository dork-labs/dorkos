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
import type { TaskRegistrar } from '../services/tasks/task-registrar.js';
import { describeScheduleProblem } from '../services/tasks/cron-validation.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import { writeSkillFile, deleteSkillDir } from '@dorkos/skills/writer';
import { parseSkillFile } from '@dorkos/skills/parser';
import { TaskFrontmatterSchema } from '@dorkos/skills/task-schema';
import { slugify, validateSlug } from '@dorkos/skills/slug';
import { parseDuration } from '@dorkos/skills/duration';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { loadTemplates, RESERVED_TASK_DIRNAMES } from '../services/tasks/task-templates.js';
import { parseBody, toErrorMessage } from '../lib/route-utils.js';
import { broadcastTasksChanged } from '../services/tasks/task-sse-events.js';
import { resolveDecisionAuthority } from '../services/core/approvals/index.js';
import { readCallerAuthority } from '../lib/caller-authority.js';
import { readCallerPrincipal } from '../lib/caller-principal.js';
import { getRequestAgentIdentity } from '../middleware/agent-identity.js';
import { resolveStanding } from '../services/notifications/notification-service.js';
import { armEscalation } from '../services/notifications/escalation-service.js';
import { resolveScheduleParkPayload } from '../services/notifications/emitters/schedule-park.js';
import { withProposerName, withProposerNames } from '../services/tasks/task-provenance.js';
import { resolveScheduledRunPermissionMode } from '../services/tasks/scheduled-run-power.js';
import { clampSchedulePermissionMode } from '../services/tasks/schedule-permission-clamp.js';
import {
  describeOperatorOnlyTaskRefusal,
  findOperatorOnlyTaskFields,
  OPERATOR_ONLY_TASK_CODE,
  OPERATOR_ONLY_TASK_ERROR,
  OPERATOR_ONLY_TRIGGER_REFUSAL,
} from '../services/tasks/task-write-policy.js';
import { mergeTaskFrontmatter } from '../services/tasks/task-frontmatter-merge.js';
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
 * The check runs before `parseBody` for two reasons. It has to see what the
 * CALLER sent rather than what the route resolved: an omitted `permissionMode`
 * is filled in from the operator's own trust stop a few lines later
 * (`resolveScheduledRunPermissionMode`), and a guard reading the resolved value
 * could not tell a caller that named a level from one that did not. That was
 * true of the Zod default this replaced and it is true of the ladder — the guard
 * did not change, only the thing it must not be moved after. And refusing before
 * anything is parsed or written is what makes the refusal whole: a caller is
 * never told a change landed when only part of it did.
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
 * What a caller is told when a task's SKILL.md could not be read, understood,
 * or written.
 *
 * Written for a person, because these are the failures on this route that a
 * person has to go and fix outside DorkOS: a read-only disk, a full one, a file
 * owned by someone else, a settings block someone hand-edited into nonsense. It
 * names the file, says plainly that nothing changed, and carries the underlying
 * reason rather than hiding it.
 *
 * The `parse` case matters most, and is the one added last (DOR-1481 review).
 * Any task still carrying the `max-runtime: null` corruption this branch also
 * fixes has an unreadable file on disk right now, and the route used to fall
 * straight past it to the row and answer 200 — so the corruption had no symptom
 * at all. Now it has a legible one that says which file to open.
 *
 * @param what - Which step failed: loading the file, understanding it, or writing it.
 * @param filePath - The SKILL.md the route was working on.
 * @param reason - The underlying failure, already reduced to a sentence.
 * @returns One line for the response body's `error`.
 */
function describeTaskFileFailure(
  what: 'read' | 'parse' | 'save',
  filePath: string,
  reason: string
): string {
  const verb = { read: 'read', parse: 'make sense of', save: 'save' }[what];
  const advice = {
    read: 'Check who is allowed to open that file',
    parse:
      'Open that file and fix the settings block at the top — a setting written as `null` is the usual cause',
    save: 'Check who is allowed to write to that file and how much space is left on the disk',
  }[what];
  return (
    `DorkOS could not ${verb} this task's file at ${filePath}, so nothing was changed: ` +
    `${reason}. ${advice}, then try again.`
  );
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
 * @param scheduler - TaskSchedulerService for dispatch and run-time queries
 * @param registrar - The one seam that turns a row into a live cron job, shared
 *   with the file watcher and the reconciler so all four writers agree
 * @param dorkHome - Resolved data directory path
 * @param meshCore - Optional MeshCore for resolving agent project paths
 * @param activityService - Optional ActivityService for emitting activity events
 */
export function createTasksRouter(
  store: TaskStore,
  scheduler: TaskSchedulerService,
  registrar: TaskRegistrar,
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

    // Asked before ANY write, because the file is written first and never
    // withdrawn: a cron or timezone croner cannot read would otherwise leave a
    // permanent SKILL.md on disk backing a row that can never be scheduled. The
    // question cannot be asked in `CreateTaskRequestSchema` — only croner knows
    // the answer and `@dorkos/shared` cannot depend on it; see
    // `services/tasks/cron-validation.ts`.
    const scheduleProblem = describeScheduleProblem(data.cron, data.timezone);
    if (scheduleProblem) {
      return res.status(400).json({ error: scheduleProblem });
    }

    // How much power this schedule runs with, resolved ONCE (spec
    // `full-power-defaults`, D6). A caller that named a mode keeps it verbatim;
    // one that named none gets the operator's own trust stop, mapped through the
    // runtime the scheduler actually drives, and `'acceptEdits'` when no stop is
    // configured — byte-for-byte the Zod default this replaced. Resolved here
    // rather than at each read below because three of them follow (the
    // frontmatter, the trusted un-clamp, and the DB fallback insert) and three
    // resolutions is three chances to disagree.
    const permissionMode = data.permissionMode ?? resolveScheduledRunPermissionMode();

    // …and clamped ONCE, for every caller that did not clear the agent bar
    // (DOR-1432 stage-2 review). This is the value that gets written to the file
    // and inserted into the row; the explicit un-clamp below is the only thing
    // that lifts it, and only for a trusted caller.
    //
    // **Why the clamp has to live here rather than on the fallback insert
    // alone.** Two paths reach the row — `upsertFromFile`, which clamps a
    // file-declared bypass itself, and the direct `store.createTask` below,
    // which is not a file path and so has no clamp of its own. WHICH ONE runs is
    // decided by whether the file the route just wrote parses back, and an agent
    // could choose that: several request fields were looser than their
    // frontmatter counterparts, so a body the request schema accepted produced a
    // file the frontmatter schema rejected, and the resolved
    // `bypassPermissions` went in unclamped. `maxRuntime` was the reported one,
    // an over-long `description` and a name that slugifies to nothing did it
    // too. Those three are tightened at the schema, which is the other half of
    // the fix — but tightening only ever closes the divergences somebody has
    // thought of, and this closes the shape of the bug: no path from a caller
    // that cannot ask for a mode can write one, whichever branch it lands on.
    const effectivePermissionMode = trusted
      ? permissionMode
      : clampSchedulePermissionMode(permissionMode).mode;

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

    // A name that slugifies to something the SKILL.md name rule rejects — most
    // easily the empty string, which `'!!!'` produces. Refused here rather than
    // in `CreateTaskRequestSchema`, because the constraint is on the DERIVED
    // slug and the request body carries the name it was derived from.
    //
    // It is a validation fix with a security reason (DOR-1432 stage-2 review):
    // an unparseable file used to send the route down a create path that skipped
    // the permission clamp, so any field a caller could make the frontmatter
    // reject was a lever on which path ran. Both paths clamp now — this closes
    // the lever as well, which is the layer that stops the next one.
    if (!validateSlug(slug)) {
      return res.status(400).json({
        error: `"${data.name}" has no usable name in it. Use letters or numbers — "Nightly sweep" becomes "nightly-sweep".`,
      });
    }

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

    // Build frontmatter (only file-safe fields), through the same merge the
    // update path below uses. An omitted field is left out of the file rather
    // than written as an empty value, which is what the run of `if`s here used
    // to say one field at a time.
    const frontmatter = mergeTaskFrontmatter(
      { name: slug, description: data.description },
      {
        displayName: data.displayName || undefined,
        cron: data.cron || undefined,
        timezone: data.timezone || undefined,
        // Only a schedule the caller turned OFF says so in the file — the
        // frontmatter's own default is `enabled: true`.
        enabled: data.enabled === false ? false : undefined,
        maxRuntime: data.maxRuntime || undefined,
        // The CLAMPED mode, so the file and the row agree. This is a file-first
        // architecture: the reconciler and the watcher both re-read this file, and a
        // SKILL.md saying `permissions: bypassPermissions` over a row holding
        // `acceptEdits` is a standing request from disk that nobody made and no
        // screen shows. It could not escalate on its own — `resolveFilePermissionMode`
        // clamps it on every sync, and `keepsApprovedBypass` needs the row to be
        // bypass AND active already — but a file that disagrees with its own row is
        // a lie in the source of truth, and the next reader should not have to
        // rediscover why it is harmless.
        //
        // `acceptEdits` is the frontmatter default too, so naming it would add a
        // line that says nothing.
        permissionMode:
          effectivePermissionMode && effectivePermissionMode !== 'acceptEdits'
            ? effectivePermissionMode
            : undefined,
      }
    );

    // Write file first (source of truth)
    const filePath = await writeSkillFile(tasksDir, slug, frontmatter, data.prompt);

    // Sync to DB for immediate consistency
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = parseSkillFile(filePath, content, TaskFrontmatterSchema);
    let schedule: Task;
    if (parsed.ok) {
      const def = { ...parsed.definition, scope: 'global' as const, projectPath: undefined };
      schedule = store.upsertFromFile(def, agentId ?? undefined);
    } else {
      // Fallback: create directly in DB. NOT a file path, so it gets none of
      // `upsertFromFile`'s clamping — which is why the mode it is handed was
      // clamped up at the resolution above rather than here. Do not put the raw
      // `permissionMode` back into this call.
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
        permissionMode: effectivePermissionMode,
        filePath,
      });
    }

    // The ONE un-clamp, after BOTH branches, because both need exactly the same
    // patch and two copies of a security exception are two chances to fix only
    // one of them. Above, `upsertFromFile` refuses a file-declared
    // `bypassPermissions` (a SKILL.md on disk is nobody's approval,
    // `services/tasks/schedule-permission-clamp.ts`); below, the resolution did
    // the clamping. Either way the row is now at most `acceptEdits`, and this is
    // what lifts it.
    //
    // It is lifted only for a caller that cleared the agent bar, and the mode it
    // is lifted to is the one that caller effectively asked for: either they
    // named `bypassPermissions`, or they named nothing on an install whose
    // operator set the global stop to full autonomy through the consent-gated
    // door (spec `full-power-defaults`, D6). The store's file path cannot tell
    // those from a file that simply declared it, which is why the lift happens
    // here and not there.
    //
    // **What is NOT true, stated because an earlier version of this comment
    // claimed it:** there is no confirmation dialog standing behind this. The
    // cockpit's task form always sends an explicit mode and so never reaches the
    // resolved branch at all; the callers that DO reach it — `dorkos task
    // create`, a bare HTTP POST, anything with a shell — have no confirm step of
    // any kind. The CLI prints a line naming the level after the fact, which is
    // disclosure, not consent. The real protection is the agent bar plus the
    // clamp; do not add "and the UI asks" to the list.
    if (trusted && permissionMode === 'bypassPermissions') {
      schedule = store.updateTask(schedule.id, { permissionMode: 'bypassPermissions' })!;
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

    // Through the registrar, not `scheduler.registerTask` directly: the same
    // seam the watcher and the reconciler use, so a task created here and a task
    // created by dropping a SKILL.md on disk end up in exactly the same state.
    registrar.syncTask(schedule.id);

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

    // The MERGED schedule is what gets registered, so the merged schedule is
    // what has to read: a new cron runs in the task's existing timezone unless
    // this same request changes it, and either half alone can be the one croner
    // refuses. Asked only when a request touches one of them, so a PATCH of an
    // unrelated field can never be refused by a schedule it did not write — and
    // asked before the file rewrite below, for the reason the create path gives.
    if (data.cron !== undefined || data.timezone !== undefined) {
      const problem = describeScheduleProblem(
        data.cron !== undefined ? data.cron : existing.cron,
        data.timezone !== undefined ? data.timezone : existing.timezone
      );
      if (problem) {
        return res.status(400).json({ error: problem });
      }
    }

    // A caller that cannot NAME `bypassPermissions` must not be able to KEEP one
    // by rewriting what the approved run does (security re-review). `permissionMode`
    // is operator-only, so `refusedOperatorOnlyTaskWrite` has already 403'd any
    // non-trusted caller that tried to set the mode — but `prompt`, `cron`, and
    // `name` are agent-writable, and this route writes the file and the row
    // TOGETHER: it keeps the file's `permissions: bypassPermissions` and updates
    // only the changed fields, so both end up holding the new work in sync. That is
    // exactly the state {@link keepsApprovedBypass} reads as "still the approved
    // work", so the grant would survive the next reconciler sync — an approved
    // full-autonomy cron now running with an agent's changes.
    //
    // `name` belongs here beside `prompt` and `cron` because it is not inert: a
    // scheduled run's system prompt tells the agent `Job: ${task.name}`
    // (`services/tasks/task-append.ts`), so the name is part of what the unattended
    // run is told. `UpdateTaskRequestSchema` now also bounds `name` to a slug, so a
    // multiline injection payload is refused before this point; the clamp is the
    // second, behavioral half — any non-trusted change to the approved run's
    // identity drops the grant, exactly as a cron change does.
    //
    // So bind the grant to that work and, when a non-trusted caller changes any of
    // it, clamp the mode away through the SAME seam the create and file-sync paths
    // use. The edit still lands (these fields are agent-writable); the unattended
    // run just gets its approval prompts back. Setting it on `data` lands it on both
    // the rewritten file (below) and the row (`store.updateTask`), so the file no
    // longer declares a grant and `keepsApprovedBypass` has no bypass left in the
    // row to keep.
    //
    // A trusted caller — the person editing their own task in the cockpit — is left
    // untouched: their approval is what the write-order protects, and it still
    // round-trips through disk exactly as before.
    const promptChangesApprovedWork = data.prompt !== undefined && data.prompt !== existing.prompt;
    const cronChangesApprovedWork =
      data.cron !== undefined && (data.cron ?? '') !== (existing.cron ?? '');
    const nameChangesApprovedWork = data.name !== undefined && data.name !== existing.name;
    if (
      !trusted &&
      (promptChangesApprovedWork || cronChangesApprovedWork || nameChangesApprovedWork)
    ) {
      const clamp = clampSchedulePermissionMode(existing.permissionMode);
      if (clamp.clamped) data.permissionMode = clamp.mode;
    }

    // If there's a file on disk, update it.
    //
    // **The file goes first, and a failure here ends the request.** This used
    // to be one `try {} catch {}` around the read AND the write, with a comment
    // saying it was there for legacy DB-only tasks. It was — and it also
    // swallowed `EACCES`, `ENOSPC` and `EROFS` from the write, after which the
    // row below was updated anyway and the caller got a 200. Five minutes later
    // the reconciler read the untouched file and put the old values back, so
    // the edit simply vanished with nothing anywhere saying why. The only error
    // that means "there is no file, edit the row alone" is `ENOENT` on the
    // read; every other one is a real failure and is reported as one.
    //
    // A file that READS but does not PARSE is the same silent-success defect one
    // branch over, and it was still here after the first pass (DOR-1481 review):
    // the route skipped the write, updated the row, and answered 200. That is
    // the permanent path for every task already carrying the `max-runtime: null`
    // corruption this branch fixes, so it is exactly the case that most needs a
    // symptom. It refuses too.
    if (existing.filePath) {
      let content: string | null = null;
      try {
        content = await fs.readFile(existing.filePath, 'utf-8');
      } catch (err) {
        // A legacy DB-only task: a row whose file was never written, or was
        // deleted outside DorkOS. Fall through and update the row alone.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          return res.status(500).json({
            error: describeTaskFileFailure(
              'read',
              existing.filePath,
              toErrorMessage(err, 'the disk gave no reason')
            ),
          });
        }
      }

      if (content !== null) {
        const parsed = parseSkillFile(existing.filePath, content, TaskFrontmatterSchema);
        if (!parsed.ok) {
          return res.status(500).json({
            error: describeTaskFileFailure('parse', existing.filePath, parsed.error),
          });
        }

        const updatedFrontmatter = mergeTaskFrontmatter(
          parsed.definition.meta as Record<string, unknown>,
          data
        );
        const updatedPrompt = data.prompt ?? parsed.definition.body;
        const parentDir = path.dirname(parsed.definition.dirPath);
        try {
          await writeSkillFile(
            parentDir,
            parsed.definition.name,
            updatedFrontmatter,
            updatedPrompt
          );
        } catch (err) {
          return res.status(500).json({
            error: describeTaskFileFailure(
              'save',
              existing.filePath,
              toErrorMessage(err, 'the disk gave no reason')
            ),
          });
        }
      }
    }

    let updated = store.updateTask(req.params.id, data);
    if (!updated) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Re-register or unregister the cron job to match the new state, through the
    // shared seam — see the note on the create path above.
    registrar.syncTask(updated.id);

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

    // Row first, then the seam: with no row to read, `syncTask` unregisters —
    // the same answer the direct call gave, arrived at the one way.
    store.deleteTask(id);
    registrar.syncTask(id);

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

  router.post('/:id/trigger', async (req, res) => {
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
    if (!clearsTheAgentBar(req, res)) {
      return res.status(403).json({
        error: OPERATOR_ONLY_TASK_ERROR,
        code: OPERATOR_ONLY_TASK_CODE,
        // Empty on purpose, and present on purpose: the other two refusal sites
        // on this router always send `fields`, so a caller that reads it should
        // not have to handle the key being missing here. Nothing was refused
        // FIELD-by-field — the whole action was — and an empty list says that.
        fields: [],
        message: OPERATOR_ONLY_TRIGGER_REFUSAL,
      });
    }

    const run = await scheduler.triggerManualRun(req.params.id);
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
