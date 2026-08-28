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
import { UpdateTaskRequestSchema, ListTaskRunsQuerySchema } from '@dorkos/shared/schemas';
import type { Task } from '@dorkos/shared/schemas';
import type { MeshCore } from '@dorkos/mesh';
import type { TaskStore } from '../services/tasks/task-store.js';
import type { TaskSchedulerService } from '../services/tasks/task-scheduler-service.js';
import type { TaskRegistrar } from '../services/tasks/task-registrar.js';
import { describeScheduleProblem } from '../services/tasks/cron-validation.js';
import { createScheduledTask } from '../services/tasks/lifecycle/create-task.js';
import { removeScheduledTaskFile } from '../services/tasks/lifecycle/delete-task.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import { writeSkillFile } from '@dorkos/skills/writer';
import { parseSkillFile } from '@dorkos/skills/parser';
import { SkillFrontmatterSchema } from '@dorkos/skills/schema';
import { loadTemplates } from '../services/tasks/task-templates.js';
import { parseBody, toErrorMessage } from '../lib/route-utils.js';
import { broadcastTasksChanged } from '../services/tasks/task-sse-events.js';
import { resolveDecisionAuthority } from '../services/core/approvals/index.js';
import { readCallerAuthority, requireOperatorCookieUnderLogin } from '../lib/caller-authority.js';
import { readCallerPrincipal } from '../lib/caller-principal.js';
import { getRequestAgentIdentity } from '../middleware/agent-identity.js';
import { resolveStanding } from '../services/notifications/notification-service.js';
import { raiseStanding } from '../services/notifications/standing-events.js';
import { resolveScheduleParkPayload } from '../services/notifications/emitters/schedule-park.js';
import { withProposerName, withProposerNames } from '../services/tasks/task-provenance.js';
import { clampSchedulePermissionMode } from '../services/tasks/schedule-permission-clamp.js';
import {
  describeOperatorOnlyTaskRefusal,
  findOperatorOnlyTaskFields,
  OPERATOR_ONLY_TASK_CODE,
  OPERATOR_ONLY_TASK_ERROR,
  OPERATOR_ONLY_TRIGGER_REFUSAL,
  refuseUnknownTaskUpdateFields,
} from '../services/tasks/task-write-policy.js';
import {
  describeArmBlocker,
  isPackageOwned,
  planTaskFileUpdate,
  pluginRoots,
  touchesFile,
} from '../services/tasks/task-file-update.js';
import fs from 'node:fs/promises';

/**
 * Whether this caller is trusted to arm a scheduled task itself — that is, to
 * skip the approval gate, un-clamp its power, and write the operator-only fields.
 * It composes the SAME two bars the approval, config, and extension-approval
 * routes do, and for the same reason: trust here must be POSITIVE, never the mere
 * ABSENCE of an agent marker.
 *
 * ## Two bars, checked together (DOR-1569)
 *
 * - **The cookie bar, under login-on only** ({@link requireOperatorCookieUnderLogin}).
 *   When login is on, `sessionGate` accepts a per-user API key as the same
 *   identity a browser cookie proves (DOR-474). An agent with shell access can
 *   read the operator's key off `~/.dork` and present it while dropping its
 *   `X-DorkOS-Agent` header, so an API key is NOT proof of a person. Only a
 *   session cookie is. This bar refuses every credential but a cookie while login
 *   is on, and — being the `...UnderLogin` half, not the full
 *   `requireOperatorCookie` — it ALLOWS with login off, so the shipped default
 *   posture is unchanged and the residual there stays the documented DOR-505 one.
 * - **The agent bar, in every posture** ({@link resolveDecisionAuthority}). A
 *   caller that names itself an agent, or holds an approval token, is refused.
 *
 * ## Why this replaced trust-by-absence, and what it costs
 *
 * It used to read `resolveDecisionAuthority(...).allowed` alone. Under login-on
 * that clears any valid credential, so an agent that read the operator's API key
 * off disk and dropped its header was trusted to un-clamp `bypassPermissions` and
 * arm a live cron with no approval — the DOR-1569 exploit, observed on a live
 * server. The one signal a header-stripping caller on loopback cannot fake is a
 * session cookie, so under login-on the cookie is now required, exactly as it is
 * to DECIDE an approval (whoever may decide may act without one).
 *
 * The cost is borne by the operator's own login-on CLI: `dorkos task create`
 * presents an API key and no cookie, so under login-on it now PROPOSES a task
 * (parked at `pending_approval`, clamped) for the operator to approve in the
 * cockpit, rather than arming it directly, and `dorkos task update` can no longer
 * set an operator-only field. That is the deliberate, conservative trade of a
 * security fix — an occasional extra approval, never a live full-power cron
 * nobody looked at. This is the DOR-553 question ("should an agent holding the
 * operator's key schedule unattended work?"), answered for tasks: no.
 *
 * @param req - The incoming request.
 * @param res - The response, for `sessionGate`'s resolved user.
 * @returns True only when a person is positively established — a session cookie
 *   under login-on, or the operator on the login-off local machine — with neither
 *   an agent identity nor an approval token presented.
 */
