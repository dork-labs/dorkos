import type { PermissionMode, UpdateTaskRequest } from '@dorkos/shared/types';
import type { TaskApprovalInput } from '../approvals/task-approval-receipt.js';
import type { TimingLandsOn } from '../timing/effective-timing.js';

/** Server-side input for creating a task from an API or MCP proposal. */
export interface CreateTaskStoreInput {
  name: string;
  displayName?: string;
  description: string;
  prompt: string;
  cron?: string | null;
  timezone?: string | null;
  agentId?: string | null;
  enabled?: boolean;
  sticky?: boolean;
  maxRuntime?: number | null;
  permissionMode?: string;
  requestedPermissionMode?: PermissionMode | null;
  requestedAllow?: string[] | null;
  runtime?: string | null;
  model?: string | null;
  effort?: string | null;
  account?: string | null;
  filePath: string;
  reason?: string | null;
  proposedBySessionId?: string | null;
  proposedByAgentPath?: string | null;
  approval?: TaskApprovalInput | null;
}

/** How a task update writes timing and records an activation. */
export interface UpdateTaskOptions {
  /** Who approved an activation; omitted fails closed to policy/unknown. */
  approval?: TaskApprovalInput;
  /** Whether cron and timezone write file values or a row override. */
  timingLandsOn: TimingLandsOn;
}

/** An update that changes no timing fields. */
export type UntimedTaskUpdate = Omit<UpdateTaskRequest, 'cron' | 'timezone' | 'resetTiming'> & {
  cron?: never;
  timezone?: never;
  resetTiming?: never;
};

/** Options accepted by an update that carries no timing. */
export type UntimedTaskUpdateOptions = Pick<UpdateTaskOptions, 'approval'>;
