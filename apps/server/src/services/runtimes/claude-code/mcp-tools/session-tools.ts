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
 * - **Only itself.** The session runs as the calling agent: `agentPath`, when
 *   given, must be the caller's own home, and a folder that is another agent's
 *   home (or inside one) is refused. A caller DorkOS cannot name as a registered
 *   agent is refused outright. Otherwise an agent could start work as DorkBot or
 *   as another agent, with that agent's permissions and its account.
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
 * - **No way around an extension's limits.** The new chat records who started
 *   it (`session_started_by`, spec `flow-multiproject` §7.7): the calling chat,
 *   with an optional `reason`, and the extension at the root of the calling
 *   chat's chain. A chat started from an extension's chat counts against that
 *   extension's start limits, and a start past them is refused.
 *
 * @module services/runtimes/claude-code/mcp-tools/session-tools
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
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
import { START_WORK_LIMITS } from '@dorkos/shared/extension-decision-schemas';
import type { EffortLevel, PermissionMode } from '@dorkos/shared/types';
import { validateBoundaryOrDorkHome } from '../../../../lib/boundary.js';
import { logError, logger } from '../../../../lib/logger.js';
import { isInsideRoomsDir, resolveAgentHome } from '../../../core/agent-identity/index.js';
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
import { getStartWorkService, type StartReservation } from '../../../extensions/start-work.js';
import type { McpToolDeps } from './types.js';
import { jsonContent } from './types.js';

/** The client id every `session_start` launch holds its session's write lock under. */
export const SESSION_START_CLIENT_ID = 'mcp:session_start';

/** The refusal for a caller that is not a registered agent. */
export const UNKNOWN_CALLER_MESSAGE =
  'Only a registered agent can start a session, and DorkOS could not tell which agent is asking.';

/** The refusal for a session that would run as some other agent. */
export const NOT_THE_CALLER_MESSAGE =
  'An agent can start a session only as itself. Leave out agentPath, or give your own folder.';

/** The refusal for a folder that belongs to another agent. */
export const OTHER_AGENTS_HOME_MESSAGE =
  "That folder belongs to another agent. Start the session in a folder that is not another agent's.";

/**
 * Who is calling, resolved at CALL time: the home of the agent making the call.
 * In session, the session's identity anchor; on the external `/mcp` server, the
 * agent the request's token names. `undefined` when neither names one.
 *
 * `sessionId` is the chat the call is made from, in session only: it is who
 * the new chat says started it. The external server has no chat to name.
 */
