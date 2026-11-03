/**
 * What an agent's approval of a scheduled task is bound to (DOR-3703, Security
 * ruling 7): one SHA-256 over the work and the power together, so an approval
 * never covers a later version of either.
 *
 * The content grant (`scheduleContentKey`) leaves the permission mode out on
 * purpose, and its meaning is not changed here. This is a second key, kept
 * only for an approval an agent gave (`agent_approval_key`): the SKILL file as
 * it is on disk (or the prompt when there is no file), cron, timezone, mode,
 * agent, folder, runtime, account and model, in one canonical JSON form
 * (sorted keys, no whitespace) through the same hasher approval cards use.
 *
 * @module services/tasks/agent-mode/agent-mode-binding
 */
import fs from 'node:fs';
import type { Task } from '@dorkos/shared/types';
import { hashApprovalInput } from '../../core/approvals/approval-input-hash.js';

/** What the binding reads off a task. */
export type BoundTask = Pick<
  Task,
  | 'prompt'
  | 'cron'
  | 'timezone'
  | 'permissionMode'
  | 'agentId'
  | 'runtime'
  | 'account'
  | 'model'
  | 'filePath'
>;

/**
 * The SKILL file's text, or `null` when there is no file or it cannot be read
 * (the prompt stands in for it then, and is always part of the hash).
 *
 * @param filePath - The task's file, `''` for a row with none.
 */
export function skillFileText(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The hash an agent's approval of this task binds to, as `sha256:<base64url>`.
 * Base64url rather than hex because the audit log hides any long hex run as a
 * possible token, and the audit row has to show this hash (Security ruling 8).
 *
 * @param task - The task as it now stands.
 * @param cwd - The folder its runs start in, `null` for a task with no agent.
 */
export function agentApprovalBindingOf(task: BoundTask, cwd: string | null): string {
  return `sha256:${hexToBase64Url(
    hashApprovalInput({
      skill: skillFileText(task.filePath),
      prompt: task.prompt,
      cron: task.cron ?? null,
      timezone: task.timezone ?? null,
      permissionMode: task.permissionMode,
      agentId: task.agentId ?? null,
      cwd,
      runtime: task.runtime ?? null,
      account: task.account ?? null,
      model: task.model ?? null,
    })
  )}`;
}

function hexToBase64Url(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64url');
}
