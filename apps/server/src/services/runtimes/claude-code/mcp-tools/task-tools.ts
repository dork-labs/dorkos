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
import {
  EffortLevelSchema,
  TaskNameSchema,
  TASK_DURATION_PATTERN,
  TASK_DURATION_MAX,
} from '@dorkos/shared/schemas';
import type { EffortLevel, PermissionMode, UpdateTaskRequest } from '@dorkos/shared/types';
import { slugify } from '@dorkos/skills/slug';
import { CREDITS_ACCOUNT_ID } from '@dorkos/shared/account-usage';
import type { McpToolDeps } from './types.js';
import { jsonContent, structuredJsonContent } from './types.js';
import {
  PARKED_SCHEDULE_NOTE,
  ARMED_SCHEDULE_NOTE,
  REAPPROVAL_NOTE,
  TIMING_REAPPROVAL_NOTE,
  RESET_TIMING_DESCRIPTION,
  PARKED_SCHEDULE_SURFACE_HINT,
  TARGET_DESCRIPTION,
  REFUSED_AGENT_ID_DESCRIPTION,
  REFUSED_UPDATE_TARGET_DESCRIPTION,
  STICKY_DESCRIPTION,
  RUNTIME_DESCRIPTION,
  MODEL_DESCRIPTION,
  EFFORT_DESCRIPTION,
  ACCOUNT_DESCRIPTION,
  REASON_DESCRIPTION,
  REFUSED_PERMISSION_MODE_DESCRIPTION,
  REFUSED_STATUS_DESCRIPTION,
} from './task-tool-copy.js';
import {
  clampSchedulePermissionMode,
  taskWorkOf,
} from '../../../tasks/schedule-permission-clamp.js';
import {
  CREDITS_SCHEDULE_AGENT_REFUSAL,
  describeOperatorOnlyTaskRefusal,
  findOperatorOnlyTaskFields,
  OPERATOR_ONLY_TASK_CODE,
  OPERATOR_ONLY_TASK_ERROR,
  refuseUnknownTaskUpdateFields,
} from '../../../tasks/task-write-policy.js';
import { createScheduledTask } from '../../../tasks/lifecycle/create-task.js';
import { agentSchedulesArmWithoutAsking } from '../../../tasks/approvals/agent-trust.js';
import { removeScheduledTaskFile } from '../../../tasks/lifecycle/delete-task.js';
import { applyTaskFileUpdate } from '../../../tasks/lifecycle/update-task-file.js';
import { changesApprovedWork } from '../../../tasks/task-file-update.js';
import { refuseStickyAccountChange } from '../../../tasks/session/sticky-session.js';
import { AGENT_TIMING_CHANGE_REASON } from '../../../tasks/timing/effective-timing.js';
import { describeScheduleProblem } from '../../../tasks/cron-validation.js';
import { broadcastTasksChanged } from '../../../tasks/task-sse-events.js';
import {
  resolveParkedScheduleRemoved,
  resolveScheduleParkPayload,
} from '../../../notifications/emitters/schedule-park.js';
import { raiseStanding } from '../../../notifications/standing-events.js';
import { conflictingTimingRequest } from '../../../tasks/timing/effective-timing.js';
import {
  scheduleAccountRefusal,
  scheduleRunFolder,
} from '../../../tasks/lifecycle/schedule-account-eligibility.js';
import { scheduleCreditsModelRefusal } from '../../../tasks/lifecycle/schedule-credits-model.js';
import { marksOf } from '../../../core/turn-power/turn-levels.js';
import { hasMarks } from '../../../core/turn-power/turn-marks.js';

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

