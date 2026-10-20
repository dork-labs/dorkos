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
 * ## Lowering: every turn
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
 * ## Raising: only a chat that follows its agent
 *
 * The one place the stored mode stops being a ceiling. A turn starts from its
 * agent's level instead (`MessageOpts.levelPermissionMode`, never stored) only
 * when all of these hold, and keeps its stored mode otherwise:
 *
 * - the send names no mode of its own (a schedule's, a new chat's seed) and is
 *   not unattended: schedules are never raised (DOR-3153);
 * - the turn carries no outsider or teammate mark and is not held to the
 *   runtime's default; a plain level ceiling (another of the owner's agents)
 *   still holds the raised turn down;
 * - the chat follows its agent (`chat-rise-facts.ts`): a person never set its
 *   mode, nothing outside launched or marked it, and no stranger reached it;
 * - its stored mode is not one a person picks on purpose (Plan, Never ask), it
 *   is not on another computer, and its agent is not one kept as it is;
 * - the turn's agent was found by identity, not only by an enclosing folder;
 * - the level is looser than the stored mode.
 *
 * Only a person moves the level a chat rises to: it is read through the
 * permission gate, which never lets an agent's own file rise past what a
 * person set (`person-set-permissions.ts`).
 *
 * ## Fails closed
 *
 * When the turn's agent is known but its level cannot be read, or the chat has a
 * recorded agent that no folder can be matched to (`resolveLevelAgent`), the
 * turn is held to the runtime's own default mode. A turn with no agent at all
 * (a plain chat in a folder that belongs to nobody, with no recorded agent)
 * has no agent level, and runs as before. A `levelPermissionMode` a caller sent
 * is always dropped: only this seam sets it.
 *
 * Out of scope: a turn already running when the level changes (DOR-3177).
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
  ceilingCarriesOutsider,
  clampModeToCeiling,
  levelOfMode,
  type DeclaredModes,
} from '@dorkos/shared/permission-semantics';
import type { StreamEvent } from '@dorkos/shared/types';
import path from 'node:path';
import { homeOf, resolveAgentHome, turnAgentOf } from '../agent-identity/agent-home.js';
import {
  resolveAgentLaunchLevel,
  type AgentLaunchLevel,
} from '../../session/resolution/agent-launch-level.js';
import { isChosenMode, isKept } from '../permissions/existing-chats-raise.js';
import { chatRiseFacts } from './chat-rise-facts.js';
import { hasMarks, marksForTurn } from './turn-marks.js';
import { logger } from '../../../lib/logger.js';

/** Chats on another computer, which this one cannot vouch for. */
const COMPUTER_LOCAL_RUNTIME = 'computer-local';

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
 * seed), or the agent's level a raised turn starts from in place of both. Each is read after the turn's own ceiling, so the bound is added only
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
  const named = (
    opts?.levelPermissionMode !== undefined
      ? [opts.levelPermissionMode]
      : [stored, opts?.permissionMode]
  ).filter((mode): mode is string => typeof mode === 'string' && mode !== '');
  const candidates = named.length > 0 ? named : declared.values.map((mode) => mode.id);
  return candidates.some((mode) => {
    const ceiling = opts?.permissionCeiling;
    const now = ceiling === undefined ? mode : clampModeToCeiling(declared, mode, ceiling);
    return clampModeToCeiling(declared, now, level) !== now;
  });
}

/**
 * Whose level holds a turn: an agent found by identity (`exact`, which alone
 * may rise), an agent found only by an enclosing folder (it may only lower),
 * `'unmatched'` when the chat has a recorded agent that no folder can be
 * matched to (the turn is held to the runtime's default), or `undefined` for a
 * chat that belongs to no agent at all.
 */
export type LevelAgent = { agentPath: string; exact: boolean } | 'unmatched' | undefined;

