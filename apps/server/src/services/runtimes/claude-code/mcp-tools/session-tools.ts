/**
 * MCP tools that start sessions. Today one: `session_start`, which lets an agent
 * start a new session, optionally on a named account (spec
 * `claude-account-fleet` D5).
 *
 * The single source for the tool's name, description and input schema on BOTH
 * MCP servers: the external `/mcp` server projects these through
 * `registerFromDefinitions` (see `core/external-mcp/session-tools.ts`).
 *
 * ## What an agent can and cannot get from it
 *
 * - **No trust stop of the operator's.** The session is launched with the
 *   `agent-launch` origin, which seeds no permission mode. The only power it
 *   gets is the tool's own `permissionMode`, clamped by the same rule an
 *   agent-proposed schedule gets (never `bypassPermissions`).
 * - **No account the operator has not opened to agents.** A named account is
 *   checked by `checkAccountLaunch`: with no account advisor registered (the
 *   Flow extension), naming one is refused. Leaving it out walks the usual
 *   ladder, exactly as a person's launch does.
 * - **No pile-up.** Every launch counts against `AGENT_LAUNCH_MAX_LIVE` in the
 *   launch service, released when its turn settles.
 *
 * @module services/runtimes/claude-code/mcp-tools/session-tools
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  EffortLevelSchema,
  PermissionModeSchema,
  SEED_CONTEXT_MAX_LENGTH,
} from '@dorkos/shared/schemas';
import {
  IMPLICIT_ACCOUNT_ID,
  LEDGER_RUNTIMES,
  type LedgerRuntime,
} from '@dorkos/shared/account-usage';
import { sessionPath } from '@dorkos/shared/session-link';
import type { EffortLevel, PermissionMode } from '@dorkos/shared/types';
import { validateBoundaryOrDorkHome } from '../../../../lib/boundary.js';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { checkAccountLaunch } from '../../../core/usage/account-ranking.js';
import { getAccountUsageStore } from '../../../core/usage/current-usage-store.js';
import { resolveAccountRef, type RuntimeAccount } from '../../../core/usage/runtime-accounts.js';
import {
  dispatchSessionMessage,
  isAgentLaunchCapFull,
  isSessionLaunchRefusal,
  resolveRuntimeTypeForNewSession,
  AGENT_LAUNCH_CAP_MESSAGE,
} from '../../../session/launch/launch-session.js';
import { clampSchedulePermissionMode } from '../../../tasks/schedule-permission-clamp.js';
import type { McpToolDeps } from './types.js';
import { jsonContent } from './types.js';

/** The client id every `session_start` launch holds its session's write lock under. */
export const SESSION_START_CLIENT_ID = 'mcp:session_start';

/** The actor label for a call nobody can name: the sessionless external `/mcp` server. */
const EXTERNAL_CALLER_LABEL = 'external MCP';

/**
 * Who is calling, resolved at CALL time: the agent home of the session the tool
 * runs in. Absent on the external `/mcp` server, which carries no session.
 */
export type SessionStartCallerResolver = () => { agentPath?: string } | undefined;

/** The input `session_start` accepts. */
export const SessionStartInputShape = {
  prompt: z.string().min(1).describe('The first message of the new session.'),
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
    'The permission mode the session starts in. `bypassPermissions` is lowered to ' +
      '`acceptEdits`. Absent: the runtime default, which asks before acting.'
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
    .describe('The folder of a registered agent the session belongs to.'),
};

/** Parsed `session_start` arguments. */
export interface SessionStartArgs {
  prompt: string;
  cwd: string;
  account?: string;
  runtime?: string;
  model?: string;
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
  seedContext?: string;
  agentPath?: string;
}

/** The result of a started session. */
export interface SessionStartResult {
  /** The session's canonical id. */
  sessionId: string;
  /** The runtime it runs on. */
  runtime: string;
  /** The account it was started on, or `null` when the usual choice decides. */
  account: { id: string; label: string | null } | null;
  /** Always `started`: a refusal is an error result instead. */
  status: 'started';
}

function refuse(error: string, code: string) {
  return jsonContent({ error, code }, true);
}

function isLedgerRuntime(runtime: string): runtime is LedgerRuntime {
  return (LEDGER_RUNTIMES as readonly string[]).includes(runtime);
}

/**
 * The account a `session_start` call names, on a runtime that has accounts.
 * `default` resolves to its alias row when it has one.
 */
function findAccount(runtime: string, id: string): RuntimeAccount | null {
  const store = getAccountUsageStore();
  if (!store || !isLedgerRuntime(runtime)) return null;
  return resolveAccountRef(store.listAccounts(runtime), runtime, id);
}

/** Who the Activity entry names: the calling agent, else the external server. */
function callerOf(
  deps: McpToolDeps,
  resolveCaller: SessionStartCallerResolver | undefined
): { label: string; agentPath?: string } {
  if (!resolveCaller) return { label: EXTERNAL_CALLER_LABEL };
  const agentPath = resolveCaller()?.agentPath;
  const agent = agentPath
    ? deps.meshCore?.listWithPaths().find((a) => a.projectPath === agentPath)
    : undefined;
  return {
    label: agent ? (agent.displayName ?? agent.name) : 'An agent',
    ...(agentPath ? { agentPath } : {}),
  };
}

/**
 * Handler factory for `session_start`.
 *
 * Every check runs before anything is written, in this order: the folder, the
 * agent, the runtime, the account (and its policy), the launch cap. Only then
 * does the new session's settings row take the model, effort and clamped mode,
 * and the launch service start the turn.
 *
 * @param deps - Shared MCP tool dependencies (Mesh, Activity).
 * @param resolveCaller - Who is calling; absent on the external `/mcp` server.
 */