/**
 * The `maxRuntime` argument, validated to the shape the SKILL.md frontmatter
 * accepts — the MCP twin of the same fix on `UpdateTaskRequestSchema` (DOR-1481).
 *
 * Both tools pass this straight through to the store, where `parseDuration`
 * turns anything it cannot read into `0` — which removes the run's time limit
 * rather than rejecting the call — and the same string written into the file
 * makes the file unreadable to every later sync. `tasks_create` used to accept
 * the argument and hardcode `null` in its place; it honors it now (DOR-1568).
 *
 * Capped as well as shaped. The pattern says nothing about LENGTH and `\d+` will
 * match half a megabyte of digits, so without {@link TASK_DURATION_MAX} this
 * tool accepted a duration that `ScheduleBlockSchema` then refuses to read back
 * — the same unreadable-file bug one paragraph up, reached through the argument
 * that was supposed to prevent it. These tools are a THIRD write path into the
 * same SKILL.md beside the two request schemas, so the cap belongs on all three
 * or on none; `packages/skills/src/__tests__/task-request-drift.test.ts` fails
 * if this line stops spelling it.
 */
const DURATION_ARG = z
  .string()
  .min(1)
  .max(TASK_DURATION_MAX)
  .regex(TASK_DURATION_PATTERN)
  .optional();

