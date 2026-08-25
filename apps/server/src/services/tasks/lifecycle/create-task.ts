/**
 * Making a scheduled task: the file first, then the row it derives.
 *
 * ## Why this is a service and not two copies of a route handler
 *
 * A scheduled task is a SKILL.md on disk with a derived row in SQLite, and the
 * order matters: the file is the source of truth, the row is a cache the watcher
 * and the reconciler rebuild from it. Any writer that creates the row without the
 * file makes an ORPHAN — a task no SKILL.md backs, which the reconciler skips,
 * which no agent owns, and which runs in whatever directory the server happens to
 * be sitting in. That is exactly what `tasks_create` produced before DOR-1568:
 * `filePath: ''` and `agentId: null`, reported to the agent as a success.
 *
 * `POST /api/tasks` had the create sequence right and the MCP tool had its own,
 * shorter, wrong one. Two doors onto one invariant is one door too many, so the
 * sequence lives here and both doors call it. What stays with each caller is only
 * what genuinely differs: how it validates its own arguments, what it writes to
 * the activity feed (a person created this vs. an agent proposed it), and how it
 * shapes its reply.
 *
 * @module services/tasks/lifecycle/create-task
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { z } from 'zod';
import { CreateTaskRequestSchema } from '@dorkos/shared/schemas';
import type { CreateTaskInput, Task } from '@dorkos/shared/schemas';
import type { MeshCore } from '@dorkos/mesh';
import { writeSkillFile } from '@dorkos/skills/writer';
import { parseSkillFile } from '@dorkos/skills/parser';
import { SkillFrontmatterSchema } from '@dorkos/skills/schema';
import { slugify, validateSlug } from '@dorkos/skills/slug';
import { parseDuration } from '@dorkos/skills/duration';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { RESERVED_TASK_DIRNAMES } from '../task-templates.js';
import { agentSkillsRoot, globalSkillsRoot, resolveRootPath } from '../skills-roots.js';
import { readScheduleFromSkill } from '../skills-root-discovery.js';
import { describeScheduleProblem } from '../cron-validation.js';
import { clampSchedulePermissionMode } from '../schedule-permission-clamp.js';
import { resolveScheduledRunPermissionMode } from '../scheduled-run-power.js';
import { planTaskFileCreate } from '../task-file-update.js';
import { broadcastTasksChanged } from '../task-sse-events.js';
import type { TaskStore } from '../task-store.js';
import type { TaskRegistrar } from '../task-registrar.js';
import { armEscalation } from '../../notifications/escalation-service.js';
import { resolveScheduleParkPayload } from '../../notifications/emitters/schedule-park.js';
import type { NotificationPayload } from '../../notifications/notification-registry.js';

/** The collaborators a create needs. Every one of them is required to get a task right. */
export interface TaskLifecycleDeps {
  /** Where the derived row is written. */
  store: TaskStore;
  /**
   * The one seam that turns a row into a live cron job — shared with the watcher
   * and the reconciler. Null before the scheduler exists, and during boot, which
   * is not a reason to fail a create.
   */
  registrar: TaskRegistrar | null;
  /** The resolved data directory, for the `global` skills root. */
  dorkHome: string;
  /** Resolves an agent id to its project path. Absent when Mesh is disabled. */
  meshCore?: MeshCore;
}

/** Who proposed a task, stamped onto the row when the task parks. */
export interface TaskProposal {
  /** The proposing session, when an agent proposed through an in-session tool. */
  sessionId?: string | null;
  /** The proposing agent's working directory — the key its display name resolves from. */
  agentPath?: string | null;
}

/** What {@link createScheduledTask} is asked to make. */
export interface CreateScheduledTaskOptions {
  /**
   * The caller's request, UNVALIDATED. Parsed here against
   * `CreateTaskRequestSchema` so both doors accept exactly the same shape — a
   * field one door validates more loosely than the other is how a body that the
   * request schema allowed produced a file the frontmatter schema rejected
   * (DOR-1432).
   */
  input: CreateTaskInput;
  /**
   * Whether the caller cleared the agent bar. A caller that did not is
   * PROPOSING: the task parks at `pending_approval`, it must say why, and it
   * cannot name its own permission mode.
   */
  trusted: boolean;
  /** Who to credit the proposal to. Ignored for a trusted caller — nobody proposed it. */
  proposal?: TaskProposal;
}

