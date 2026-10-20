/**
 * Every turn runs no looser than its agent's current level (DOR-3175).
 *
 * A chat's mode is stored on its row when the chat is born, from the agent's
 * level at that moment. Until now nothing read the agent's level again, so a
 * person who capped an agent at Ask left every chat and room seat it already
 * had at the mode it was born with: a seat stored at Full kept writing with no
 * card. This bound is read at the start of EVERY turn, on every runtime, so a
 * cap reaches every existing chat on its next turn without rewriting a stored
 * mode: the stored mode stays what it is, and the turn runs at the stricter of
 * the two.
 *
 * ## One seam
 *
 * Applied at the registry's registration seam (`decorateRuntime`), which every
 * turn passes through: a person's message, a resumed chat after a restart, a
 * room seat (and its re-seat on another account, any runtime), a scheduled run
 * and a mini app's work. The agent's level comes from
 * {@link resolveAgentLaunchLevel}, the same function a new chat launches at and
 * the profile's Level row reports, so the three cannot drift.
 *
 * ## Only ever lowers
 *
 * The bound is the agent's level as a turn ceiling, added beside whatever
 * ceiling the turn already carries, and a ceiling can only hold a turn down
 * (`clampModeToCeiling`). It is added only when it binds: a turn its agent's
 * level already admits is sent exactly as before, so nothing else that reads a
 * ceiling (the tool gate's `ceilingOn`, a warm process's fingerprint) sees a
 * change. The level carries no marks, so it never makes a post read as a
 * stranger's or a teammate's; it does lower the level the turn hands on, which
 * is the point.
 *
 * ## Fails closed
 *
 * When the turn's agent is known but its level cannot be read, the turn is held
 * to the runtime's own default mode. A turn with no agent (a plain chat in a
 * folder that belongs to nobody) has no agent level, and runs as before.
 *
 * Out of scope: a turn already running when the level changes (DOR-3177), and
 * raising a stored mode to a looser level (the raise is its own change).
 *
 * @module services/core/turn-power/agent-level-bound
 */
import type {
  AgentRuntime,
  MessageOpts,
  RuntimeCapabilities,
  TurnPermissionBound,
  TurnPermissionCeiling,
  TurnPermissionLevel,
} from '@dorkos/shared/agent-runtime';
import {
  clampModeToCeiling,
  levelOfMode,
  type DeclaredModes,
} from '@dorkos/shared/permission-semantics';
import type { StreamEvent } from '@dorkos/shared/types';
import {
  chatAgentOf,
  homeOf,
  resolveAgentHome,
  turnAgentOf,
} from '../agent-identity/agent-home.js';
import {
  resolveAgentLaunchLevel,
  type AgentLaunchLevel,
} from '../../session/resolution/agent-launch-level.js';
import { logger } from '../../../lib/logger.js';

/** What the bound reads about a session, beside the turn's own options. */
export interface AgentLevelBoundDeps {
  /** The session's stored permission mode, synchronously; a failure reads as none. */
  storedModeOf: (sessionId: string) => string | null | undefined;
  /** The agent recorded for the session at launch, when there is one. */
  recordedAgentOf?: (sessionId: string) => Promise<string | null | undefined>;
  /** Reads an agent's current level on one runtime (tests pass their own). */
  levelOf?: (opts: {
    agentPath: string;
    capabilities: RuntimeCapabilities | undefined;
  }) => Promise<AgentLaunchLevel>;
}

/** The ceiling a turn is sent with, plus one more bound that also holds. */
function withBound(
  ceiling: TurnPermissionCeiling | undefined,
  bound: TurnPermissionBound
): TurnPermissionCeiling {
  if (ceiling === undefined) return bound;
  const existing: readonly TurnPermissionBound[] = Array.isArray(ceiling)
    ? (ceiling as readonly TurnPermissionBound[])
    : [ceiling as TurnPermissionBound];
  return [...existing, bound];
}

/**
 * Whether a level holds down any mode this turn could launch at: the stored
 * mode and a mode the send names (a schedule's mode, or a new chat's first-turn
 * seed). Each is read after the turn's own ceiling, so the bound is added only
 * where it changes the answer. With neither known, the runtime may hold a mode
 * in memory this seam cannot see, so every mode it declares is a candidate:
 * unknown binds, never the other way round.
 *
 * @param declared - The runtime's declared modes.
 * @param level - The agent's level.
 * @param stored - The session's stored mode.
 * @param opts - The send's options.
 */
