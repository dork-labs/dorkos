/**
 * The `tasks_*` tool handlers, shared by both MCP servers — the in-session
 * `dorkos` server ({@link getTasksTools}, below) and the external `/mcp` server
 * (`core/external-mcp/task-tools.ts`, which registers these same factories).
 *
 * Writing the guard here rather than at each registration is the point: there are
 * two registration sites and one set of handlers, so a control on the handler
 * covers both servers by construction and cannot be added to one and forgotten on
 * the other.
 *
 * @module services/runtimes/claude-code/mcp-tools/task-tools
 */
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { TaskNameSchema, TASK_DURATION_PATTERN } from '@dorkos/shared/schemas';
import type { UpdateTaskRequest } from '@dorkos/shared/types';
import { slugify, validateSlug } from '@dorkos/skills/slug';
import type { McpToolDeps } from './types.js';
import { jsonContent, structuredJsonContent } from './types.js';
import { clampSchedulePermissionMode } from '../../../tasks/schedule-permission-clamp.js';
import {
  describeOperatorOnlyTaskRefusal,
  findOperatorOnlyTaskFields,
  OPERATOR_ONLY_TASK_CODE,
  OPERATOR_ONLY_TASK_ERROR,
} from '../../../tasks/task-write-policy.js';
import { broadcastTasksChanged } from '../../../tasks/task-sse-events.js';
import { armEscalation } from '../../../notifications/escalation-service.js';
import {
  resolveParkedScheduleRemoved,
  resolveScheduleParkPayload,
} from '../../../notifications/emitters/schedule-park.js';

/**
 * Who is proposing a schedule, read at CALL time rather than at registration.
 *
 * Both fields are resolved lazily and for the same reason: the SDK rekeys a
 * session to its canonical id mid-first-turn, so an id captured when the tool
 * server was built names a session that no longer exists. The DevTools tools
 * resolve their session id late for exactly this reason — see
 * `mcp-tools/index.ts`.
 *
 * Absent entirely on the sessionless external `/mcp` server, where there is no
 * session to attribute a proposal to and provenance stays null.
 */
export type TaskProvenanceResolver = () => {
  /** The invoking session's canonical id. */
  sessionId?: string;
  /**
   * The invoking session's working directory, which is the key agent identity
   * is stored under (`agent-identity/agent-token-env.ts`) — so this is what
   * later resolves the proposer's name.
   */
  agentPath?: string;
};

/** What `tasks_create` tells an agent that gave no reason. */
export const MISSING_REASON_ERROR =
  'A scheduled task needs a reason. Say why this schedule should exist, in your own words — ' +
  'the person reading the approval has only what you write here to decide on.';

/**
 * The `maxRuntime` argument, validated to the shape the SKILL.md frontmatter
 * accepts — the MCP twin of the same fix on `UpdateTaskRequestSchema` (DOR-1481).
 *
 * `tasks_update` passes this straight through to the store, where
 * `parseDuration` turns anything it cannot read into `0` — which removes the
 * run's time limit rather than rejecting the call — and the same string written
 * into the file makes the file unreadable to every later sync. `tasks_create`
 * accepts and ignores the argument (see the module note below), but it is
 * validated on both so the two tools cannot disagree about what a duration is.
 */
const DURATION_ARG = z.string().min(1).regex(TASK_DURATION_PATTERN).optional();

/** The description `tasks_create` gives the `reason` argument. */
export const REASON_DESCRIPTION =
  'Why this schedule should exist, in your own words — the operator reads this to decide.';

/** Guard that returns an error response when Tasks is disabled. */
function requireTasks(deps: McpToolDeps) {
  if (!deps.taskStore) {
    return jsonContent({ error: 'Tasks scheduler is not enabled' }, true);
  }
  return null;
}

/**
 * The description both servers give the `permissionMode` argument (DOR-504).
 *
 * The argument stays ADVERTISED on purpose, and it is worth being explicit about
 * why, because deleting it looks tidier and is worse. The MCP SDK parses a call
 * against the advertised schema before the handler runs, so an argument this
 * schema does not declare is STRIPPED on the way in — the agent's other fields
 * would land, its `permissionMode` would evaporate, and it would be told the
 * whole call succeeded. That is the silent partial write this guard exists to
 * prevent. Declaring the argument is what lets the handler see it and refuse the
 * call whole, naming the field.
 *
 * So the field no longer lies about what it does: it says it is refused, and it
 * is refused, on both tools and both servers.
 */
