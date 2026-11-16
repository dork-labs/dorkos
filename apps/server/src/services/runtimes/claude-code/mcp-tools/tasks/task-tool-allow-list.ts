/**
 * The `tasks_*` tools' side of an agent-set allow list (DOR-4315): decide the
 * change, audit it before it is written, and write it to the task's
 * `approvedAllow`, the column a person's approved rules use (DOR-3637), so a
 * run carries either the same way. The rules are
 * `services/tasks/allow-list/allow-list-rule.ts`; this file only gathers what
 * they read and carries out what they answer.
 *
 * - **Adding** is the agent's own business only for a new one-shot task's first
 *   list: from its own chat, about its own task, in a turn that read no outside
 *   words, by an identity its own home vouches for. Anything else that adds is
 *   refused, pointing at `requestedAllow` and the card.
 * - **Removing** narrows: allowed from any caller that may edit the task, with
 *   no card, in a call of its own. That is how an agent takes its commands back
 *   after the one run.
 *
 * @module services/runtimes/claude-code/mcp-tools/tasks/task-tool-allow-list
 */
import { z } from 'zod';
import type { Task } from '@dorkos/shared/types';
import type { McpToolDeps } from '../types.js';
import { jsonContent } from '../types.js';
import { NOT_RECORDED_REFUSAL } from './task-tool-mode.js';
import { scheduleEdit } from '../../../../tasks/approvals/schedule-owner.js';
import { broadcastTasksChanged } from '../../../../tasks/task-sse-events.js';
import { MAX_TASK_ALLOW_ENTRIES } from '../../../../tasks/allow-list/task-allow-list.js';
import { agentModeControlOn } from '../../../../tasks/agent-mode/agent-mode-actions.js';
import {
  ceilingOf,
  taskOwnerOf,
  type AgentModeCaller,
} from '../../../../tasks/agent-mode/agent-mode-decision.js';
import { liveAgentModeSources } from '../../../../tasks/agent-mode/agent-mode-sources.js';
import { sameHome } from '../../../../tasks/agent-mode/agent-mode-attest.js';
import { AGENT_MODE_REFUSAL_ERROR } from '../../../../tasks/agent-mode/agent-mode-copy.js';
import {
  ALLOW_LIST_MODE,
  decideAllowList,
  narrowingOf,
} from '../../../../tasks/allow-list/allow-list-rule.js';
import { allowListChange } from '../../../../tasks/allow-list/task-allow-list.js';
import {
  mergePins,
  pinPrograms,
  type AllowListPins,
} from '../../../../tasks/allow-list/allow-list-pins.js';
import { recordAudit } from '../../../../audit/audit-trail.js';

/** A list change the tool may write, once it is audited. */
export interface AllowListWrite {
  before: string[];
  after: string[];
  added: string[];
  removed: string[];
  /** The pins after the change: kept entries keep theirs, added ones are new. */
  pins: AllowListPins;
}

/** A refusal, in the envelope every task tool answers with. */
export interface AllowListRefusal {
  error: string;
  code: string;
  message: string;
}

/** What {@link settleAllowListCall} answers: nothing to do, a refusal, or a write. */
export type AllowListSettlement =
  | { kind: 'none' }
  | { kind: 'refused'; body: AllowListRefusal }
  | { kind: 'write'; write: AllowListWrite };

/** The call, as the tool has it. */
export interface AllowListCall {
  door: 'create' | 'update';
  /** The tool's arguments; `allowList`, `runOnce`, `runtime` and `permissionMode` are read. */
  body: Record<string, unknown>;
  /** The task as stored, for an update. */
  task?: Task;
  /** The create's target: an agent id or `global`. */
  target?: string;
  caller: AgentModeCaller;
}

/** What an agent reads about `allowList`. */
export const ALLOW_LIST_DESCRIPTION =
  'Only with `runOnce: true` and `permissionMode: "dontAsk"` on tasks_create: the exact commands ' +
  'its one run may run without asking, each `Bash(/absolute/path/to/program --its --flags)`. No ' +
  'wildcards, no `:*`, no shell characters (; | & $ < >, backticks, quotes), no `..`, and no ' +
  'program that runs another (a shell, a language runtime, `env`, `timeout`, `git`, `make`, or a ' +
  'link to one). Up to 20, Claude Code only, and only commands your own level already ' +
  'runs without asking. DorkOS records each program and refuses the run if it changes. On ' +
  'tasks_update, send a shorter list (or `[]`) in a call of its own to remove commands. Every ' +
  'change is recorded.';