export type SessionStartCallerResolver = () =>
  { agentPath?: string; sessionId?: string } | undefined;

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
  // Clamped in the schema, not only in the handler, so the arguments the tier
  // gate shows on an approval card are the mode the session actually gets.
  permissionMode: PermissionModeSchema.transform((mode) => clampSchedulePermissionMode(mode).mode)
    .optional()
    .describe(
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
  reason?: string;
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

/** A registered agent, as Mesh lists it. */
interface CallerAgent {
  agentPath: string;
  label: string;
}

/** The calling agent, when it is one Mesh has registered, and the chat it calls from. */
function callerOf(
  deps: McpToolDeps,
  resolveCaller: SessionStartCallerResolver | undefined
): (CallerAgent & { sessionId: string | null }) | null {
  const resolved = resolveCaller?.();
  const agentPath = resolved?.agentPath;
  if (!agentPath) return null;
  const agent = deps.meshCore?.listWithPaths().find((a) => a.projectPath === agentPath);
  return agent
    ? {
        agentPath,
        label: agent.displayName ?? agent.name,
        sessionId: resolved.sessionId ?? null,
      }
    : null;
}

/**
 * Claim a start slot for a chat started from `parentSessionId`, recording who
 * started it. The new chat inherits the parent's origin extension, so it counts
 * against that extension's start limits and is refused past them. Without a
 * calling chat (the external `/mcp` server) or before boot wired the seam,
 * nothing is recorded and nothing is limited here.
 */
function reserveChatStart(
  sessionId: string,
  parentSessionId: string | null,
  reason: string | undefined
): { ok: true; reservation: StartReservation | null } | { ok: false; message: string } {
  const service = getStartWorkService();
  if (!parentSessionId || !service) return { ok: true, reservation: null };
  const claimed = service.reserveFromChat({ sessionId, parentSessionId, reason: reason ?? null });
  return claimed.ok
    ? { ok: true, reservation: claimed.reservation }
    : { ok: false, message: claimed.error.message };
}

/** Whether `dir` is `root` or inside it. */
function isWithin(root: string, dir: string): boolean {
  const rel = path.relative(root, dir);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * A folder's real path, or its resolved spelling when it cannot be read (a
 * folder that does not exist yet). Both sides of a containment check go through
 * this, because the boundary check hands back `cwd` real-pathed while Mesh keeps
 * each home as registered: a home under a symlink (macOS's `/tmp`) would
 * otherwise never contain a `cwd` that is inside it.
 */
function realOr(dir: string): string {
  const resolved = path.resolve(dir);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Whether `cwd` belongs to an agent other than `callerPath`: it resolves to
 * another agent's home (its home, a managed workspace or a linked worktree of
 * it), or it sits inside a registered agent's home that is not the caller's.
 */
function isOtherAgentsFolder(deps: McpToolDeps, cwd: string, callerPath: string): boolean {
  if (resolveAgentHome(cwd, callerPath).kind === 'refused') return true;
  const target = realOr(cwd);
  const owner = (deps.meshCore?.listWithPaths() ?? [])
    .map((agent) => realOr(agent.projectPath))
    .filter((home) => isWithin(home, target))
    // The innermost home is the folder's owner: an agent may keep another's
    // home inside its own, and the one closer to `cwd` is the one standing there.
    .sort((a, b) => b.length - a.length)[0];
  return owner !== undefined && owner !== realOr(callerPath);
}

/**
 * Remove what a launch that never started left under its id. The id was minted
 * by this tool a moment ago, so nothing else can hold it; a failure to delete is
 * logged, never thrown over the refusal the caller is about to get.
 */
async function discardUnstartedSession(sessionId: string): Promise<void> {
  try {
    await runtimeRegistry.discardSessionSettings(sessionId);
  } catch (err) {
    logger.warn('[session_start] could not remove the settings of a session that never started', {
      sessionId,
      ...logError(err),
    });
  }
}

/**
 * Handler factory for `session_start`.
 *
 * Every check runs before anything is written, in this order: the caller, the
 * folder, the agent, the runtime, the account (and its policy), the launch cap.
 * Only then does the new session's settings row take the model, effort and
 * clamped mode, and the launch service start the turn. A launch that is refused
 * after that, throws, or is not accepted has its row removed again.
 *
 * @param deps - Shared MCP tool dependencies (Mesh, Activity).
 * @param resolveCaller - Who is calling.
 */
export function createSessionStartHandler(
  deps: McpToolDeps,
  resolveCaller?: SessionStartCallerResolver
) {
  return async (args: SessionStartArgs) => {
    const caller = callerOf(deps, resolveCaller);
    if (!caller) return refuse(UNKNOWN_CALLER_MESSAGE, 'UNKNOWN_CALLER');

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
    // The launch service refuses this too, but only after the settings write
    // below; asked here, a refused launch leaves nothing behind.
    if (isInsideRoomsDir(cwd)) {
      return refuse(
        `This session would run inside a room's files ("${cwd}"), which is never where an ` +
          `agent works. Start it in the agent's own folder instead.`,
        'DESK_NOT_OWN'
      );
    }

    if (args.agentPath !== undefined && path.resolve(args.agentPath) !== caller.agentPath) {
      return refuse(NOT_THE_CALLER_MESSAGE, 'NOT_THE_CALLER');
    }
    const agentPath = caller.agentPath;
    if (isOtherAgentsFolder(deps, cwd, agentPath)) {
      return refuse(OTHER_AGENTS_HOME_MESSAGE, 'OTHER_AGENTS_FOLDER');
    }

    const runtimeType = await resolveRuntimeTypeForNewSession({
      runtimeHint: args.runtime,
      agentPath,
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
    // Who started it, and the start limits of the extension at the root of the
    // calling chat's chain: asked before the settings write, so a refused start
    // leaves nothing behind.
    const claimed = reserveChatStart(sessionId, caller.sessionId, args.reason);
    if (!claimed.ok) return refuse(claimed.message, 'START_LIMIT');
    const reservation = claimed.reservation;
    // Already clamped by the schema on a real call; clamped again for a direct
    // caller of this handler.
    const permissionMode = args.permissionMode
      ? clampSchedulePermissionMode(args.permissionMode).mode
      : undefined;
    // What the pre-launch picker saves, saved the same way: an unbound settings
    // row the first send reads and the binding write fills around. Only the row:
    // no runtime holds an in-memory session for this id until the send.
    try {
      await runtimeRegistry.saveSessionSettings(sessionId, {
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.effort !== undefined ? { effort: args.effort } : {}),
        ...(permissionMode !== undefined ? { permissionMode } : {}),
      });
    } catch (err) {
      reservation?.cancel();
      throw err;
    }

    let result: Awaited<ReturnType<typeof dispatchSessionMessage>>;
    try {
      result = await dispatchSessionMessage({
        origin: { kind: 'agent-launch' },
        sessionId,
        request: {
          content: args.prompt,
          cwd,
          runtime: runtimeType,
          ...(account ? { account: account.id } : {}),
          agentPath,
          ...(args.seedContext !== undefined ? { seedContext: args.seedContext } : {}),
        },
        clientId: SESSION_START_CLIENT_ID,
        meshCore: deps.meshCore,
        // A session minted here is in no room.
        roomSessionPlace: undefined,
        countsTowardLaunchCap: true,
        onSettled: () => reservation?.settle(),
      });
    } catch (err) {
      reservation?.cancel();
      await discardUnstartedSession(sessionId);
      throw err;
    }
    if (isSessionLaunchRefusal(result)) {
      reservation?.cancel();
      await discardUnstartedSession(sessionId);
      // The launch ladder's account refusal (the unnamed path: the agent's or
      // the default account may not work in this project) reads like the
      // named one above (spec `flow-multiproject` §8.4).
      return refuse(
        result.message,
        result.refused === 'ACCOUNT_NOT_ALLOWED' ? 'ACCOUNT_REFUSED' : result.refused
      );
    }
    if (!result.accepted) {
      reservation?.cancel();
      await discardUnstartedSession(sessionId);
      return refuse('The session could not be started.', 'NOT_STARTED');
    }

    const canonicalId = result.canonicalId ?? sessionId;
    if (canonicalId !== sessionId) reservation?.rekey(canonicalId);
    const accountName = account ? (account.label ?? account.id) : null;
    void deps.activityService?.emit({
      actorType: 'agent',
      actorLabel: caller.label,
      actorId: caller.agentPath,
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
 * @param resolveCaller - Who is calling. Without one, every call is refused:
 *   a session always runs as the agent that asked for it.
 */
export function getSessionTools(deps: McpToolDeps, resolveCaller?: SessionStartCallerResolver) {
  return [
    tool(
      'session_start',
      'Start a new session of your own (it runs as you) with a first message, in a folder, and ' +
        'return its id at once (the session then works on its own). Optionally on a named account (the account usage ' +
        'tool lists them), which the account policy must allow; otherwise the usual account is ' +
        'used. The session gets no permission mode it was not given here, and ' +
        '`bypassPermissions` is lowered to `acceptEdits`. At most 8 sessions started this way ' +
        'run at once.',
      SessionStartInputShape,
      createSessionStartHandler(deps, resolveCaller)
    ),
  ];
}