/** The nearest folder at or above `dir` that resolves to an agent's home, by identity. */
function enclosingAgentHome(dir: string): string | undefined {
  let current = path.resolve(dir);
  for (;;) {
    const home = homeOf(resolveAgentHome(current));
    if (home) return home;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Find whose level holds a chat's turn (DOR-3175). The turn's own identity
 * first (its home, a linked worktree of it, or the agent it names). Then the
 * nearest enclosing agent folder, so a chat working in a subfolder of its
 * agent's folder is held too. Then the agent recorded for the chat at launch,
 * so a chat in a sibling worktree is held too. A recorded agent nothing can be
 * matched to is `'unmatched'`, never "no agent": a folder outside every agent's
 * is not a way around the cap. One answer for the turn's check and the history
 * count, so the two agree.
 *
 * @param cwd - Where the turn stands.
 * @param opts - The turn's options, for the agent it names.
 * @param recorded - The agent recorded for the chat at launch, when there is one.
 */
export function resolveLevelAgent(
  cwd: string | undefined,
  opts: Pick<MessageOpts, 'forAgent' | 'roomTurn'> | undefined,
  recorded: string | null | undefined
): LevelAgent {
  const identity = resolveAgentHome(cwd, turnAgentOf(opts));
  const home = homeOf(identity);
  if (home) return { agentPath: home, exact: true };
  const recordedHome = recorded ? enclosingAgentHome(recorded) : undefined;
  const enclosing = cwd ? enclosingAgentHome(cwd) : undefined;
  if (enclosing) return { agentPath: enclosing, exact: false };
  if (identity.kind === 'refused') return 'unmatched';
  if (recordedHome) return { agentPath: recordedHome, exact: recordedHome === recorded };
  return recorded ? 'unmatched' : undefined;
}

/** The agent a turn belongs to, by {@link resolveLevelAgent}. */
async function agentOfTurn(
  runtime: AgentRuntime,
  sessionId: string,
  opts: MessageOpts | undefined,
  recordedAgentOf: AgentLevelBoundDeps['recordedAgentOf']
): Promise<LevelAgent> {
  let cwd = opts?.cwd;
  if (cwd === undefined) {
    try {
      cwd = runtime.getSessionCwd?.(sessionId) ?? undefined;
    } catch {
      cwd = undefined;
    }
  }
  const recorded = recordedAgentOf ? await recordedAgentOf(sessionId) : undefined;
  return resolveLevelAgent(cwd, opts, recorded);
}

/** Whether the turn carries a mark or is held: an outsider's, a teammate's, or the runtime's default. */
function turnIsMarked(opts: MessageOpts | undefined): boolean {
  const ceiling = opts?.permissionCeiling;
  if (ceiling !== undefined && ceilingCarriesOutsider(ceiling)) return true;
  if (opts?.teammate === true || opts?.roomTurn?.teammate === true) return true;
  return hasMarks(marksForTurn(opts));
}

/**
 * Whether this turn starts from its agent's level rather than its stored mode;
 * every condition is in the module doc.
 *
 * @param runtime - The runtime the turn runs on.
 * @param sessionId - The session.
 * @param agentPath - The turn's agent.
 * @param stored - The session's stored mode.
 * @param levelMode - The agent's level as this runtime's mode.
 * @param opts - The send's options.
 */
function rises(
  runtime: AgentRuntime,
  sessionId: string,
  agentPath: string,
  stored: string | null | undefined,
  levelMode: string,
  opts: MessageOpts | undefined
): boolean {
  if (opts?.permissionMode !== undefined || opts?.unattended === true) return false;
  if (turnIsMarked(opts)) return false;
  if (runtime.type === COMPUTER_LOCAL_RUNTIME) return false;
  if (isKept({ projectPath: agentPath, name: '', displayName: '' })) return false;
  const declared = runtime.getCapabilities().permissionModes;
  const current = stored ?? declared.default;
  if (!current || isChosenMode(declared, current)) return false;
  const currentLevel = levelOfMode(declared, current);
  // Only up: a level the stored mode would not hold down is no looser than it.
  if (!currentLevel || clampModeToCeiling(declared, levelMode, currentLevel) === levelMode) {
    return false;
  }
  return chatRiseFacts()?.mayRise(sessionId) === true;
}

/**
 * The send's options with the agent's level added to its ceiling when that
 * level holds the turn down, and the level as the mode it starts from when the
 * chat follows its agent up; the options unchanged otherwise.
 *
 * @param runtime - The runtime the turn runs on.
 * @param sessionId - The session.
 * @param opts - The send's options.
 * @param deps - Where the stored mode, the recorded agent and the level come from.
 */
export async function boundTurnOpts(
  runtime: AgentRuntime,
  sessionId: string,
  incoming: MessageOpts | undefined,
  deps: AgentLevelBoundDeps
): Promise<MessageOpts | undefined> {
  // Only this seam may say a turn starts from its agent's level: one a caller
  // sent is dropped, whatever happens below, so nothing upstream can skip the
  // stored mode, a person's cap, the schedule rule or the marks.
  const opts = withoutLevelMode(incoming);
  let capabilities: RuntimeCapabilities;
  try {
    capabilities = runtime.getCapabilities();
  } catch {
    return opts;
  }
  const declared = capabilities.permissionModes;
  let agent: LevelAgent;
  try {
    agent = await agentOfTurn(runtime, sessionId, opts, deps.recordedAgentOf);
  } catch {
    // A recorded agent could not be read: held to the default, not let through.
    agent = 'unmatched';
  }
  if (agent === undefined) return opts;
  if (agent === 'unmatched') {
    const held = levelOfMode(declared, declared.default);
    return held ? boundBy(declared, held, storedOf(deps, sessionId), opts) : opts;
  }
  const { agentPath } = agent;

  let level: TurnPermissionLevel | undefined;
  let levelMode: string | undefined;
  try {
    const read = deps.levelOf ?? resolveAgentLaunchLevel;
    const { mode } = await read({ agentPath, capabilities });
    // Nothing configured anywhere: the runtime's own default decides, as for a new chat.
    if (mode === undefined) return opts;
    levelMode = mode;
    level = levelOfMode(declared, mode);
  } catch (err) {
    logger.warn('[agent-level] could not read the agent’s level; holding the turn to the default', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    level = levelOfMode(declared, declared.default);
  }
  if (level === undefined) return opts;

  const stored = storedOf(deps, sessionId);
  const sent: MessageOpts | undefined =
    agent.exact &&
    levelMode !== undefined &&
    rises(runtime, sessionId, agentPath, stored, levelMode, opts)
      ? { ...(opts ?? {}), levelPermissionMode: levelMode }
      : opts;
  return boundBy(declared, level, stored, sent);
}

/** The options without a `levelPermissionMode` a caller sent. */
function withoutLevelMode(opts: MessageOpts | undefined): MessageOpts | undefined {
  if (opts?.levelPermissionMode === undefined) return opts;
  const { levelPermissionMode: _dropped, ...rest } = opts;
  return rest;
}

/** The session's stored mode; a failure reads as none, which binds. */
function storedOf(deps: AgentLevelBoundDeps, sessionId: string): string | null | undefined {
  try {
    return deps.storedModeOf(sessionId);
  } catch {
    return undefined;
  }
}

/** The options with `level` added to their ceiling when it holds the turn down. */
function boundBy(
  declared: DeclaredModes,
  level: TurnPermissionLevel,
  stored: string | null | undefined,
  opts: MessageOpts | undefined
): MessageOpts | undefined {
  if (!levelBinds(declared, level, stored, opts)) return opts;
  return { ...(opts ?? {}), permissionCeiling: withBound(opts?.permissionCeiling, level) };
}

/**
 * Wrap a runtime so every turn, and every command intent (a summary is a turn
 * too), starts no looser than its agent's current level, and a chat that
 * follows its agent starts at it.
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