/** Guard that returns an error response when Tasks is disabled. */
function requireTasks(deps: McpToolDeps) {
  if (!deps.taskStore) {
    return jsonContent({ error: 'Scheduled tasks are turned off on this DorkOS' }, true);
  }
  return null;
}

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
 * Create a new scheduled job — armed at once for one of our agents on a Trusted
 * install, parked at `pending_approval` otherwise.
 *
 * ## What this used to do, and why it was worse than a bug
 *
 * It wrote a row and nothing else: `filePath: ''`, `agentId: null`, and
 * `maxRuntime` hardcoded to `null` no matter what the caller asked for. A
 * scheduled task is a SKILL.md with a derived row, so a row on its own is an
 * ORPHAN — the reconciler has no file to reconcile it against, no agent owns it,
 * and its runs happen in whatever directory the server was started in rather than
 * in anybody's project. The agent was told the task was created, and then could
 * not attach it to itself, because `tasks_update` has no field for that either.
 *
 * All of it now goes through {@link createScheduledTask}, the same seam
 * `POST /api/tasks` uses, so there is one create sequence in the codebase and it
 * is the file-first one (DOR-1568). The caller is an agent by construction, so it
 * is always the untrusted branch: it must say why and it cannot name its own
 * permission mode. On the in-session server (`resolveProvenance` present) the
 * caller is one of our agents, so on a Trusted install the task is armed and the
 * person told; on the sessionless external `/mcp` server the caller cannot be
 * told from an outsider, so the task parks (ADR 261006-225605).
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
    target: string;
    description?: string;
    timezone?: string;
    maxRuntime?: string;
    /** Whether every run resumes one session; see {@link STICKY_DESCRIPTION}. */
    sticky?: boolean;
    /** Which runtime the runs execute on; see {@link RUNTIME_DESCRIPTION}. */
    runtime?: string;
    /** Which model the runs execute on; see {@link MODEL_DESCRIPTION}. */
    model?: string;
    /** How hard the model thinks; see {@link EFFORT_DESCRIPTION}. */
    effort?: EffortLevel;
    /** Which Claude account the runs start on; see {@link ACCOUNT_DESCRIPTION}. */
    account?: string;
    /** Advertised so it can be REFUSED; see {@link refuseOperatorOnlyTaskFields}. */
    permissionMode?: string;
    /** Advertised so it can be REFUSED; see {@link REFUSED_STATUS_DESCRIPTION}. */
    status?: string;
    /** Advertised so it can be REFUSED; see {@link REFUSED_AGENT_ID_DESCRIPTION}. */
    agentId?: string;
  }) => {
    const err = requireTasks(deps);
    if (err) return err;
    const refusal = refuseOperatorOnlyTaskFields(args);
    if (refusal) return refusal;
    // DorkOS credits are the owner's to choose, never an agent's (DOR-2678).
    if (args.account === CREDITS_ACCOUNT_ID) {
      return jsonContent(CREDITS_SCHEDULE_AGENT_REFUSAL, true);
    }
    // `agentId` is not a create field — `target` is — and a silent strip is what
    // sent an agent looking for another way to own its own task.
    if (args.agentId !== undefined) {
      return jsonContent(
        {
          error: 'DorkOS changed nothing — `agentId` is not a field on a scheduled task write.',
          code: 'unknown_task_field',
          fields: ['agentId'],
          message:
            'Say which agent a scheduled task belongs to with `target` instead: your own agent id ' +
            'to file it under yourself, or "global" for a scheduled task that belongs to no agent.',
        },
        true
      );
    }

    // Resolved now, not when this handler was built: the SDK rekeys a session
    // to its canonical id mid-first-turn (see {@link TaskProvenanceResolver}).
    const provenance = resolveProvenance?.() ?? {};

    const outcome = await createScheduledTask(
      {
        store: deps.taskStore!,
        registrar: deps.resolveTaskRegistrar?.() ?? null,
        dorkHome: deps.dorkHome,
        ...(deps.meshCore && { meshCore: deps.meshCore }),
      },
      {
        input: {
          name: args.name,
          // The slug, not the raw name, exactly as this tool has always defaulted
          // it — a name is slugified before it is written, so a description
          // defaulted from the raw name would carry punctuation and newlines the
          // name itself cannot. The `|| args.name` is the unusable-name case,
          // where the create is about to be refused for a better reason.
          description: args.description ?? (slugify(args.name) || args.name),
          prompt: args.prompt,
          cron: args.cron,
          ...(args.timezone !== undefined && { timezone: args.timezone }),
          ...(args.maxRuntime !== undefined && { maxRuntime: args.maxRuntime }),
          target: args.target,
          reason: args.reason,
          ...(args.sticky !== undefined && { sticky: args.sticky }),
          ...(args.runtime !== undefined && { runtime: args.runtime }),
          ...(args.model !== undefined && { model: args.model }),
          ...(args.effort !== undefined && { effort: args.effort }),
          ...(args.account !== undefined && { account: args.account }),
        },
        // An MCP tool call IS the agent surface — there is no header to omit and
        // no operator branch to spare.
        trusted: false,
        // Only the in-session server knows its caller is one of our agents.
        callerIsOurAgent: resolveProvenance !== undefined,
        // The marks of the turn making the call, from its own record (DOR-3036).
        originMarks: marksOf(provenance.sessionId, provenance.agentPath),
        proposal: {
          sessionId: provenance.sessionId ?? null,
          agentPath: provenance.agentPath ?? null,
        },
      }
    );

    if (!outcome.ok) {
      return jsonContent(
        {
          error: outcome.error,
          ...(outcome.code !== undefined && { code: outcome.code }),
          ...(outcome.ownedBy !== undefined && { ownedBy: outcome.ownedBy }),
          ...(outcome.details !== undefined && { details: outcome.details }),
        },
        true
      );
    }

    // Parity with the REST route's create handler (routes/tasks.ts): without this,
    // a schedule an agent proposes has no activity entry to tell the person it is
    // waiting on them. `metadata.status` carries the parked state into the feed so
    // a consumer can tell this apart from an operator's own (immediately active)
    // creation without a second lookup.
    //
    // Attributed the same way `capability-gate-audit.ts` attributes its agent-actor
    // events: by the agent's project path, and NAMED from the same park payload the
    // notification used, so the two cannot disagree about who asked. The sessionless
    // external `/mcp` server carries no session, so the name falls back to "An
    // agent" there and no `actorId` is attached.
    const task = outcome.task;
    const armed = outcome.armedPayload;
    deps.activityService?.emit({
      actorType: 'agent',
      actorLabel: armed?.armedBy ?? outcome.parkPayload?.proposedBy ?? 'An agent',
      ...(provenance.agentPath ? { actorId: provenance.agentPath } : {}),
      category: 'tasks',
      // Armed without asking is recorded as exactly that, so the audit trail can
      // answer "what did my agents set running?" (ADR 261006-225605).
      eventType: armed ? 'schedule.armed_by_agent' : 'tasks.task_created',
      resourceType: 'schedule',
      resourceId: task.id,
      resourceLabel: task.displayName ?? task.name,
      summary: armed
        ? `Scheduled task ${task.displayName ?? task.name}, which runs ${armed.cadence}`
        : `Proposed scheduled task ${task.displayName ?? task.name}, which needs your approval before it runs`,
      linkPath: '/',
      metadata: { status: task.status },
    });

    if (armed) return jsonContent({ schedule: task, note: ARMED_SCHEDULE_NOTE });

    return jsonContent({
      schedule: task,
      // The panel hint rides along only where the tool that would open it
      // exists. `resolveProvenance` is absent on the external `/mcp` server, so
      // that surface gets the "tell them" half and nothing it cannot do.
      note: provenance.sessionId
        ? `${PARKED_SCHEDULE_NOTE} ${PARKED_SCHEDULE_SURFACE_HINT}`
        : PARKED_SCHEDULE_NOTE,
    });
  };
}

