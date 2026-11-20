/**
 * `tasks_update` moving an agent's own live Bypass task to Don't ask with the
 * exact commands its runs need (DOR-4315 PR 2, Security's ruling of Nov 18).
 * A task that already runs every command without asking only loses power when
 * it runs at Don't ask with a pinned list, so this is a narrowing, with no card.
 *
 * - **One call, the mode and the list together:** `id`, `permissionMode:
 *   "dontAsk"` and `allowList`, nothing else. Neither lands without the other.
 * - **The rule is read again at write time** (Must 1): just before the file is
 *   written, the task must still be exactly what the decision read (its work,
 *   its SKILL file, its Bypass mode, `active`, the same agent and last editor);
 *   and inside the transaction that writes the row, still at Bypass and
 *   `active`. A person lowering it mid-call stops this rather than turning it
 *   into a widening with no card.
 * - **The file goes first:** the mode is read back from it on every sync, and
 *   a file at Don't ask with no list yet only asks less of nothing: it refuses
 *   every command. The list lands with the row, never ahead of the mode.
 * - **The list is the agent's** (Must 2): every entry is re-judged and pinned,
 *   and audited as `via: narrow_from_bypass`, never as a person's approval.
 *
 * @module services/runtimes/claude-code/mcp-tools/tasks/task-tool-narrow-bypass
 */
import type { Task } from '@dorkos/shared/types';
import type { McpToolDeps } from '../types.js';
import { jsonContent } from '../types.js';
import { scheduleEdit } from '../../../../tasks/approvals/schedule-owner.js';
import { broadcastTasksChanged } from '../../../../tasks/task-sse-events.js';
import { agentModeSnapshotOf } from '../../../../tasks/agent-mode/agent-mode-door.js';
import { AGENT_MODE_REFUSAL_ERROR } from '../../../../tasks/agent-mode/agent-mode-copy.js';
import { applyTaskFileUpdate } from '../../../../tasks/lifecycle/update-task-file.js';
import { scheduleContentKey, taskWorkOf } from '../../../../tasks/schedule-permission-clamp.js';
import { ALLOW_LIST_MODE } from '../../../../tasks/allow-list/allow-list-rule.js';
import {
  NOT_RECORDED_REFUSAL,
  NOT_TOLD_REFUSAL,
  auditToolModeChange,
  recordToolModeOutcome,
  settleToolModeCall,
} from './task-tool-mode.js';
import { agentModeControlOn } from '../../../../tasks/agent-mode/agent-mode-actions.js';
import {
  auditAllowListAborted,
  auditAllowListChange,
  settleAllowListCall,
  updateAllowListAlone,
  type AllowListUpdateCaller,
} from './task-tool-allow-list.js';

/** The refusal when the task changed while the call was being decided. */
export const NARROW_CHANGED_REFUSAL = {
  error: AGENT_MODE_REFUSAL_ERROR,
  code: 'task_changed',
  message:
    'The task changed while DorkOS was moving it to Don’t ask, so nothing changed. Read it ' +
    'again, then decide.',
} as const;

/** The refusal when the call sends an empty list: that is a mode change alone. */
export const NARROW_EMPTY_REFUSAL = {
  error: AGENT_MODE_REFUSAL_ERROR,
  code: 'allow_list_empty',
  message: 'To move it to Don’t ask with no commands, send `permissionMode` alone.',
} as const;

/**
 * Whether a `tasks_update` call is a move to Don't ask with a list: `id`,
 * `permissionMode: "dontAsk"` and `allowList`, and nothing else.
 *
 * @param args - The call's arguments.
 */
export function namesMoveToDontAsk(args: Record<string, unknown>): boolean {
  const keys = Object.keys(args);
  return (
    args.permissionMode === ALLOW_LIST_MODE &&
    args.allowList !== undefined &&
    keys.every((key) => key === 'id' || key === 'permissionMode' || key === 'allowList')
  );
}