export const REFUSED_PERMISSION_MODE_DESCRIPTION =
  'Not yours to set. A scheduled task runs later with nobody watching, so the person chooses ' +
  'how much it may do without asking. Send this and DorkOS refuses the whole call and changes ' +
  'nothing — leave it out, and ask the person to set it on the task in DorkOS.';

/**
 * The description both servers give the `status` argument (DOR-504).
 *
 * Declared for exactly the reason {@link REFUSED_PERMISSION_MODE_DESCRIPTION} is,
 * and it was missed on the first pass: `status` was operator-only in the policy
 * but absent from this tool's schema, so the SDK stripped it and the call
 * reported SUCCESS with the rest of the fields applied. Nothing could reach the
 * store either way, so it was never an escalation — but "we refuse the call
 * whole" has to be true of every operator-only field, or the sentence is not
 * worth anything on the ones where it matters.
 *
 * On BOTH tools, including `tasks_create`, where `status` is not a meaningful
 * argument at all (the store hardcodes it, then the handler parks it). Declaring
 * it there anyway is not padding: the seeded `scheduling-tasks` skill tells agents
 * DorkOS refuses the whole call for either field on either tool, and a field that
 * is silently stripped instead makes that sentence false. The alternative was to
 * narrow the sentence to one tool-and-field pairing, which is a rule nobody will
 * hold in their head. The text below reads for both, and at create time it is the
 * best moment to say a new task waits for approval.
 */
export const REFUSED_STATUS_DESCRIPTION =
  'Not yours to set. Moving a task to `active` IS the person approving it, and a task you ' +
  'create waits at `pending_approval` until they do. Send this and DorkOS refuses the whole ' +
  'call and changes nothing — tell the person the task is waiting, and let them approve it in ' +
  'DorkOS. To turn an already-approved task on or off, use `enabled` instead.';

/**
 * Refuse a task write that reaches for a field only a person may set, or return
 * `null` to let the call proceed.
 *
 * Unconditional, and that is the design rather than an omission. The wrong shape
 * here would be "refuse when the caller presented an agent identity", because
 * then omitting a header would be the bypass — the exact inversion
 * `approvals/decision-authority.ts` was rewritten to remove. An MCP tool call IS
 * the agent surface, so the proof is structural: there is no header involved and
 * nothing to strip. `operator-tool-handlers.ts` refuses operator-only config
 * paths the same way, for the same reason.
 *
 * The refusal is WHOLE. Nothing is written, including the fields the caller was
 * allowed to send, so a caller is never told a change landed when part of it did
 * not.
 *
 * @param args - The arguments the SDK parsed for this call.
 * @returns The refusal envelope, or `null` when the call may proceed.
 */
function refuseOperatorOnlyTaskFields(args: unknown) {
  const operatorOnly = findOperatorOnlyTaskFields(args);
  if (operatorOnly.length === 0) return null;
  return jsonContent(
    {
      error: OPERATOR_ONLY_TASK_ERROR,
      code: OPERATOR_ONLY_TASK_CODE,
      fields: operatorOnly,
      message: describeOperatorOnlyTaskRefusal(operatorOnly),
    },
    true
  );
}

/** List all Tasks scheduled jobs. */
export function createListSchedulesHandler(deps: McpToolDeps) {
  return async (args: { enabled_only?: boolean }) => {
    const err = requireTasks(deps);
    if (err) return err;
    let schedules = deps.taskStore!.getTasks();
    if (args.enabled_only) {
      schedules = schedules.filter((s) => s.enabled);
    }
    return structuredJsonContent({ schedules, count: schedules.length });
  };
}

/**
 * Create a new scheduled job — always sets status to pending_approval.
 *
 * `maxRuntime` is accepted and ignored: the store call below hardcodes `null`,
 * and a run-time cap is set with `tasks_update` instead (the seeded
 * `scheduling-tasks` skill already says so). That is a separate, non-security
 * loose end from DOR-504 and is deliberately left as it is here.
 */