/** What an agent reads about `runOnce`. */
export const RUN_ONCE_DESCRIPTION =
  'Make this a one-shot task: no cron, it runs once as soon as it is on, then never again. Leave ' +
  '`cron` out. When it is done, remove its commands with tasks_update and `allowList: []`.';

/** `allowList` as both task tools take it. */
export const ALLOW_LIST_ARG = z
  .array(z.string())
  .max(MAX_TASK_ALLOW_ENTRIES)
  .optional()
  .describe(ALLOW_LIST_DESCRIPTION);

/** `runOnce` as tasks_create takes it. */
export const RUN_ONCE_ARG = z.literal(true).optional().describe(RUN_ONCE_DESCRIPTION);

/**
 * Decide one call's change to a task's allow list.
 *
 * @param deps - The tool dependencies.
 * @param call - The call.
 */
export async function settleAllowListCall(
  deps: McpToolDeps,
  call: AllowListCall
): Promise<AllowListSettlement> {
  if (!Object.hasOwn(call.body, 'allowList')) return { kind: 'none' };
  const previous = call.task ? deps.taskStore!.runControls.pinsOf(call.task.id) : null;
  const before = call.task?.approvedAllow ?? [];
  // Removing only narrows: no switch, level or mode is asked about it.
  const narrowed = narrowingOf(call.body.allowList, before);
  if (narrowed) {
    if (narrowed.length === before.length) return { kind: 'none' };
    const pins = mergePins(previous, {}, narrowed, new Date().toISOString());
    return {
      kind: 'write',
      write: { before, after: narrowed, ...allowListChange(before, narrowed), pins },
    };
  }
  if (!agentModeControlOn()) {
    return refusal('allow_list_off', 'Agents can’t set a task’s allow list on this DorkOS.');
  }
  const sources = liveAgentModeSources(deps.meshCore);
  const runtime =
    (typeof call.body.runtime === 'string' ? call.body.runtime : undefined) ?? call.task?.runtime;
  const declared = sources.declaredModes(runtime);
  if (!declared) return refusal('unknown_mode', 'DorkOS can’t tell how this task’s runs work.');
  const owner = taskOwnerOf(
    {
      door: call.door,
      body: call.body,
      ...(call.task ? { task: call.task } : {}),
      ...(call.target ? { target: call.target } : {}),
    },
    call.caller,
    sources
  );
  const mode =
    (typeof call.body.permissionMode === 'string' ? call.body.permissionMode : undefined) ??
    call.task?.permissionMode ??
    '';
  const verdict = decideAllowList({
    body: call.body,
    before,
    createsOneShot: call.door === 'create' && call.body.runOnce === true,
    listEverSet: previous?.firstSetAt != null || before.length > 0,
    mode,
    ceiling: await ceilingOf(call.caller, owner, runtime, declared, sources),
    runtime,
    adder: {
      ownChatOwnTask: ownChatOwnTask(call.caller, owner),
      marked: call.caller.marked,
      scheduledRun: call.caller.scheduledRun === true || call.caller.heartbeat === true,
    },
  });
  if (verdict.kind === 'none') return { kind: 'none' };
  if (verdict.kind === 'refused') return refusal(verdict.code, verdict.message);
  const { after, added, removed } = verdict;
  // Each added program, pinned now: a run on other bytes is refused (Security's ruling).
  const pinned = await pinPrograms(added);
  if (!pinned.ok) {
    return refusal('allow_list_program', `DorkOS can’t read the program in ${pinned.rule}.`);
  }
  const pins = mergePins(previous, pinned.programs, after, new Date().toISOString());
  return { kind: 'write', write: { before: verdict.before, after, added, removed, pins } };
}

/**
 * The caller is the task's own agent, in its own chat, in a turn that read no
 * outside words, by an identity its own home vouches for.
 */
function ownChatOwnTask(caller: AgentModeCaller, owner: string | undefined): boolean {
  if (!caller.structural || caller.marked || !caller.agentPath) return false;
  if (caller.resolved !== 'home') return false;
  return sameHome(owner, caller.agentPath);
}

/**
 * Audit a list change BEFORE it is written: who, the task, the list before and
 * after, and each added program's pin. `false` means the row was not stored,
 * and the caller then writes nothing.
 *
 * @param task - The task, as it will be named in the log.
 * @param write - The change.
 * @param caller - Who made it.
 */