/**
 * `tasks_update` with `allowList`: a move off Bypass when the call names the
 * mode with it, otherwise a narrowing in a call of its own (PR 1).
 *
 * @param deps - The tool dependencies.
 * @param args - The call's own arguments object, the one the tool gate saw.
 * @param who - Who is calling.
 */
export function updateTaskAllowList(
  deps: McpToolDeps,
  args: { id: string } & Record<string, unknown>,
  who: AllowListUpdateCaller
): Promise<ReturnType<typeof jsonContent>> {
  return namesMoveToDontAsk(args)
    ? moveToDontAskWithList(deps, args, who)
    : updateAllowListAlone(deps, args, who);
}

/**
 * Move a live Bypass task to Don't ask with an exact list, or change nothing.
 *
 * @param deps - The tool dependencies.
 * @param args - The call's own arguments object (`id`, `permissionMode`, `allowList`), the one
 *   the tool gate saw, so its grant can be read back.
 * @param who - Who is calling.
 */
export async function moveToDontAskWithList(
  deps: McpToolDeps,
  args: { id: string } & Record<string, unknown>,
  who: AllowListUpdateCaller
): Promise<ReturnType<typeof jsonContent>> {
  const store = deps.taskStore!;
  const existing = store.getTask(args.id);
  if (!existing) return jsonContent({ error: `Schedule ${args.id} not found` }, true);
  if (Array.isArray(args.allowList) && args.allowList.length === 0) {
    return jsonContent(NARROW_EMPTY_REFUSAL, true);
  }
  const editor = who.callerAgentPath
    ? { kind: 'agent' as const, agentPath: who.callerAgentPath }
    : { kind: 'unidentified' as const };
  const edit = scheduleEdit(existing, editor, deps.meshCore, {
    permissionMode: args.permissionMode,
    allowList: args.allowList,
  });
  if (edit.refusal) return jsonContent(edit.refusal, true);

  // The mode, decided as every agent mode change is (DOR-3703), on the body the gate saw.
  const { id: _id, ...fields } = args;
  const mode = await settleToolModeCall(deps, {
    door: 'update',
    body: fields,
    input: args,
    task: existing,
    caller: who.caller,
  });
  if (mode.refusal) return jsonContent(mode.refusal, true);
  if (!mode.grant?.decision.setsMode) {
    return jsonContent(agentModeControlOn() ? NO_MODE_REFUSAL : OFF_REFUSAL, true);
  }
  // The list, judged as a move off Bypass (or refused, naming `requestedAllow`).
  const settled = await settleAllowListCall(deps, {
    door: 'update',
    body: { allowList: args.allowList, permissionMode: args.permissionMode },
    task: existing,
    caller: who.caller,
    movesToDontAsk: true,
  });
  if (settled.kind === 'refused') return jsonContent(settled.body, true);
  if (settled.kind !== 'write') return jsonContent(NARROW_EMPTY_REFUSAL, true);
  const write = settled.write;

  // Must 1: the task as the decision read it, compared again before each write.
  const readNow = () => {
    const now = store.getTask(existing.id);
    return now ? { now, key: snapshotOf(deps, now) } : null;
  };
  const decidedOn = snapshotOf(deps, existing);
  const stillSo = () => readNow()?.key === decidedOn;
  if (!stillSo()) return jsonContent(NARROW_CHANGED_REFUSAL, true);

  // Audited before anything is written, or nothing is written (S-D).
  if (!auditToolModeChange(deps, mode, existing)) return jsonContent(NOT_RECORDED_REFUSAL, true);
  if (!auditAllowListChange(existing, write, who.caller)) {
    return jsonContent(NOT_RECORDED_REFUSAL, true);
  }

  const fileOutcome = await applyTaskFileUpdate(
    { dorkHome: deps.dorkHome, ...(deps.meshCore && { meshCore: deps.meshCore }) },
    { existing, data: { permissionMode: ALLOW_LIST_MODE }, reviewStillMatches: stillSo }
  );
  if (!fileOutcome.ok) {
    auditAllowListAborted(
      existing,
      write,
      who.caller,
      fileOutcome.code ?? 'file_not_written',
      ALLOW_LIST_MODE
    );
    return jsonContent(
      {
        error: fileOutcome.error,
        ...(fileOutcome.code !== undefined && { code: fileOutcome.code }),
      },
      true
    );
  }

  let updated: Task | null;
  try {
    updated = store.approvals.inTransaction(() => {
      const now = store.getTask(existing.id);
      if (!now || rowKeyOf(store, now) !== rowKeyOf(store, existing)) {
        throw new Error('the task changed while it was moving to Don’t ask');
      }
      const requested = now.requestedAllow?.filter((rule) => !write.removed.includes(rule));
      store.updateTask(now.id, { permissionMode: ALLOW_LIST_MODE });
      store.runControls.set(now.id, {
        approvedAllow: write.after,
        allowListPins: write.pins,
        ...(requested !== undefined && { requestedAllow: requested }),
      });
      return store.getTask(now.id);
    });
  } catch {
    // The file already says Don't ask and the row was left as the person set it. Not
    // put back to Bypass, which could undo the person's change; the next sync reads the
    // file, which only narrows what the task runs. Said plainly, and recorded.
    auditAllowListAborted(existing, write, who.caller, 'task_changed');
    return jsonContent(CHANGED_AFTER_FILE_REFUSAL, true);
  }
  if (!updated) return jsonContent({ error: `Schedule ${args.id} not found` }, true);

  // The task as written: its list is the agent's, and the record says so (Must 2).
  const stands = await recordToolModeOutcome(deps, mode, existing, updated, who.caller, false, {
    allowListSetBy: 'agent',
  });
  if (!stands) return jsonContent(NOT_TOLD_REFUSAL, true);
  deps.resolveTaskRegistrar?.()?.syncTask(updated.id);
  broadcastTasksChanged();
  return jsonContent({
    schedule: updated,
    note:
      `It now runs at Don’t ask and may run ${write.after.length} command(s) without asking. ` +
      'DorkOS checks each program before every run.',
  });
}