/** A create that did not happen, and what to tell the caller. */
export interface CreateScheduledTaskRefusal {
  ok: false;
  /** The HTTP status this maps to. MCP callers only use it to pick their wording. */
  status: 400 | 409 | 500;
  /** One line, written for whoever reads it. */
  error: string;
  /** A machine-readable code, on the refusals that carry one. */
  code?: string;
  /** Zod's flattened issues, on a schema refusal. */
  details?: unknown;
}

/** A create that happened. */
export interface CreateScheduledTaskSuccess {
  ok: true;
  /** The task as it now stands, file written and row synced. */
  task: Task;
  /** Whether it is waiting for a person. True for every untrusted caller. */
  parked: boolean;
  /**
   * The parked schedule's notification payload, present exactly when
   * {@link CreateScheduledTaskSuccess.parked} is. Returned rather than recomputed
   * by the caller so the activity feed names the proposer from the SAME answer
   * the notification used, and the two cannot disagree about who asked.
   */
  parkPayload?: NotificationPayload<'schedule.parked'>;
}

/** The outcome of a create. */
export type CreateScheduledTaskOutcome = CreateScheduledTaskSuccess | CreateScheduledTaskRefusal;

/**
 * What a caller is told when its task must be approved but says nothing about why.
 *
 * One sentence for both doors. The person reading the approval card has only this
 * to go on, so a blank reason is the same non-answer as no reason at all — and it
 * is refused BEFORE anything is written, so a reasonless proposal never lands on
 * disk for a person to find with nothing to read.
 */
const MISSING_REASON_MESSAGE =
  'A task that has to be approved needs a reason. Say why this schedule should exist, in your ' +
  'own words — whoever approves it has only that to go on.';

/** What a caller is told when Mesh cannot say where an agent's files live. */
const NO_MESH_MESSAGE = 'Cannot resolve agent — mesh not available';

/**
 * Where a new task's SKILL.md goes, and which agent owns it.
 *
 * @param target - `global`, or a registered agent's id.
 * @param deps - The lifecycle collaborators.
 * @returns The resolved home, or a refusal naming what could not be resolved.
 */
function resolveTaskHome(
  target: string,
  deps: TaskLifecycleDeps
):
  | { ok: true; skillsDir: string; agentId: string | null; projectPath?: string }
  | CreateScheduledTaskRefusal {
  if (target === 'global') {
    return { ok: true, skillsDir: globalSkillsRoot(deps.dorkHome), agentId: null };
  }
  if (!deps.meshCore) {
    return { ok: false, status: 400, error: NO_MESH_MESSAGE };
  }
  const projectPath = deps.meshCore.getProjectPath(target);
  if (!projectPath) {
    return { ok: false, status: 400, error: `Agent ${target} not found in registry` };
  }
  return { ok: true, skillsDir: agentSkillsRoot(projectPath), agentId: target, projectPath };
}

/**
 * Create a scheduled task: validate it, write its SKILL.md, derive its row, park
 * it if the caller cannot arm it, and put it on the clock.
 *
 * **The file is written before the row, always.** A row with no file behind it is
 * an orphan: nothing reconciles it, no agent owns it, and its runs happen in the
 * server's own working directory. There is no branch here that skips the file.
 *
 * @param deps - Store, registrar, data directory, and Mesh.
 * @param options - The request, the caller's trust, and who is proposing.
 * @returns The created task, or a refusal that wrote nothing.
 */