export function auditAllowListChange(
  task: Pick<Task, 'id' | 'name' | 'displayName'>,
  write: AllowListWrite,
  caller: AgentModeCaller
): boolean {
  const label = task.displayName ?? task.name;
  const event = recordAudit({
    action: 'tasks.set_allow_list',
    operation: 'modify',
    target: { type: 'task', id: task.id, name: label },
    outcome: 'ok',
    change: [
      { field: 'allowList', before: write.before, after: write.after },
      { field: 'added', after: write.added },
      { field: 'removed', after: write.removed },
      {
        field: 'pinnedPrograms',
        after: write.added.map((rule) => ({ rule, ...write.pins.programs[rule] })),
      },
      { field: 'setterAgentPath', after: caller.agentPath ?? null },
      { field: 'identityResolvedVia', after: caller.resolved ?? 'unidentified' },
      { field: 'scheduledRun', after: caller.scheduledRun === true || caller.heartbeat === true },
    ],
    summary:
      write.added.length > 0
        ? `Allow list set: ${label}, ${write.after.length} command(s)`
        : `Allow list narrowed: ${label}, ${write.after.length} command(s) left`,
  });
  return event !== undefined;
}

/**
 * Carry out a settled list change: audit it, then write it. The card's
 * requested rules drop what the change removed, so a later approval can't put
 * a removed command back. `null` when the audit row could not be stored, and
 * then nothing is written.
 *
 * @param deps - The tool dependencies.
 * @param task - The task as stored.
 * @param write - The settled change.
 * @param caller - Who made it.
 */
export function writeAllowList(
  deps: McpToolDeps,
  task: Task,
  write: AllowListWrite,
  caller: AgentModeCaller
): Task | null {
  if (!auditAllowListChange(task, write, caller)) return null;
  const requested = task.requestedAllow?.filter((rule) => !write.removed.includes(rule));
  deps.taskStore!.runControls.set(task.id, {
    approvedAllow: write.after,
    allowListPins: write.pins,
    ...(requested !== undefined && { requestedAllow: requested }),
  });
  return deps.taskStore!.getTask(task.id);
}

/**
 * What a create answers when its list's audit row could not be stored: the
 * task exists, but with no list, no one-shot flag and no cron, so it never
 * runs on its own. Said plainly, so the agent deletes it rather than retrying
 * into a second one.
 *
 * @param taskId - The task the create made.
 */
export function listNotRecorded(taskId: string): { error: string; code: string; id: string } {
  return {
    error:
      'DorkOS made the task but could not record its commands, so it has none and never runs ' +
      'on its own. Delete it, then try again.',
    code: 'allow_list_not_recorded',
    id: taskId,
  };
}

/** The refusal for a cron on a one-shot task, which would run its list every time. */
export const ONE_SHOT_CRON_REFUSAL = {
  error: 'A one-shot task has no cron. Make a new task to run on a schedule.',
  code: 'one_shot_cron',
} as const;

/**
 * The refusal when a call names both a list and other changes: a narrowing
 * stands alone, so it can never ride a change that needs a person.
 */
export const LIST_ALONE_REFUSAL: AllowListRefusal = {
  error: AGENT_MODE_REFUSAL_ERROR,
  code: 'list_alone',
  message: 'Change a task’s allow list in a call of its own, with only `id` and `allowList`.',
};

/**
 * Finish a create's list and one-shot flag, after the task row exists. The
 * list is written to `approvedAllow` only when the task was armed at Don't ask
 * with no card; a parked task keeps it in `requestedAllow`, for the person on
 * its card. Then the flag, and a sync, so an armed one-shot runs now.
 *
 * @param deps - The tool dependencies.
 * @param task - The task as created.
 * @param settled - The create's list settlement.
 * @param caller - Who made it.
 * @param runOnce - Whether it is a one-shot task.
 * @returns The task and whether its list applies; `null` when the audit failed.
 */