export function createCreateScheduleHandler(
  deps: McpToolDeps,
  resolveProvenance?: TaskProvenanceResolver
) {
  return async (args: {
    name: string;
    prompt: string;
    cron: string;
    reason: string;
    description?: string;
    timezone?: string;
    maxRuntime?: string;
    /** Advertised so it can be REFUSED; see {@link refuseOperatorOnlyTaskFields}. */
    permissionMode?: string;
    /** Advertised so it can be REFUSED; see {@link REFUSED_STATUS_DESCRIPTION}. */
    status?: string;
  }) => {
    const err = requireTasks(deps);
    if (err) return err;
    const refusal = refuseOperatorOnlyTaskFields(args);
    if (refusal) return refusal;

    // Asked here as well as in the schema, because the schema cannot ask it
    // properly: `z.string()` is satisfied by `''`, and a blank reason is the
    // same non-answer as no reason at all to whoever has to decide. Refused
    // before the write, so a reasonless proposal never parks somewhere for a
    // person to find with nothing to read.
    const reason = args.reason?.trim();
    if (!reason) return jsonContent({ error: MISSING_REASON_ERROR }, true);

    // Mirror the REST create path (routes/tasks.ts): the name becomes a SKILL.md
    // slug, and a name with no usable slug in it is refused. A scheduled run is
    // told `Job: ${task.name}` in its system prompt (`services/tasks/task-append.ts`),
    // so a raw, unbounded name was a prompt-injection primitive on this surface
    // too — `tasks_update.name` already carries the slug rule through `TaskNameSchema`,
    // and this bounds the create door the same way. Slugified rather than rejected
    // outright, exactly as REST does, so "Nightly sweep" still works and only a
    // name with nothing usable in it (e.g. "!!!") is turned away.
    const slug = slugify(args.name);
    if (!validateSlug(slug)) {
      return jsonContent(
        {
          error: `"${args.name}" has no usable name in it. Use letters or numbers — "Nightly sweep" becomes "nightly-sweep".`,
        },
        true
      );
    }

    // Resolved now, not when this handler was built: the SDK rekeys a session
    // to its canonical id mid-first-turn (see {@link TaskProvenanceResolver}).
    const provenance = resolveProvenance?.() ?? {};

    const schedule = deps.taskStore!.createTask({
      name: slug,
      description: args.description ?? slug,
      prompt: args.prompt,
      cron: args.cron,
      timezone: args.timezone ?? null,
      maxRuntime: null,
      filePath: '',
      reason,
      proposedBySessionId: provenance.sessionId ?? null,
      proposedByAgentPath: provenance.agentPath ?? null,
    });
    // The escalation clock starts here (DOR-1387). Parked schedules have no
    // observer seam, so the hook lands at the write that parks one. Still
    // nothing RAISED at this edge: `schedule.parked` is a STANDING kind, which
    // stores nothing while it stands (ADR 260819-234828), and its two
    // resolutions are recorded where the operator decides them — which is also
    // where the timer is disarmed, through `resolveStanding`.
    // Agent-created schedules always require user approval
    deps.taskStore!.updateTask(schedule.id, { status: 'pending_approval' });
    const updated = deps.taskStore!.getTask(schedule.id);

    // One block, not two, so `parked` is genuinely non-optional inside it: the
    // payload exists exactly when `updated` does, and splitting them forced a
    // `?? 'An agent'` fallback below that could never run but read as if it
    // might (DOR-1394 review).
    if (updated) {
      const parked = await resolveScheduleParkPayload(updated);
      armEscalation('schedule.parked', parked);

      // Parity with the REST route's create handler (routes/tasks.ts): without
      // this, a schedule an agent proposes is invisible until the next full
      // list refetch, with no SSE and no activity entry to tell the person it
      // is waiting on them. `metadata.status` carries the parked state into the
      // feed so a consumer can tell this apart from an operator's own
      // (immediately active) creation without a second lookup.
      //
      // Attributed the same way `capability-gate-audit.ts` attributes its
      // agent-actor events: by the agent's project path. The in-session server
      // now knows it (`resolveProvenance`, DOR-1394), so the feed can name the
      // proposer instead of saying "an agent" — and it names it from the SAME
      // resolved payload the notification uses, so the two cannot disagree
      // about who asked. The sessionless external `/mcp` server carries no
      // session, so `parked.proposedBy` falls back to "An agent" there and no
      // `actorId` is attached, exactly as before.
      deps.activityService?.emit({
        actorType: 'agent',
        actorLabel: parked.proposedBy,
        ...(provenance.agentPath ? { actorId: provenance.agentPath } : {}),
        category: 'tasks',
        eventType: 'tasks.task_created',
        resourceType: 'schedule',
        resourceId: updated.id,
        resourceLabel: updated.displayName ?? updated.name,
        summary: `Proposed task ${updated.displayName ?? updated.name}, which needs your approval before it runs`,
        linkPath: '/',
        metadata: { status: updated.status },
      });
      broadcastTasksChanged();
    }

    return jsonContent({
      schedule: updated,
      note: 'Schedule created with pending_approval status. User must approve before it runs.',
    });
  };
}

