/**
 * The `session_start` tool's contract: the input it accepts, the arguments it
 * parses to and the result it returns. Split out of `session-tools.ts`, which
 * holds the handler that enforces it.
 *
 * @module services/runtimes/claude-code/mcp-tools/session-start/input
 */
import { z } from 'zod';
import {
  EffortLevelSchema,
  PermissionModeSchema,
  SEED_CONTEXT_MAX_LENGTH,
} from '@dorkos/shared/schemas';
import { START_WORK_LIMITS } from '@dorkos/shared/extension-decision-schemas';
import type { EffortLevel } from '@dorkos/shared/types';
import type { SessionStartPermission } from '../session-start-permission.js';
import { CLAIM_KEY_MAX_LENGTH } from '../../../../session/claims/work-claim-service.js';
import type { SessionAlreadyRunningResult } from '../../../../session/claims/work-claim-start.js';

/** The input `session_start` accepts. */
export const SessionStartInputShape = {
  prompt: z.string().min(1).describe('The first message of the new session.'),
  title: z
    .string()
    .trim()
    .max(START_WORK_LIMITS.title)
    .optional()
    .describe(
      'A short, plain title people see in the sidebar and tabs, like "Rooms: always answer ' +
        'people" (at most 80 characters). Write one: without it the title comes from `reason`, ' +
        'or is "Started by <you>".'
    ),
  cwd: z
    .string()
    .min(1)
    .describe('Absolute path of the folder the session works in. Must be inside the boundary.'),
  account: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The account to run and bill the session on: a registry id the account usage tool lists, or ' +
        "`default` for this computer's own sign-in. Only for a runtime that has accounts " +
        '(Claude Code). Naming one needs the account policy (the Flow extension) to allow it. ' +
        "Leave it out to use the usual choice: the agent's own account, else the default."
    ),
  runtime: z
    .string()
    .min(1)
    .optional()
    .describe('The runtime to start on (e.g. `claude-code`). Absent: the usual choice.'),
  model: z.string().min(1).optional().describe('The model the session starts with.'),
  effort: EffortLevelSchema.optional().describe('The reasoning effort the session starts with.'),
  permissionMode: PermissionModeSchema.optional().describe(
    'The permission mode the session starts in. The session runs at your own permission level ' +
      'unless you ask for a lower one; a higher one is refused. Absent: your own level, except ' +
      'Full autonomy (e.g. `bypassPermissions`), which must be named here to be granted.'
  ),
  seedContext: z
    .string()
    .min(1)
    .max(SEED_CONTEXT_MAX_LENGTH)
    .optional()
    .describe('Background the new session reads with its first message and the person never sees.'),
  agentPath: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Your own agent folder. The session always runs as you, so this can be left out; any ' +
        'other agent is refused.'
    ),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(START_WORK_LIMITS.reason)
    .optional()
    .describe(
      'Why you are starting it, in plain words (at most 200 characters). The new session ' +
        'shows it as its first line: "Started from <this chat>: <reason>".'
    ),
  reportBack: z
    .enum(['auto', 'off'])
    .optional()
    .describe(
      '`auto` (default): whenever the new chat ends a turn finished, failed, needing the ' +
        'person or paused at an account limit, its last message comes back to this chat as a ' +
        'message (from a room, it wakes your chat there with a turn only you see). `off`: it ' +
        'never reports back on its own.'
    ),
  claim: z
    .string()
    .trim()
    .min(1)
    .max(CLAIM_KEY_MAX_LENGTH)
    .optional()
    .describe(
      'The work the new chat takes on, e.g. a ticket id (DOR-1234), "PR #42" or a branch. The ' +
        'new chat claims it, so your other chats see it is taken. Left out, the one ticket or ' +
        'PR the title or reason names (else the prompt) is claimed. When another live chat of ' +
        'yours already holds it, nothing starts: you get that chat back (`status: ' +
        '"already-running"`, even if its turn ended; message it instead), or a refusal when you ' +
        'cannot read it. A claim lapses after 2 hours with no sign of work. Set `startAnyway` ' +
        'to start a second chat without the claim.'
    ),
  startAnyway: z
    .boolean()
    .optional()
    .describe(
      'Start even though another chat of yours holds the claim. That chat keeps the claim.'
    ),
};

/** Parsed `session_start` arguments. */
export interface SessionStartArgs {
  prompt: string;
  title?: string;
  cwd: string;
  account?: string;
  runtime?: string;
  model?: string;
  effort?: EffortLevel;
  permissionMode?: string;
  seedContext?: string;
  agentPath?: string;
  reason?: string;
  reportBack?: 'auto' | 'off';
  claim?: string;
  startAnyway?: boolean;
}

/** The result of a started session. */
export interface SessionStartedResult {
  /** The session's canonical id. */
  sessionId: string;
  /** The chat's title, as the sidebar shows it once the rename lands. */
  title: string;
  /** A markdown link that opens the chat, to use instead of its id. */
  link: string;
  /** Its `dork:chat:` reference, for a `/r/` link, or null when the id cannot be one. */
  ref: string | null;
  /** The runtime it runs on. */
  runtime: string;
  /** The account it was started on, or `null` when the usual choice decides. */
  account: { id: string; label: string | null } | null;
  /** The permission level it runs at. */
  permission: SessionStartPermission;
  /** Always `started`. A refusal is an error result instead. */
  status: 'started';
}

/**
 * What a successful `session_start` answers: the chat it started, or, when one
 * of the caller's own chats already holds the work (DOR-3690), that chat with
 * `status: 'already-running'` and nothing new started.
 */
export type SessionStartResult = SessionStartedResult | SessionAlreadyRunningResult;