export function finishOneShotCreate(
  deps: McpToolDeps,
  task: Task,
  settled: AllowListSettlement,
  caller: AgentModeCaller,
  runOnce: boolean
): { task: Task; listApplied: boolean } | null {
  let current = task;
  let listApplied = false;
  const armedAtDontAsk = task.status === 'active' && task.permissionMode === ALLOW_LIST_MODE;
  if (settled.kind === 'write' && settled.write.added.length > 0 && armedAtDontAsk) {
    const written = writeAllowList(deps, task, settled.write, caller);
    if (!written) return null;
    current = written;
    listApplied = true;
  }
  if (!runOnce) return { task: current, listApplied };
  deps.taskStore!.runControls.set(task.id, { runOnce: true });
  deps.resolveTaskRegistrar?.()?.syncTask(task.id);
  return { task: deps.taskStore!.getTask(task.id) ?? current, listApplied };
}

/**
 * What a create with a list adds to its note.
 *
 * @param task - The task as finished.
 * @param listApplied - Whether its list applies.
 */
export function oneShotListNote(task: Task, listApplied: boolean): string {
  if (listApplied) {
    return (
      `It runs once now, and may run ${task.approvedAllow?.length ?? 0} command(s) without ` +
      'asking. When it is done, remove them: tasks_update with `allowList: []`.'
    );
  }
  return task.status === 'pending_approval'
    ? 'Its commands wait on the card with it, for a person to approve.'
    : 'Its commands were not applied: it does not run at Don’t ask.';
}

/** Who is calling `tasks_update`, as the tool resolves it. */
export interface AllowListUpdateCaller {
  /** The caller, as the agent-mode decision reads it. */
  caller: AgentModeCaller;
  /** The caller's verified home, when DorkOS can name one. */
  callerAgentPath?: string;
}

/**
 * `tasks_update` with `allowList`: a narrowing in a call of its own. Refused
 * when it names any other field, when the caller may not edit the task, and
 * when it adds a command (that asks a person, through `requestedAllow`).
 * Otherwise audited and written, with no card, and the task list told.
 *
 * @param deps - The tool dependencies.
 * @param args - The call's arguments.
 * @param who - Who is calling.
 */
export async function updateAllowListAlone(
  deps: McpToolDeps,
  args: { id: string } & Record<string, unknown>,
  who: AllowListUpdateCaller
): Promise<ReturnType<typeof jsonContent>> {
  if (Object.keys(args).some((key) => key !== 'id' && key !== 'allowList')) {
    return jsonContent(LIST_ALONE_REFUSAL, true);
  }
  const existing = deps.taskStore!.getTask(args.id);
  if (!existing) return jsonContent({ error: `Schedule ${args.id} not found` }, true);
  const editor = who.callerAgentPath
    ? { kind: 'agent' as const, agentPath: who.callerAgentPath }
    : { kind: 'unidentified' as const };
  const edit = scheduleEdit(existing, editor, deps.meshCore, { allowList: args.allowList });
  if (edit.refusal) return jsonContent(edit.refusal, true);
  const settled = await settleAllowListCall(deps, {
    door: 'update',
    body: { allowList: args.allowList },
    task: existing,
    caller: who.caller,
  });
  if (settled.kind === 'refused') return jsonContent(settled.body, true);
  if (settled.kind === 'none') return jsonContent({ schedule: existing });
  const updated = writeAllowList(deps, existing, settled.write, who.caller);
  if (!updated) return jsonContent(NOT_RECORDED_REFUSAL, true);
  broadcastTasksChanged();
  return jsonContent({ schedule: updated });
}

/**
 * A create's one-shot shape, refused when it names both a cron and `runOnce`
 * (a one-shot task has no cron), a list without `runOnce` (a list rides only a
 * one-shot task in this release), or a list beside `requestedAllow`.
 *
 * @param args - The create's `cron`, `runOnce` and `allowList`.
 */
export function oneShotCreateRefusal(args: {
  cron?: string;
  runOnce?: true;
  allowList?: string[];
  requestedAllow?: string[];
}): { error: string } | null {
  if (args.runOnce && args.cron) {
    return { error: 'A one-shot task has no cron. Leave `cron` out, or drop `runOnce`.' };
  }
  if (args.allowList !== undefined && !args.runOnce) {
    return { error: '`allowList` rides a one-shot task only. Set `runOnce: true`.' };
  }
  if (args.allowList !== undefined && args.requestedAllow !== undefined) {
    return { error: 'Send `allowList` or `requestedAllow`, not both.' };
  }
  return null;
}

function refusal(code: string, message: string): AllowListSettlement {
  return { kind: 'refused', body: { error: AGENT_MODE_REFUSAL_ERROR, code, message } };
}