/** Update an existing schedule. */
export function createUpdateScheduleHandler(deps: McpToolDeps) {
  return async (args: {
    id: string;
    name?: string;
    prompt?: string;
    cron?: string;
    enabled?: boolean;
    timezone?: string;
    maxRuntime?: string;
    /** Advertised so it can be REFUSED; see {@link refuseOperatorOnlyTaskFields}. */
    permissionMode?: string;
    /** Advertised so it can be REFUSED; see {@link REFUSED_STATUS_DESCRIPTION}. */
    status?: string;
  }) => {
    const err = requireTasks(deps);
    if (err) return err;
    const refusal = refuseOperatorOnlyTaskFields(args);
    if (refusal) return refusal;

    // Read the row BEFORE the write, both to answer 404 the same way this handler
    // always has and — below — to decide whether this edit changes the work a
    // person approved.
    const existing = deps.taskStore!.getTask(args.id);
    if (!existing) return jsonContent({ error: `Schedule ${args.id} not found` }, true);

    // The patch is assembled field by field rather than spread from the rest of
    // `args`, so there is no code here that could carry `permissionMode` to the
    // store even if the guard above were removed. The spread this replaces is how
    // the field reached the store in the first place: it forwarded whatever the
    // tool schema happened to declare, and it also cast a bare `z.string()`
    // straight into the permission-mode enum without validating it. A new
    // agent-writable field now has to be added in both places, which is the
    // trade: a forgotten field is a visible bug, a forwarded one was a hole.
    const patch: UpdateTaskRequest = {
      ...(args.name !== undefined && { name: args.name }),
      ...(args.prompt !== undefined && { prompt: args.prompt }),
      ...(args.cron !== undefined && { cron: args.cron }),
      ...(args.enabled !== undefined && { enabled: args.enabled }),
      ...(args.timezone !== undefined && { timezone: args.timezone }),
      ...(args.maxRuntime !== undefined && { maxRuntime: args.maxRuntime }),
    };

    // A non-trusted caller cannot KEEP an approved task's `bypassPermissions` by
    // rewriting the work it does — the same escalation `PATCH /api/tasks/:id`
    // clamps (routes/tasks.ts), routed through the SAME seam
    // (`clampSchedulePermissionMode`) so the two agent doors cannot drift.
    //
    // On this surface the caller is ALWAYS the non-trusted case: an MCP tool call
    // IS the agent surface, so there is no operator branch to spare (the reasoning
    // `refuseOperatorOnlyTaskFields` states unconditionally, one level up). And
    // this handler writes the ROW ONLY — it never rewrites the SKILL.md, so the
    // file-watcher never fires and the reconciler's `keepsApprovedBypass` clamp is
    // up to five minutes away. Until that resync the row sat at
    // `bypassPermissions` holding the NEW prompt/cron/name, and a cron firing in
    // that window dispatched an agent's instructions at full power. Clamping the
    // row here makes the drop immediate, closing the window; the edit itself still
    // lands (prompt/cron/name are agent-writable), the unattended run just gets its
    // approval prompts back.
    //
    // `name` belongs beside prompt and cron because it is not inert: a scheduled
    // run is told `Job: ${task.name}` in its system prompt
    // (`services/tasks/task-append.ts`), so a rename changes what the unattended
    // run reads. A metadata-only edit (enabled/timezone/maxRuntime) changes no
    // approved work, so it never clamps — a legitimate on/off toggle keeps the
    // grant. The change must be REAL: a field re-sent at its current value is not
    // a new piece of work, mirroring the route's `!== existing` predicate.
    const changesApprovedWork =
      (args.prompt !== undefined && args.prompt !== existing.prompt) ||
      (args.cron !== undefined && (args.cron ?? '') !== (existing.cron ?? '')) ||
      (args.name !== undefined && args.name !== existing.name);
    if (changesApprovedWork) {
      const clamp = clampSchedulePermissionMode(existing.permissionMode);
      if (clamp.clamped) patch.permissionMode = clamp.mode;
    }

    const updated = deps.taskStore!.updateTask(args.id, patch);
    if (!updated) return jsonContent({ error: `Schedule ${args.id} not found` }, true);
    broadcastTasksChanged();
    return jsonContent({ schedule: updated });
  };
}

/** Delete a schedule. */
export function createDeleteScheduleHandler(deps: McpToolDeps) {
  return async (args: { id: string }) => {
    const err = requireTasks(deps);
    if (err) return err;
    // Read BEFORE deleting: a schedule that was waiting on the operator has a
    // standing condition (and possibly an armed escalation) to end, and once the
    // row is gone there is nothing left to tell that from an ordinary task.
    const existing = deps.taskStore!.getTask(args.id);
    const deleted = deps.taskStore!.deleteTask(args.id);
    if (!deleted) return jsonContent({ error: `Schedule ${args.id} not found` }, true);
    resolveParkedScheduleRemoved(existing);
    broadcastTasksChanged();
    return jsonContent({ success: true, id: args.id });
  };
}