export function createSessionStartHandler(
  deps: McpToolDeps,
  resolveCaller?: SessionStartCallerResolver
) {
  return async (args: SessionStartArgs) => {
    if (!path.isAbsolute(args.cwd)) {
      return refuse(`The cwd must be an absolute path: ${args.cwd}`, 'INVALID_CWD');
    }
    let cwd: string;
    try {
      // The session-cwd check the session routes use: the boundary, plus the
      // agents folder under the data directory, where DorkBot lives.
      cwd = await validateBoundaryOrDorkHome(args.cwd);
    } catch (err) {
      return refuse(err instanceof Error ? err.message : String(err), 'OUTSIDE_BOUNDARY');
    }

    if (
      args.agentPath !== undefined &&
      !deps.meshCore?.listWithPaths().some((agent) => agent.projectPath === args.agentPath)
    ) {
      return refuse('Choose a registered agent before starting this session', 'INVALID_AGENT_PATH');
    }

    const runtimeType = await resolveRuntimeTypeForNewSession({
      runtimeHint: args.runtime,
      agentPath: args.agentPath,
      cwd,
    });
    if (!runtimeRegistry.has(runtimeType)) {
      return refuse(`Unknown runtime: ${runtimeType}`, 'UNKNOWN_RUNTIME');
    }
    const runtime = runtimeRegistry.get(runtimeType);

    let account: RuntimeAccount | null = null;
    if (args.account !== undefined) {
      if (!runtime.getCapabilities().supportsAccounts) {
        // `default` on a runtime without accounts is what it would get anyway.
        if (args.account !== IMPLICIT_ACCOUNT_ID) {
          return refuse(
            `The ${runtimeType} runtime has no accounts to choose from. Leave out account, or use default.`,
            'ACCOUNT_NOT_SUPPORTED'
          );
        }
      } else {
        account = findAccount(runtimeType, args.account);
        if (!account) {
          return refuse(
            `No Claude account with id ${args.account} is registered.`,
            'UNKNOWN_ACCOUNT'
          );
        }
        const decision = await checkAccountLaunch({
          accountId: account.id,
          cwd,
          runtime: runtimeType,
          caller: 'agent',
        });
        if (!decision.allowed) return refuse(decision.reason, 'ACCOUNT_REFUSED');
      }
    }

    // Asked here too, before the settings write below, so a full cap leaves no
    // row behind. The launch service's own check is the one that holds a slot.
    if (isAgentLaunchCapFull()) return refuse(AGENT_LAUNCH_CAP_MESSAGE, 'LAUNCH_CAP_FULL');

    const sessionId = crypto.randomUUID();
    const permissionMode = args.permissionMode
      ? clampSchedulePermissionMode(args.permissionMode).mode
      : undefined;
    // What the pre-launch picker writes, written the same way: onto the new
    // session's settings row before the first send, which the binding write
    // then fills around without overwriting.
    if (args.model !== undefined || args.effort !== undefined || permissionMode !== undefined) {
      await runtime.updateSession(sessionId, {
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.effort !== undefined ? { effort: args.effort } : {}),
        ...(permissionMode !== undefined ? { permissionMode } : {}),
      });
    }

    const result = await dispatchSessionMessage({
      origin: { kind: 'agent-launch' },
      sessionId,
      request: {
        content: args.prompt,
        cwd,
        runtime: runtimeType,
        ...(account ? { account: account.id } : {}),
        ...(args.agentPath !== undefined ? { agentPath: args.agentPath } : {}),
        ...(args.seedContext !== undefined ? { seedContext: args.seedContext } : {}),
      },
      clientId: SESSION_START_CLIENT_ID,
      meshCore: deps.meshCore,
      // A session minted here is in no room.
      roomSessionPlace: undefined,
      countsTowardLaunchCap: true,
    });
    if (isSessionLaunchRefusal(result)) return refuse(result.message, result.refused);
    if (!result.accepted) {
      return refuse('The session could not be started.', 'NOT_STARTED');
    }

    const canonicalId = result.canonicalId ?? sessionId;
    const caller = callerOf(deps, resolveCaller);
    const accountName = account ? (account.label ?? account.id) : null;
    void deps.activityService?.emit({
      actorType: 'agent',
      actorLabel: caller.label,
      ...(caller.agentPath ? { actorId: caller.agentPath } : {}),
      category: 'agent',
      eventType: 'agent.session_started',
      resourceType: 'session',
      resourceId: canonicalId,
      summary: accountName
        ? `Started a session in ${cwd} on the account ${accountName}`
        : `Started a session in ${cwd}`,
      linkPath: sessionPath({ session: canonicalId }),
      metadata: { cwd, runtime: runtimeType, account: account?.id ?? null },
    });

    const body: SessionStartResult = {
      sessionId: canonicalId,
      runtime: runtimeType,
      account: account ? { id: account.id, label: account.label } : null,
      status: 'started',
    };
    return jsonContent(body);
  };
}

/**
 * The session tool definitions.
 *
 * @param deps - Shared MCP tool dependencies.
 * @param resolveCaller - Who is calling; absent on the external `/mcp` server.
 */
export function getSessionTools(deps: McpToolDeps, resolveCaller?: SessionStartCallerResolver) {
  return [
    tool(
      'session_start',
      'Start a new agent session with a first message, in a folder, and return its id at once ' +
        '(the session then works on its own). Optionally on a named account (the account usage ' +
        'tool lists them), which the account policy must allow; otherwise the usual account is ' +
        'used. The session gets no permission mode it was not given here, and ' +
        '`bypassPermissions` is lowered to `acceptEdits`. At most 8 sessions started this way ' +
        'run at once.',
      SessionStartInputShape,
      createSessionStartHandler(deps, resolveCaller)
    ),
  ];
}