export async function createScheduledTask(
  deps: TaskLifecycleDeps,
  options: CreateScheduledTaskOptions
): Promise<CreateScheduledTaskOutcome> {
  const parsed = CreateTaskRequestSchema.safeParse(options.input);
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      error: 'Validation failed',
      details: z.flattenError(parsed.error),
    };
  }
  const data = parsed.data;
  const { trusted } = options;

  // Asked before ANY write, because the file is written first and never
  // withdrawn: a cron or timezone croner cannot read would otherwise leave a
  // permanent SKILL.md on disk backing a row that can never be scheduled. The
  // question cannot be asked in `CreateTaskRequestSchema` — only croner knows the
  // answer and `@dorkos/shared` cannot depend on it; see `cron-validation.ts`.
  const scheduleProblem = describeScheduleProblem(data.cron, data.timezone);
  if (scheduleProblem) return { ok: false, status: 400, error: scheduleProblem };

  // How much power this schedule's runs get, resolved ONCE (spec
  // `full-power-defaults`, D6). A caller that named a mode keeps it verbatim; one
  // that named none gets the operator's own trust stop, mapped through the runtime
  // the scheduler drives, and `acceptEdits` when no stop is configured.
  const permissionMode = data.permissionMode ?? resolveScheduledRunPermissionMode();

  // …and clamped ONCE, for every caller that did not clear the agent bar. This is
  // the value written to the file AND inserted into the row; the explicit un-clamp
  // at the end is the only thing that lifts it, and only for a trusted caller.
  // Both row paths below are covered by clamping here rather than on one of them:
  // which path runs depends on whether the file we just wrote parses back, and a
  // caller could choose that (DOR-1432).
  const effectivePermissionMode = trusted
    ? permissionMode
    : clampSchedulePermissionMode(permissionMode).mode;

  // A task this caller cannot arm itself is a PROPOSAL, and a proposal has to make
  // its own case (DOR-1394). Asked here rather than in the schema because it
  // depends on WHO is asking.
  const proposedReason = data.reason?.trim();
  if (!trusted && !proposedReason) {
    return { ok: false, status: 400, error: MISSING_REASON_MESSAGE };
  }

  // A name that slugifies to something the SKILL.md name rule rejects — most
  // easily the empty string, which `'!!!'` produces. Refused on the DERIVED slug,
  // which is why it cannot live in the request schema.
  const slug = slugify(data.name);
  if (!validateSlug(slug)) {
    return {
      ok: false,
      status: 400,
      error: `"${data.name}" has no usable name in it. Use letters or numbers — "Nightly sweep" becomes "nightly-sweep".`,
    };
  }

  // `templates/` is a container the tasks system owns. A row pointing into it is
  // worse than useless: the reconciler skips reserved names, so nothing re-syncs
  // it, and deleting the task would take every template with it.
  if (RESERVED_TASK_DIRNAMES.includes(slug)) {
    return {
      ok: false,
      status: 400,
      error: `"${slug}" is a reserved name in the tasks folder. Pick a different name.`,
    };
  }

  const home = resolveTaskHome(data.target, deps);
  if (!home.ok) return home;

  const existingPath = path.join(home.skillsDir, slug, SKILL_FILENAME);
  try {
    await fs.access(existingPath);
    return {
      ok: false,
      status: 409,
      error: `Task "${slug}" already exists in target directory`,
    };
  } catch {
    // Nothing there — good.
  }

  // Built through the same planner the update path uses, so create and update
  // cannot disagree about the shape of a schedule file. Anything already at its
  // default is left out rather than written as a line the person never typed.
  const plan = planTaskFileCreate(
    { name: slug, description: data.description },
    {
      displayName: data.displayName || undefined,
      cron: data.cron || undefined,
      timezone: data.timezone || undefined,
      // Only a schedule the caller turned OFF says so in the file — the block's
      // own default is `enabled: true`.
      enabled: data.enabled === false ? false : undefined,
      maxRuntime: data.maxRuntime || undefined,
      // The CLAMPED mode, so the file and the row agree. A SKILL.md declaring more
      // power than its row holds is a standing request from disk that nobody made
      // and no screen shows.
      permissionMode: effectivePermissionMode || undefined,
    }
  );
  if (plan.kind === 'refuse') return { ok: false, status: 400, error: plan.message };

  let filePath: string;
  try {
    filePath = await writeSkillFile(home.skillsDir, slug, plan.frontmatter, data.prompt);
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error:
        `DorkOS could not save this task's file under ${home.skillsDir}, so nothing was ` +
        `created: ${err instanceof Error ? err.message : 'the disk gave no reason'}. Check who ` +
        `is allowed to write there and how much space is left on the disk, then try again.`,
    };
  }

  // Sync to the row through the SAME reader discovery uses. The row's identity is
  // the file's REAL path: the watcher resolves symlinks before keying its row, and
  // a create that stored the unresolved path would leave two rows for one file on
  // any machine whose data directory sits under a symlink.
  const content = await fs.readFile(filePath, 'utf-8');
  const parsedFile = parseSkillFile(filePath, content, SkillFrontmatterSchema);
  const discovered = parsedFile.ok
    ? readScheduleFromSkill(parsedFile.definition, {
        scope: data.target === 'global' ? 'global' : 'project',
        ...(home.projectPath ? { projectPath: home.projectPath } : {}),
        resolvedPath: path.join(await resolveRootPath(home.skillsDir), slug, SKILL_FILENAME),
      })
    : null;

  let schedule: Task;
  if (discovered) {
    schedule = deps.store.upsertFromFile(discovered.def, home.agentId ?? undefined);
  } else {
    // Fallback: create the row directly. NOT a file path, so it gets none of
    // `upsertFromFile`'s clamping — which is why the mode handed in was clamped at
    // the resolution above. Do not put the raw `permissionMode` back into this call.
    schedule = deps.store.createTask({
      name: slug,
      ...(data.displayName !== undefined && { displayName: data.displayName }),
      description: data.description,
      prompt: data.prompt,
      ...(data.cron !== undefined && { cron: data.cron }),
      ...(data.timezone !== undefined && { timezone: data.timezone }),
      agentId: home.agentId,
      enabled: data.enabled,
      maxRuntime: data.maxRuntime ? parseDuration(data.maxRuntime) : null,
      permissionMode: effectivePermissionMode,
      filePath,
    });
  }

  // The ONE un-clamp, after BOTH branches, because both need the same patch and
  // two copies of a security exception are two chances to fix only one of them.
  if (trusted && permissionMode === 'bypassPermissions') {
    schedule = deps.store.updateTask(schedule.id, { permissionMode: 'bypassPermissions' })!;
  }

  // Both row paths hardcode `status: 'active'`, so parking is a patch after the
  // fact. It has to happen BEFORE the register below, or the task fires while it
  // is still waiting to be approved.
  let parkPayload: NotificationPayload<'schedule.parked'> | undefined;
  if (!trusted) {
    deps.store.updateTask(schedule.id, { status: 'pending_approval' });
    // Stamped from what the SERVER resolved, never from the body: a caller that
    // could name its own agent path could credit its proposal to any agent the
    // operator trusts.
    deps.store.recordProposal(schedule.id, {
      reason: proposedReason ?? null,
      ...(options.proposal?.sessionId !== undefined && {
        proposedBySessionId: options.proposal.sessionId,
      }),
      ...(options.proposal?.agentPath !== undefined && {
        proposedByAgentPath: options.proposal.agentPath,
      }),
    });
    schedule = deps.store.getTask(schedule.id)!;
    // The escalation clock starts here (DOR-1387). Parked schedules have no
    // observer seam, so the hook lands at the write that parks one.
    parkPayload = await resolveScheduleParkPayload(schedule);
    armEscalation('schedule.parked', parkPayload);
  }

  // Through the registrar, not the scheduler directly: the same seam the watcher
  // and the reconciler use, so a task created here and a task created by dropping
  // a SKILL.md on disk end up in exactly the same state.
  deps.registrar?.syncTask(schedule.id);

  // Signalled here rather than by each caller, so a door that forgets it cannot
  // exist: without this the Tasks list shows nothing until the next full refetch.
  broadcastTasksChanged();

  return { ok: true, task: schedule, parked: !trusted, ...(parkPayload && { parkPayload }) };
}