/** Get recent runs for a schedule. */
export function createGetRunHistoryHandler(deps: McpToolDeps) {
  return async (args: { schedule_id: string; limit?: number }) => {
    const err = requireTasks(deps);
    if (err) return err;
    const runs = deps.taskStore!.listRuns({
      taskId: args.schedule_id,
      limit: args.limit ?? 20,
    });
    return jsonContent({ runs, count: runs.length });
  };
}

/**
 * The Tasks tool definitions: name, description, input schema, and handler.
 *
 * The single source for all of that on BOTH MCP servers — the external `/mcp`
 * server projects these through `registerFromDefinitions` rather than typing them
 * out again (DOR-499). Unguarded, so it needs no separate definitions function.
 *
 * @param deps - Shared MCP tool dependencies.
 * @param resolveProvenance - How `tasks_create` learns which session is
 *   proposing. Omitted by the sessionless external `/mcp` registration, where a
 *   proposal genuinely has no session behind it and provenance stays null.
 */
export function getTasksTools(deps: McpToolDeps, resolveProvenance?: TaskProvenanceResolver) {
  return [
    tool(
      'tasks_list',
      'List all Tasks scheduled jobs. Returns schedule definitions with status and configuration.',
      { enabled_only: z.boolean().optional().describe('Only return enabled schedules') },
      createListSchedulesHandler(deps)
    ),
    tool(
      'tasks_create',
      'Create a new Tasks scheduled job. The schedule will be created with pending_approval status and must be approved by the user before it can run.',
      {
        name: z.string().describe('Name for the scheduled job'),
        prompt: z.string().describe('The prompt to send to the agent on each run'),
        cron: z.string().describe('Cron expression (e.g., "0 2 * * *" for daily at 2am)'),
        reason: z.string().describe(REASON_DESCRIPTION),
        description: z.string().optional().describe('Description of what this task does'),
        timezone: z.string().optional().describe('IANA timezone (e.g., "America/New_York")'),
        maxRuntime: DURATION_ARG.describe('Maximum run time (e.g., "5m", "1h")'),
        permissionMode: z.string().optional().describe(REFUSED_PERMISSION_MODE_DESCRIPTION),
        status: z.string().optional().describe(REFUSED_STATUS_DESCRIPTION),
      },
      createCreateScheduleHandler(deps, resolveProvenance)
    ),
    tool(
      'tasks_update',
      'Update an existing Tasks schedule. Only provided fields are updated.',
      {
        id: z.string().describe('Schedule ID to update'),
        // Bounded to the SKILL.md slug rule, exactly as `UpdateTaskRequest.name`
        // is on the REST route (`@dorkos/shared`). A task's name is read back to
        // an unattended run in its system prompt (`Job: ${task.name}` via
        // `task-append.ts`), so an unbounded name was a prompt-injection primitive
        // on this surface too — and this handler writes the row directly, so a
        // multiline/over-64 name would ride the window before the reconciler could
        // clamp it. The SDK parses this shape before the handler runs, so a bad
        // name is refused here just as `parseBody` refuses it on REST.
        name: TaskNameSchema.optional().describe('New name (lowercase kebab-case slug)'),
        prompt: z.string().optional().describe('New prompt'),
        cron: z.string().optional().describe('New cron expression'),
        enabled: z.boolean().optional().describe('Enable or disable the schedule'),
        timezone: z.string().optional().describe('New timezone'),
        maxRuntime: DURATION_ARG.describe('New max runtime (e.g., "5m", "1h")'),
        permissionMode: z.string().optional().describe(REFUSED_PERMISSION_MODE_DESCRIPTION),
        status: z.string().optional().describe(REFUSED_STATUS_DESCRIPTION),
      },
      createUpdateScheduleHandler(deps)
    ),
    tool(
      'tasks_delete',
      'Delete a Tasks schedule permanently.',
      { id: z.string().describe('Schedule ID to delete') },
      createDeleteScheduleHandler(deps)
    ),
    tool(
      'tasks_get_run_history',
      'Get recent run history for a Tasks schedule.',
      {
        schedule_id: z.string().describe('Schedule ID to get runs for'),
        limit: z.number().optional().describe('Max runs to return (default 20)'),
      },
      createGetRunHistoryHandler(deps)
    ),
  ];
}