export function levelBinds(
  declared: DeclaredModes,
  level: TurnPermissionLevel,
  stored: string | null | undefined,
  opts: MessageOpts | undefined
): boolean {
  const named = [stored, opts?.permissionMode].filter(
    (mode): mode is string => typeof mode === 'string' && mode !== ''
  );
  const candidates = named.length > 0 ? named : declared.values.map((mode) => mode.id);
  return candidates.some((mode) => {
    const ceiling = opts?.permissionCeiling;
    const now = ceiling === undefined ? mode : clampModeToCeiling(declared, mode, ceiling);
    return clampModeToCeiling(declared, now, level) !== now;
  });
}

/** The agent a turn belongs to: the one it names, its folder's, else the one recorded for its chat. */
async function agentOfTurn(
  runtime: AgentRuntime,
  sessionId: string,
  opts: MessageOpts | undefined,
  recordedAgentOf: AgentLevelBoundDeps['recordedAgentOf']
): Promise<string | undefined> {
  let cwd = opts?.cwd;
  if (cwd === undefined) {
    try {
      cwd = runtime.getSessionCwd?.(sessionId) ?? undefined;
    } catch {
      cwd = undefined;
    }
  }
  const home = homeOf(resolveAgentHome(cwd, turnAgentOf(opts)));
  if (home) return home;
  if (!cwd || !recordedAgentOf) return undefined;
  return chatAgentOf(await recordedAgentOf(sessionId), cwd);
}

/**
 * The send's options with the agent's level added to its ceiling when that
 * level holds the turn down; the options unchanged otherwise.
 *
 * @param runtime - The runtime the turn runs on.
 * @param sessionId - The session.
 * @param opts - The send's options.
 * @param deps - Where the stored mode, the recorded agent and the level come from.
 */
export async function boundTurnOpts<O extends MessageOpts | undefined>(
  runtime: AgentRuntime,
  sessionId: string,
  opts: O,
  deps: AgentLevelBoundDeps
): Promise<O | MessageOpts> {
  let capabilities: RuntimeCapabilities;
  try {
    capabilities = runtime.getCapabilities();
  } catch {
    return opts;
  }
  const declared = capabilities.permissionModes;
  let agentPath: string | undefined;
  try {
    agentPath = await agentOfTurn(runtime, sessionId, opts, deps.recordedAgentOf);
  } catch {
    agentPath = undefined;
  }
  if (!agentPath) return opts;

  let level: TurnPermissionLevel | undefined;
  try {
    const read = deps.levelOf ?? resolveAgentLaunchLevel;
    const { mode } = await read({ agentPath, capabilities });
    // Nothing configured anywhere: the runtime's own default decides, as for a new chat.
    if (mode === undefined) return opts;
    level = levelOfMode(declared, mode);
  } catch (err) {
    logger.warn('[agent-level] could not read the agent’s level; holding the turn to the default', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    level = levelOfMode(declared, declared.default);
  }
  if (level === undefined) return opts;

  let stored: string | null | undefined;
  try {
    stored = deps.storedModeOf(sessionId);
  } catch {
    stored = undefined;
  }
  if (!levelBinds(declared, level, stored, opts)) return opts;
  return { ...(opts ?? {}), permissionCeiling: withBound(opts?.permissionCeiling, level) };
}

/**
 * Wrap a runtime so every turn, and every command intent (a summary is a turn
 * too), starts no looser than its agent's current level.
 *
 * The level is read before the turn starts, so the wrapped generator starts the
 * runtime's own on its first `next()`. Sits outside the turn-level record
 * (`recordTurnLevels`) so the level a turn hands on is the bounded one.
 *
 * @param runtime - The runtime to wrap.
 * @param deps - Where the stored mode, the recorded agent and the level come from.
 * @returns A proxy over the runtime.
 */
export function boundToAgentLevel(runtime: AgentRuntime, deps: AgentLevelBoundDeps): AgentRuntime {
  return new Proxy(runtime, {
    get(target, prop) {
      if (
        (prop === 'sendMessage' || prop === 'executeCommandIntent') &&
        typeof target[prop] === 'function'
      ) {
        const start = (
          target[prop] as (
            id: string,
            input: unknown,
            opts?: MessageOpts
          ) => AsyncGenerator<StreamEvent>
        ).bind(target);
        return (sessionId: string, input: unknown, opts?: MessageOpts) =>
          (async function* bounded(): AsyncGenerator<StreamEvent> {
            const sent = await boundTurnOpts(target, sessionId, opts, deps);
            yield* start(sessionId, input, sent);
          })();
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