/**
 * Update an existing schedule — its SKILL.md first, then the row it derives.
 *
 * **The file half is not optional, and leaving it out was a lie-on-success**
 * (DOR-1625). This handler wrote the row alone and answered with the updated
 * schedule; the reconciler re-reads every skills root every five minutes and
 * upserts what it finds, so the untouched file put the old values straight back
 * — every field an agent changed here (`prompt`, `cron`, `name`, `timezone`, and
 * the runtime/model/effort trio) was silently reverted inside that window.
 * `PATCH /api/tasks/:id` always wrote the file, and now both doors do it through
 * the same seam ({@link applyTaskFileUpdate}).
 */
export function createUpdateScheduleHandler(
  deps: McpToolDeps,
  resolveProvenance?: TaskProvenanceResolver
) {
  return async (args: {
    id: string;
    name?: string;
    prompt?: string;
    cron?: string;
    enabled?: boolean;
    timezone?: string;
    maxRuntime?: string;
    /** Whether every run resumes one session; see {@link STICKY_DESCRIPTION}. */
    sticky?: boolean;
    /** Which runtime the runs execute on, or `null` to clear the override. */
    runtime?: string | null;
    /** Which model the runs execute on, or `null` to clear the override. */
    model?: string | null;
    /** How hard the model thinks, or `null` to clear the override. */
    effort?: EffortLevel | null;
    /** Which Claude account the runs start on, or `null` to clear the override. */
    account?: string | null;
    /** Put a package's schedule back on its own timing; see {@link RESET_TIMING_DESCRIPTION}. */
    resetTiming?: true;
    /** Advertised so it can be REFUSED; see {@link refuseOperatorOnlyTaskFields}. */
    permissionMode?: string;
    /** Advertised so it can be REFUSED; see {@link REFUSED_STATUS_DESCRIPTION}. */
    status?: string;
    /** Advertised so it can be REFUSED; see {@link REFUSED_UPDATE_TARGET_DESCRIPTION}. */
    target?: string;
    /** Advertised so it can be REFUSED; see {@link REFUSED_AGENT_ID_DESCRIPTION}. */
    agentId?: string;
  }) => {
    const err = requireTasks(deps);
    if (err) return err;
    const refusal = refuseOperatorOnlyTaskFields(args);
    if (refusal) return refusal;

    // `id` is a tool ARGUMENT, not a field of the task, so it is stripped before
    // the body is judged. Everything else the SDK let through is measured against
    // the update schema, so `target` and `agentId` — declared above precisely so
    // they survive to be seen — are refused loudly instead of vanishing (DOR-1568).
    const { id: _id, ...fields } = args;
    const unknownFields = refuseUnknownTaskUpdateFields(fields);
    if (unknownFields) return jsonContent(unknownFields, true);

    // Read the row BEFORE the write, both to answer 404 the same way this handler
    // always has and — below — to decide whether this edit changes the work a
    // person approved.
    const existing = deps.taskStore!.getTask(args.id);
    if (!existing) return jsonContent({ error: `Schedule ${args.id} not found` }, true);

    // Naming DorkOS credits, or switching a schedule on them back on, starts
    // spending the DorkOS account's money: the owner's call, never an agent's
    // (DOR-2678). `enabled` is otherwise agent-writable.
    const runsOnCredits =
      (args.account !== undefined ? args.account : existing.account) === CREDITS_ACCOUNT_ID;
    if (
      args.account === CREDITS_ACCOUNT_ID ||
      (runsOnCredits && args.enabled === true && !existing.enabled)
    ) {
      return jsonContent(CREDITS_SCHEDULE_AGENT_REFUSAL, true);
    }

    // A new timing and the package's own timing are two different answers to
    // one question; the call has to pick (DOR-2302).
    const timingConflict = conflictingTimingRequest(args);
    if (timingConflict) return jsonContent({ error: timingConflict }, true);

    // The same refusal, in the same words, as `PATCH /api/tasks/:id` (DOR-2384).
    const accountLocked = refuseStickyAccountChange(deps.taskStore!, existing, args);
    if (accountLocked) return jsonContent(accountLocked, true);

    // An agent may not point a schedule at an account that may not work in the
    // folder its runs start in (spec `flow-multiproject` §8.4). Same sentence
    // as the create path.
    if (typeof args.account === 'string') {
      const refusal = await scheduleAccountRefusal({
        account: args.account,
        runtime: args.runtime ?? existing.runtime,
        folder: scheduleRunFolder(
          existing.agentId ? deps.meshCore?.getProjectPath(existing.agentId) : null
        ),
      });
      if (refusal) return jsonContent({ error: refusal.message, code: refusal.code }, true);
    }
    // A schedule whose runs go on DorkOS credits names a model credits serve
    // (DOR-2636). Same rule and sentence as the update route.
    if (args.model !== undefined || args.account !== undefined || args.runtime !== undefined) {
      const modelRefusal = await scheduleCreditsModelRefusal({
        model: args.model !== undefined ? args.model : existing.model,
        account: args.account !== undefined ? args.account : existing.account,
        runtime: args.runtime !== undefined ? args.runtime : existing.runtime,
        folder: scheduleRunFolder(
          existing.agentId ? deps.meshCore?.getProjectPath(existing.agentId) : null
        ),
      });
      if (modelRefusal)
        return jsonContent({ error: modelRefusal, code: 'UNSUPPORTED_MODEL' }, true);
    }

    // The MERGED schedule is what gets written and registered, so the merged
    // schedule is what has to read: a new cron runs in the task's existing
    // timezone unless this same call changes it, and either half alone can be the
    // one croner refuses. Asked here for the reason the create path gives — the
    // file is written below and never withdrawn, so a cron nothing can read would
    // otherwise land in a person's SKILL.md permanently. `PATCH /api/tasks/:id`
    // has always asked it; this door did not, and only got away with it while it
    // wrote nothing to disk (DOR-1625).
    if (args.cron !== undefined || args.timezone !== undefined) {
      const problem = describeScheduleProblem(
        args.cron !== undefined ? args.cron : existing.cron,
        args.timezone !== undefined ? args.timezone : existing.timezone
      );
      if (problem) return jsonContent({ error: problem }, true);
    }

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
      ...(args.sticky !== undefined && { sticky: args.sticky }),
      ...(args.runtime !== undefined && { runtime: args.runtime }),
      ...(args.model !== undefined && { model: args.model }),
      ...(args.effort !== undefined && { effort: args.effort }),
      ...(args.account !== undefined && { account: args.account }),
      ...(args.resetTiming === true && { resetTiming: true as const }),
    };

    // A non-trusted caller cannot KEEP an approved task's `bypassPermissions` by
    // rewriting the work it does — the same escalation `PATCH /api/tasks/:id`
    // clamps (routes/tasks.ts), routed through the SAME seam
    // (`clampSchedulePermissionMode`) so the two agent doors cannot drift.
    //
    // On this surface the caller is ALWAYS the non-trusted case: an MCP tool call
    // IS the agent surface, so there is no operator branch to spare (the reasoning
    // `refuseOperatorOnlyTaskFields` states unconditionally, one level up).
    // Clamping here makes the drop immediate rather than leaving the row at
    // `bypassPermissions` holding the NEW prompt/cron/name until the next sync,
    // where a cron firing in that window would dispatch an agent's instructions at
    // full power. The edit itself still lands (prompt/cron/name are
    // agent-writable), the unattended run just gets its approval prompts back.
    //
    // Set on the patch BEFORE the file write below, so the clamped mode lands in
    // the SKILL.md as well as the row — exactly as it does on the REST route. A
    // file declaring more power than its row holds is a standing request from disk
    // that nobody made, and the next sync would read it back.
    //
    // The approved work is the prompt, the timing and the settings in the
    // approval key (`ScheduleSettings`, DOR-2323): the name the run is told, the
    // runtime, model and effort that do it, its time limit and whether it
    // remembers earlier runs. An edit that touches none of them (the switch,
    // the description) never clamps, so a legitimate on/off toggle keeps the
    // grant. The change must be REAL: a field re-sent at its current value is
    // not a new piece of work. One predicate, shared with the REST route.
    const editsApprovedWork = changesApprovedWork(args, existing);
    // Handed to the file step rather than set on the patch, so a package's
    // row-only timing change can leave it out (`clampApplied`, DOR-2302): that
    // change is parked for a person below, and carried into the request the
    // clamp would read as a permission change the package's file refuses.
    let clampTo: PermissionMode | undefined;
    if (editsApprovedWork) {
      const clamp = clampSchedulePermissionMode(existing.permissionMode);
      if (clamp.clamped) clampTo = clamp.mode;
    }

    // The FILE first, through the seam `PATCH /api/tasks/:id` shares. Without it
    // this handler wrote a row the reconciler reverted within five minutes, after
    // the agent had been told the change landed (DOR-1625). Every gate inside
    // refuses before anything is written — an unreadable file, one an installed
    // package owns, a plan that would leave the block unreadable — so a refusal
    // here leaves the row untouched too, and the call is refused WHOLE.
    //
    // One consequence worth naming: the approval grant is keyed on the schedule's
    // CONTENT, so a live schedule whose prompt, cron or timezone an agent
    // rewrites goes back to a person, parked below in this same call rather than
    // at the next sync of the file this writes (DOR-2313).
    const fileOutcome = await applyTaskFileUpdate(
      { dorkHome: deps.dorkHome, ...(deps.meshCore && { meshCore: deps.meshCore }) },
      { existing, data: patch, clampTo }
    );
    if (!fileOutcome.ok) {
      return jsonContent(
        {
          error: fileOutcome.error,
          ...(fileOutcome.code !== undefined && { code: fileOutcome.code }),
          ...(fileOutcome.ownedBy !== undefined && { ownedBy: fileOutcome.ownedBy }),
        },
        true
      );
    }

    const rowPatch: UpdateTaskRequest =
      fileOutcome.clampApplied && clampTo ? { ...patch, permissionMode: clampTo } : patch;
    let updated = deps.taskStore!.updateTask(args.id, rowPatch, {
      timingLandsOn: fileOutcome.timingLandsOn,
    });
    if (!updated) return jsonContent({ error: `Schedule ${args.id} not found` }, true);

    // This is an agent, so a change to approved work stops an approved
    // schedule at once and puts it back in front of a person, file written or
    // not, exactly as the REST route does for an agent (DOR-2313). Left to the
    // sync, the agent's new work would run approved until the watcher or the
    // sweep caught up.
    // One of our agents on a Trusted install keeps an approved schedule live
    // through its own edit, except on a schedule made from a file (ADR
    // 261006-225605); only the in-session server knows the caller is ours.
    let settled = deps.taskStore!.approvals.settleApprovedWorkChange(
      updated.id,
      { ...taskWorkOf(existing), status: existing.status },
      {
        trusted: false,
        armsAgentWork: agentSchedulesArmWithoutAsking(resolveProvenance !== undefined),
      }
    );
    // An edit from a marked turn parks it for a person, whatever it changed, and keeps the marks
    // for its card (DOR-3036).
    const caller = resolveProvenance?.() ?? {};
    const marks = marksOf(caller.sessionId, caller.agentPath);
    if (hasMarks(marks) && deps.taskStore!.approvals.markOrigin(updated.id, marks)) {
      if (existing.status !== 'pending_approval') settled = 'parked';
    }
    if (settled === 'parked') {
      updated = deps.taskStore!.getTask(updated.id) ?? updated;
      // The standing condition and its escalation clock start here, as they do
      // at every other door a schedule parks through.
      raiseStanding('schedule.parked', await resolveScheduleParkPayload(updated));
    }
    // Through the registrar, exactly as `PATCH /api/tasks/:id` does. Without
    // this the row said one thing and the running cron job went on firing the
    // old schedule until a restart — an agent could change a task's cron, be
    // told it worked, and watch it keep running at the old time (DOR-1493).
    deps.resolveTaskRegistrar?.()?.syncTask(updated.id);
    broadcastTasksChanged();

    // An agent switching a schedule back ON is recorded where the person will see
    // it. A schedule that came with an installed package is switched on the row
    // alone (FB-26), so this is the one trace that an agent, not its owner, turned
    // it back on. Attributed as `tasks_create` attributes its proposals: by the
    // agent's project path when the session has one, "An agent" otherwise.
    if (args.enabled === true && !existing.enabled && updated.enabled) {
      const provenance = resolveProvenance?.() ?? {};
      deps.activityService?.emit({
        actorType: 'agent',
        actorLabel: 'An agent',
        ...(provenance.agentPath ? { actorId: provenance.agentPath } : {}),
        category: 'tasks',
        eventType: 'tasks.task_resumed',
        resourceType: 'schedule',
        resourceId: updated.id,
        resourceLabel: updated.displayName ?? updated.name,
        summary: `Switched on scheduled task ${updated.displayName ?? updated.name}`,
        linkPath: '/',
      });
    }

    // Say what the edit cost, so an agent does not report a live schedule that
    // has just stopped. Only a schedule that was running can be stopped; one
    // already parked, or paused, has nothing to disclose.
    if (settled === 'parked') {
      return jsonContent({
        schedule: updated,
        needsReapproval: true,
        // The note follows the sentence the park wrote: timing alone, or the
        // work itself (its prompt or how it runs).
        note:
          updated.reason === AGENT_TIMING_CHANGE_REASON ? TIMING_REAPPROVAL_NOTE : REAPPROVAL_NOTE,
      });
    }
    return jsonContent({ schedule: updated });
  };
}