/** The refusal when agents can't change a task's mode on this install. */
const OFF_REFUSAL = {
  error: AGENT_MODE_REFUSAL_ERROR,
  code: 'allow_list_off',
  message: 'Agents can’t change a task’s mode on this DorkOS.',
} as const;

/** The refusal when the mode change settled to nothing to set. */
const NO_MODE_REFUSAL = {
  error: AGENT_MODE_REFUSAL_ERROR,
  code: 'mode_not_set',
  message: 'DorkOS could not settle the move to Don’t ask, so nothing changed.',
} as const;

/** The refusal when the task changed after its file was already moved to Don't ask. */
export const CHANGED_AFTER_FILE_REFUSAL = {
  error: AGENT_MODE_REFUSAL_ERROR,
  code: 'task_changed',
  message:
    'The task changed while DorkOS was moving it. Its file now says Don’t ask with no ' +
    'commands, so it runs no commands without asking. Read it again before you change it.',
} as const;

/** What the move was decided against: {@link agentModeSnapshotOf}, mode included. */
function snapshotOf(deps: McpToolDeps, task: Task): string {
  const edits = deps.taskStore!.approvals.agentEditsOf(task.id);
  return agentModeSnapshotOf(task, edits, { setsMode: false });
}

/** The row half of the snapshot, for the transaction: the file was just rewritten. */
function rowKeyOf(store: NonNullable<McpToolDeps['taskStore']>, task: Task): string {
  const edits = store.approvals.agentEditsOf(task.id);
  return JSON.stringify([
    scheduleContentKey(taskWorkOf(task)),
    task.permissionMode,
    task.status,
    task.agentId ?? null,
    edits?.lastEditedByAgentPath ?? null,
    edits?.lastEditedBySessionId ?? null,
    task.approvedAllow ?? null,
  ]);
}
