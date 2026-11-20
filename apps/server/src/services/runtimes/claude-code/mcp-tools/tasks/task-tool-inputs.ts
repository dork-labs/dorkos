import { z } from 'zod';
import {
  EffortLevelSchema,
  PermissionModeSchema,
  TaskNameSchema,
  TaskPermissionRulesSchema,
  TASK_DURATION_MAX,
  TASK_DURATION_PATTERN,
} from '@dorkos/shared/schemas';
import type { EffortLevel, PermissionMode } from '@dorkos/shared/types';
import {
  ACCEPT_FILE_HASH_DESCRIPTION,
  ACCOUNT_DESCRIPTION,
  EFFORT_DESCRIPTION,
  MODEL_DESCRIPTION,
  REASON_DESCRIPTION,
  REFUSED_AGENT_ID_DESCRIPTION,
  REFUSED_APPROVED_ALLOW_DESCRIPTION,
  REFUSED_LOOSER_CONFIRMATION_DESCRIPTION,
  REFUSED_PERMISSION_MODE_DESCRIPTION,
  REFUSED_STATUS_DESCRIPTION,
  REFUSED_UPDATE_TARGET_DESCRIPTION,
  REQUESTED_ALLOW_DESCRIPTION,
  REQUESTED_PERMISSION_MODE_DESCRIPTION,
  RESET_TIMING_DESCRIPTION,
  RUNTIME_DESCRIPTION,
  STATUS_DESCRIPTION,
  STICKY_DESCRIPTION,
  READS_OUTSIDE_TEXT_DESCRIPTION,
  TARGET_DESCRIPTION,
  TIMEZONE_DESCRIPTION,
} from './task-tool-copy.js';
import { ALLOW_LIST_ARG, RUN_ONCE_ARG } from './task-tool-allow-list.js';

const durationArgument = z
  .string()
  .min(1)
  .max(TASK_DURATION_MAX)
  .regex(TASK_DURATION_PATTERN)
  .optional();

const permissionProposalInputs = {
  requestedPermissionMode: PermissionModeSchema.optional().describe(
    REQUESTED_PERMISSION_MODE_DESCRIPTION
  ),
  requestedAllow: TaskPermissionRulesSchema.optional().describe(REQUESTED_ALLOW_DESCRIPTION),
  approvedAllow: TaskPermissionRulesSchema.optional().describe(REFUSED_APPROVED_ALLOW_DESCRIPTION),
  acceptLooserThanRequested: z
    .literal(true)
    .optional()
    .describe(REFUSED_LOOSER_CONFIRMATION_DESCRIPTION),
};

/** Validated MCP arguments shared by the create handler and its public definition. */
export const CREATE_TASK_INPUT = {
  name: z.string().describe('Name for the scheduled task'),
  prompt: z.string().describe('The prompt to send to the agent on each run'),
  cron: z
    .string()
    .optional()
    .describe(
      'Cron expression (e.g., "0 2 * * *" for daily at 2am). Left out only with `runOnce`.'
    ),
  runOnce: RUN_ONCE_ARG,
  allowList: ALLOW_LIST_ARG,
  reason: z.string().describe(REASON_DESCRIPTION),
  target: z.string().min(1).optional().describe(TARGET_DESCRIPTION),
  description: z.string().optional().describe('Description of what this scheduled task does'),
  timezone: z.string().optional().describe(TIMEZONE_DESCRIPTION),
  maxRuntime: durationArgument.describe('Maximum run time (e.g., "5m", "1h")'),
  sticky: z.boolean().optional().describe(STICKY_DESCRIPTION),
  readsOutsideText: z.boolean().optional().describe(READS_OUTSIDE_TEXT_DESCRIPTION),
  runtime: z.string().min(1).optional().describe(RUNTIME_DESCRIPTION),
  model: z.string().min(1).optional().describe(MODEL_DESCRIPTION),
  effort: EffortLevelSchema.optional().describe(EFFORT_DESCRIPTION),
  account: z.string().min(1).optional().describe(ACCOUNT_DESCRIPTION),
  ...permissionProposalInputs,
  permissionMode: z.string().optional().describe(REFUSED_PERMISSION_MODE_DESCRIPTION),
  status: z.string().optional().describe(REFUSED_STATUS_DESCRIPTION),
  agentId: z.string().optional().describe(REFUSED_AGENT_ID_DESCRIPTION),
};