function clearsTheAgentBar(req: Request, res: Response): boolean {
  // The cookie bar first, mirroring `routes/config.ts`. Under login-off this is a
  // no-op (undefined); under login-on it refuses everything but a session cookie,
  // so a stolen API key never reaches the agent bar as "trusted".
  if (requireOperatorCookieUnderLogin(res, 'how a scheduled task runs') !== undefined) {
    return false;
  }
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
 * policy is skipped for a caller that clears {@link clearsTheAgentBar} — a person
 * positively established, with no agent identity and no approval token — and
 * applied to everyone else. That is exactly the shape `PATCH /api/config` uses for
 * operator-only settings. Under login-on that trust now requires a session cookie
 * (DOR-1569), so a per-user API key is refused here just as a named agent is.
 * Under the default `local-trust` posture, though, a caller with a shell can omit
 * every header and be indistinguishable from the cockpit, so this stops an agent
 * that follows the protocol, not an adversary already running as you — the
 * documented DOR-505 residual, closed only by turning login on.
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
 *   time — it decides whether the new task parks at `pending_approval`
 *   (`createScheduledTask`) — and asking twice would let the two uses disagree.
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

    // Everything from "is this a valid request" to "the cron job is running" lives
    // in `createScheduledTask`, because `tasks_create` on both MCP servers has to
    // do the identical thing and used to do a shorter, wrong version of it — a row
    // with no SKILL.md behind it (DOR-1568). What is left here is what is genuinely
    // this door's: who is asking, what the activity feed is told, and the response.
    const outcome = await createScheduledTask(
      { store, registrar, dorkHome, ...(meshCore && { meshCore }) },
      {
        input: req.body,
        trusted,
        // Stamped from the RESOLVED credential, never from the body:
        // `getRequestAgentIdentity` answers only for a caller that presented a
        // live token, so an unidentified one leaves this null and the approval
        // card honestly says it does not know who asked.
        proposal: { agentPath: getRequestAgentIdentity(res)?.agentPath ?? null },
      }
    );

    if (!outcome.ok) {
      return res.status(outcome.status).json({
        error: outcome.error,
        ...(outcome.code !== undefined && { code: outcome.code }),
        ...(outcome.details !== undefined && { details: outcome.details }),
      });
    }
    const schedule = outcome.task;

    activityService?.emit({
      actorType: 'user',
      actorLabel: 'You',
      category: 'tasks',
      eventType: 'tasks.task_created',
      resourceType: 'schedule',
      resourceId: schedule.id,
      resourceLabel: schedule.displayName ?? schedule.name,
      summary: `Created scheduled task ${schedule.displayName ?? schedule.name}`,
      linkPath: '/',
    });

    // Run times and the proposer's name are derived, not persisted on the row,
    // so they must be attached here the same way the list endpoint does —
    // otherwise a freshly created task reports none of them until the next list
    // fetch.
    return res.status(201).json(await present(schedule));
  });

  router.patch('/:id', async (req, res) => {
    const trusted = clearsTheAgentBar(req, res);
    if (refusedOperatorOnlyTaskWrite(req, res, trusted)) return;

    // Before `parseBody`, which is a non-strict `z.object` and therefore drops
    // anything it does not recognise WITHOUT saying so. A caller that sent
    // `agentId` was answered 200 with an unchanged task, which is a lie about its
    // own request (DOR-1568). Applied to every caller, operator included: a typo
    // in a field name should be loud on the cockpit's own edits too, and the
    // client only ever sends `UpdateTaskRequest` fields.
    const unknownFields = refuseUnknownTaskUpdateFields(req.body);
    if (unknownFields) return res.status(400).json(unknownFields);

    const data = parseBody(UpdateTaskRequestSchema, req.body, res);
    if (!data) return;

    const existing = store.getTask(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Scheduled task not found' });
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
    //
    // **A request that changes nothing in the file does not open the file.**
    // `touchesFile` is what makes that true, and it is load-bearing rather than
    // an optimisation: approving a parked schedule sends `status` alone, and
    // before DOR-1485's review every Approve dragged the person's own SKILL.md
    // through a read-merge-write it had no reason to touch — which is how a
    // click on Approve could erase the file's `schedule:` block.
    const arming = data.status === 'active' && existing.status === 'pending_approval';
    const changesFile = touchesFile(data, existing);
    if (existing.filePath && (changesFile || arming)) {
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

      // Arming is the one thing a person can ask for that the FILE can refuse.
      // A schedule whose block or cron DorkOS cannot read has nothing to run on,
      // so approving it would produce a row that says `active` and never fires,
      // with the complaint that explained why now gone from the card. Say what
      // is wrong instead, and leave the schedule parked where they can see it.
      if (arming && content !== null) {
        const blocker = describeArmBlocker(existing.filePath, content);
        if (blocker) {
          return res.status(409).json({
            error:
              `This schedule cannot be switched on yet: ${blocker} ` +
              `Fix it in ${existing.filePath} and DorkOS will pick the change up on its own.`,
            code: 'schedule_file_unreadable',
          });
        }
      }

      if (content !== null && changesFile) {
        // A file the skill schema cannot read is the silent-success defect
        // DOR-1481 closed: the route used to skip the write, update the row, and
        // answer 200. It refuses. (There was a second parse here, against the
        // legacy task schema, while both shapes were live; DOR-1486 left one.)
        const parsed = parseSkillFile(existing.filePath, content, SkillFrontmatterSchema);
        if (!parsed.ok) {
          return res.status(500).json({
            error: describeTaskFileFailure('parse', existing.filePath, parsed.error),
          });
        }

        // A skill an installed package owns is never ours to rewrite: the edit
        // would land in `.dork/plugins/`, be shared by every agent that
        // installed the package, and vanish at the next update.
        const owningProject = existing.agentId
          ? meshCore?.getProjectPath(existing.agentId)
          : undefined;
        if (
          await isPackageOwned(existing.filePath, pluginRoots(dorkHome, owningProject ?? undefined))
        ) {
          return res.status(409).json({
            error:
              `This schedule belongs to an installed package, so DorkOS did not change its ` +
              `file. You can switch it on or off here; to change what it does, edit the ` +
              `package or make your own copy of the skill.`,
            code: 'schedule_package_owned',
          });
        }

        const plan = planTaskFileUpdate(existing.filePath, content, data, data.prompt);
        if (plan.kind === 'refuse') {
          return res.status(409).json({ error: plan.message, code: 'schedule_file_unreadable' });
        }

        const dirPath = path.dirname(existing.filePath);
        try {
          await writeSkillFile(
            path.dirname(dirPath),
            path.basename(dirPath),
            plan.frontmatter,
            plan.body
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
      return res.status(404).json({ error: 'Scheduled task not found' });
    }

    // **Re-assert the status the caller asked for.** The file is written before
    // the row, and a watcher event landing in that gap syncs the NEW file
    // against the OLD row: the content key has changed, so the arm gate parks
    // the row — and then this update writes the rest of the caller's fields over
    // a row that is now `pending_approval`, leaving a schedule the person just
    // edited parked with nothing anywhere saying why (DOR-1485 review, I2).
    //
    // `updateTask` cannot fix this on its own: it only lifts `paused`, because
    // `pending_approval` is deliberately a person's gate to clear. Here we know
    // a person IS the caller and exactly what they asked for, so re-stating it
    // is not overriding the gate — it is finishing the write that opened it.
    // The status the caller is entitled to end up at: the one they asked for,
    // or — when they only edited fields and the schedule was already live — the
    // one it already had. The second half is the case a first pass missed: the
    // cockpit's edit form sends a prompt and no `status`, so a lost race
    // disarmed a running schedule with nothing anywhere saying why.
    const intendedStatus =
      data.status ?? (changesFile && existing.status === 'active' ? 'active' : undefined);
    if (intendedStatus !== undefined && updated.status !== intendedStatus) {
      updated = store.updateTask(req.params.id, { status: intendedStatus }) ?? updated;
    }

    // **A person editing their own live schedule re-approves it.**
    //
    // The grant is keyed on the schedule's content, so any edit to what it does
    // or when it runs invalidates it. Without this line the cockpit's ordinary
    // edit — change the prompt, save — left a live schedule holding a grant for
    // content that no longer existed, and the next sync within five minutes
    // parked it with "this file changed since it was last approved". The person
    // is the one who changed it, and they are standing right there.
    //
    // **Here and not in `updateTask`, deliberately.** `prompt` and `cron` are
    // agent-writable (`task-write-policy.ts`); only `status` is operator-only.
    // Re-keying on every content write would therefore let an agent rewrite an
    // approved schedule and carry its approval across — which is precisely the
    // substitution the bypass clamp exists to refuse, reintroduced one layer up.
    // So the grant is re-issued only for a caller that cleared the agent bar. An
    // agent's edit still re-parks, and a person still has to look at it.
    if (trusted && changesFile && existing.status === 'active' && updated.status === 'active') {
      store.recordApproval(updated.id);
      updated = store.getTask(updated.id) ?? updated;
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
        summary: `Paused scheduled task ${updated.displayName ?? updated.name}`,
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
      raiseStanding('schedule.parked', await resolveScheduleParkPayload(updated));
    }

    broadcastTasksChanged();

    return res.json(await present(updated));
  });

  router.delete('/:id', async (req, res) => {
    // Deleting a schedule is never a power-grant, so this is nuisance/DoS
    // protection, not the operator bar the create/update path runs: under
    // login-on a caller holding a per-user API key but no session cookie must
    // not be able to remove a person's schedule on their behalf. Asked first,
    // before the 404 below, so a barred caller cannot even probe which schedules
    // exist. Under the default login-off posture this is a no-op — the accepted
    // DOR-505 residual, where a credential-free loopback request is
    // indistinguishable from the cockpit — exactly as it is everywhere
    // `requireOperatorCookieUnderLogin` runs.
    const cookieRefusal = requireOperatorCookieUnderLogin(res, 'delete a scheduled task');
    if (cookieRefusal) {
      return res.status(cookieRefusal.status).json({
        error: 'Only a person signed in to DorkOS can delete a scheduled task',
        code: cookieRefusal.code,
      });
    }

    const { id } = req.params;
    const schedule = store.getTask(id);
    if (!schedule) {
      return res.status(404).json({ error: 'Scheduled task not found' });
    }

    // The file goes first, through the seam `tasks_delete` shares: a row deleted
    // while its SKILL.md remains is brought straight back by the next reconcile.
    await removeScheduledTaskFile(schedule.filePath);

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
      summary: `Deleted scheduled task ${schedule.displayName ?? schedule.name}`,
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
      return res.status(404).json({ error: 'Scheduled task not found' });
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
    // Cancelling a run is never a power-grant either, so — like DELETE above —
    // this is nuisance/DoS protection: under login-on a caller with an API key
    // but no session cookie must not be able to stop a person's run for them.
    // Asked before the run is looked up. A no-op under login-off (the DOR-505
    // residual), so the shipped default posture is unchanged.
    const cookieRefusal = requireOperatorCookieUnderLogin(res, 'cancel a scheduled run');
    if (cookieRefusal) {
      return res.status(cookieRefusal.status).json({
        error: 'Only a person signed in to DorkOS can cancel a scheduled run',
        code: cookieRefusal.code,
      });
    }

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