/**
 * Delete a schedule — its SKILL.md first, then its row.
 *
 * **The file half is not optional, and leaving it out was a lie-on-success**
 * (DOR-1568). This handler deleted the row alone and answered `{success: true}`;
 * the reconciler re-reads every skills root every five minutes and upserts what it
 * finds, so the task came back — new id, `status: 'active'` — minutes after the
 * agent had been told it was gone. `DELETE /api/tasks/:id` always removed the
 * file, and now both doors do it through the same seam.
 */
export function createDeleteScheduleHandler(deps: McpToolDeps) {
  return async (args: { id: string }) => {
    const err = requireTasks(deps);
    if (err) return err;
    // Read BEFORE deleting: a schedule that was waiting on the operator has a
    // standing condition (and possibly an armed escalation) to end, and once the
    // row is gone there is nothing left to tell that from an ordinary task — and
    // the row is also the only place the file's path is recorded.
    const existing = deps.taskStore!.getTask(args.id);
    await removeScheduledTaskFile(existing?.filePath ?? null);
    const deleted = deps.taskStore!.deleteTask(args.id);
    if (!deleted) return jsonContent({ error: `Schedule ${args.id} not found` }, true);
    // With no row left to read, `syncTask` unregisters — which is the whole
    // point here: a deleted schedule whose job kept firing is worse than a
    // stale one, because the run it tries to record belongs to a schedule that
    // no longer exists (DOR-1493).
    deps.resolveTaskRegistrar?.()?.syncTask(args.id);
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
      'List every scheduled task on this DorkOS. Returns each one with its status and settings.',
      { enabled_only: z.boolean().optional().describe('Only return enabled schedules') },
      createListSchedulesHandler(deps)
    ),
    tool(
      'tasks_create',
      'Create a scheduled task. It is live at once and the person is told, unless DorkOS asks ' +
        'them first: then it waits at pending_approval and never runs until they approve it. ' +
        'The schedule returned says which.',
      {
        name: z.string().describe('Name for the scheduled task'),
        prompt: z.string().describe('The prompt to send to the agent on each run'),
        cron: z.string().describe('Cron expression (e.g., "0 2 * * *" for daily at 2am)'),
        reason: z.string().describe(REASON_DESCRIPTION),
        target: z.string().min(1).describe(TARGET_DESCRIPTION),
        description: z.string().optional().describe('Description of what this scheduled task does'),
        timezone: z.string().optional().describe('IANA timezone (e.g., "America/New_York")'),
        maxRuntime: DURATION_ARG.describe('Maximum run time (e.g., "5m", "1h")'),
        sticky: z.boolean().optional().describe(STICKY_DESCRIPTION),
        runtime: z.string().min(1).optional().describe(RUNTIME_DESCRIPTION),
        model: z.string().min(1).optional().describe(MODEL_DESCRIPTION),
        effort: EffortLevelSchema.optional().describe(EFFORT_DESCRIPTION),
        account: z.string().min(1).optional().describe(ACCOUNT_DESCRIPTION),
        permissionMode: z.string().optional().describe(REFUSED_PERMISSION_MODE_DESCRIPTION),
        status: z.string().optional().describe(REFUSED_STATUS_DESCRIPTION),
        agentId: z.string().optional().describe(REFUSED_AGENT_ID_DESCRIPTION),
      },
      createCreateScheduleHandler(deps, resolveProvenance)
    ),
    tool(
      'tasks_update',
      'Update an existing scheduled task. Only the fields you send are changed. Changing the ' +
        'prompt, the cron or the timezone of an approved task can stop it until the person ' +
        'approves it again: always for a task that came from a file or a package, and for any ' +
        'task when DorkOS asks them first. The reply says so with needsReapproval. A task that came with an installed package ' +
        'can still be switched on or off and given a new cron or timezone — DorkOS keeps those, ' +
        "the package is not edited — and resetTiming puts it back on the package's own timing.",
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
        sticky: z.boolean().optional().describe(STICKY_DESCRIPTION),
        // Nullable on the UPDATE side alone: clearing an override is a state a
        // person (or an agent that set one) can want, and `null` is how every
        // other clearable field on this tool spells it.
        runtime: z.string().min(1).nullable().optional().describe(RUNTIME_DESCRIPTION),
        model: z.string().min(1).nullable().optional().describe(MODEL_DESCRIPTION),
        effort: EffortLevelSchema.nullable().optional().describe(EFFORT_DESCRIPTION),
        account: z.string().min(1).nullable().optional().describe(ACCOUNT_DESCRIPTION),
        resetTiming: z.literal(true).optional().describe(RESET_TIMING_DESCRIPTION),
        permissionMode: z.string().optional().describe(REFUSED_PERMISSION_MODE_DESCRIPTION),
        status: z.string().optional().describe(REFUSED_STATUS_DESCRIPTION),
        target: z.string().optional().describe(REFUSED_UPDATE_TARGET_DESCRIPTION),
        agentId: z.string().optional().describe(REFUSED_AGENT_ID_DESCRIPTION),
      },
      createUpdateScheduleHandler(deps, resolveProvenance)
    ),
    tool(
      'tasks_delete',
      'Delete a scheduled task permanently.',
      { id: z.string().describe('Schedule ID to delete') },
      createDeleteScheduleHandler(deps)
    ),
    tool(
      'tasks_get_run_history',
      'Get the recent run history for a scheduled task.',
      {
        schedule_id: z.string().describe('Schedule ID to get runs for'),
        limit: z.number().optional().describe('Max runs to return (default 20)'),
      },
      createGetRunHistoryHandler(deps)
    ),
  ];
}