/** Validated MCP arguments shared by the update handler and its public definition. */
export const UPDATE_TASK_INPUT = {
  id: z.string().describe('Schedule ID to update'),
  name: TaskNameSchema.optional().describe('New name (lowercase kebab-case slug)'),
  prompt: z.string().optional().describe('New prompt'),
  cron: z.string().optional().describe('New cron expression'),
  enabled: z.boolean().optional().describe('Enable or disable the schedule'),
  timezone: z.string().optional().describe('New timezone'),
  maxRuntime: durationArgument.describe('New max runtime (e.g., "5m", "1h")'),
  sticky: z.boolean().optional().describe(STICKY_DESCRIPTION),
  readsOutsideText: z.boolean().optional().describe(READS_OUTSIDE_TEXT_DESCRIPTION),
  runtime: z.string().min(1).nullable().optional().describe(RUNTIME_DESCRIPTION),
  model: z.string().min(1).nullable().optional().describe(MODEL_DESCRIPTION),
  effort: EffortLevelSchema.nullable().optional().describe(EFFORT_DESCRIPTION),
  account: z.string().min(1).nullable().optional().describe(ACCOUNT_DESCRIPTION),
  ...permissionProposalInputs,
  allowList: ALLOW_LIST_ARG,
  resetTiming: z.literal(true).optional().describe(RESET_TIMING_DESCRIPTION),
  acceptFileHash: z.string().optional().describe(ACCEPT_FILE_HASH_DESCRIPTION),
  permissionMode: z.string().optional().describe(REFUSED_PERMISSION_MODE_DESCRIPTION),
  status: z.string().optional().describe(STATUS_DESCRIPTION),
  target: z.string().optional().describe(REFUSED_UPDATE_TARGET_DESCRIPTION),
  agentId: z.string().optional().describe(REFUSED_AGENT_ID_DESCRIPTION),
};

/**
 * What `tasks_create` is called with: the fields of {@link CREATE_TASK_INPUT}, as
 * its handler in `task-tools.ts` reads them.
 */
export type CreateScheduleArgs = {
  name: string;
  prompt: string;
  /** Left out only for a one-shot task (DOR-4315). */
  cron?: string;
  /** A one-shot task (DOR-4315); see `task-tool-allow-list.ts`. */
  runOnce?: true;
  /** A one-shot task's exact commands (DOR-4315); see `task-tool-allow-list.ts`. */
  allowList?: string[];
  reason: string;
  /** Left out means `global`, which files it under the caller (DOR-4067). */
  target?: string;
  description?: string;
  timezone?: string;
  maxRuntime?: string;
  /** Whether every run resumes one session; see {@link STICKY_DESCRIPTION}. */
  sticky?: boolean;
  /** Whether the task reads outside text; see {@link READS_OUTSIDE_TEXT_DESCRIPTION}. */
  readsOutsideText?: boolean;
  /** Which runtime the runs execute on; see {@link RUNTIME_DESCRIPTION}. */
  runtime?: string;
  /** Which model the runs execute on; see {@link MODEL_DESCRIPTION}. */
  model?: string;
  /** How hard the model thinks; see {@link EFFORT_DESCRIPTION}. */
  effort?: EffortLevel;
  /** Which Claude account the runs start on; see {@link ACCOUNT_DESCRIPTION}. */
  account?: string;
  /** Mode requested for person approval; never applied by this tool. */
  requestedPermissionMode?: PermissionMode;
  /** Task-run rules requested for person approval; never applied by this tool. */
  requestedAllow?: string[];
  /** Refused: only a person applies task-run rules. */
  approvedAllow?: string[];
  /** Refused: only a person confirms a looser grant. */
  acceptLooserThanRequested?: true;
  /** Refused, or decided as `tasks.set_mode` (DOR-3703); see {@link REFUSED_PERMISSION_MODE_DESCRIPTION}. */
  permissionMode?: string;
  /** Refused: a new task never approves itself; see {@link REFUSED_STATUS_DESCRIPTION}. */
  status?: string;
  /** Advertised so it can be REFUSED; see {@link REFUSED_AGENT_ID_DESCRIPTION}. */
  agentId?: string;
};
