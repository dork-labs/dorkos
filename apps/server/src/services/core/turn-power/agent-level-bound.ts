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
  ceilingHoldsForOutsider,
  clampModeToCeiling,
  levelOfMode,
  stricterLevel,
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
import { marksForTurn } from './turn-marks.js';
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
 * seed), or the agent's level a raised turn starts from in place of both. Each is read before and
 * after the turn's own ceiling, so the bound is added only where it changes either answer. Before
 * matters (DOR-3416): what reads the level a chat is SET to (`ownLevelBounds`, DOR-3394) sets a
 * stranger's hold and the marks aside, so a hold stricter than the agent's level must not leave the
 * level out, or a chat stored at Full whose agent a person lowered reads as Full again. With
 * neither known, the runtime may hold a mode in memory this seam cannot see, so every mode it
 * declares is a candidate: unknown binds, never the other way round.
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
    if (clampModeToCeiling(declared, mode, level) !== mode) return true;
    const ceiling = opts?.permissionCeiling;
    const now = ceiling === undefined ? mode : clampModeToCeiling(declared, mode, ceiling);
    return clampModeToCeiling(declared, now, level) !== now;
  });
}

/**
 * Whose level holds a turn: an agent found by identity (`exact`, which alone
 * may rise), an agent found only by a folder (it may only lower), with a
 * second agent whose level also holds the turn when the chat's own agent and
 * the folder's agent differ (`alsoBoundBy`), `'unmatched'` when the chat has a
 * recorded agent that no folder can be matched to (the turn is held to the
 * runtime's default), or `undefined` for a chat that belongs to no agent.
 */
export type LevelAgent =
  { agentPath: string; exact: boolean; alsoBoundBy?: string } | 'unmatched' | undefined;

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
 * so a chat in a sibling worktree is held too. A chat whose own agent (named
 * or recorded) differs from the agent whose folder it stands in is held by
 * both levels, never by the folder's agent alone. A recorded agent nothing can be
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
  const named = turnAgentOf(opts);
  const identity = resolveAgentHome(cwd, named);
  const home = homeOf(identity);
  if (home) return { agentPath: home, exact: true };
  if (identity.kind === 'refused') return 'unmatched';
  const ownPath = named ?? recorded ?? undefined;
  const own = ownPath ? enclosingAgentHome(ownPath) : undefined;
  const enclosing = cwd ? enclosingAgentHome(cwd) : undefined;
  // A chat of one agent standing in ANOTHER agent's folder answers to both:
  // never the folder's agent alone, or its looser level would lift the chat's
  // own agent's cap (Security, #3142).
  if (own && enclosing && own !== enclosing) {
    return { agentPath: own, exact: false, alsoBoundBy: enclosing };
  }
  if (enclosing) return { agentPath: enclosing, exact: false };
  if (own) return { agentPath: own, exact: own === ownPath };
  return ownPath ? 'unmatched' : undefined;
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

/**
 * Whether the turn is held or reads outside words in a room: a stranger's (the runtime's
 * default), a teammate's chain, or a room line in view. A turn our own agent's marked post or
 * message started still rises (DOR-3390): its mark gates the risky actions, not its level.
 */
function turnIsMarked(opts: MessageOpts | undefined): boolean {
  const ceiling = opts?.permissionCeiling;
  if (ceiling !== undefined && ceilingHoldsForOutsider(ceiling)) return true;
  if (opts?.teammate === true || opts?.roomTurn?.teammate === true) return true;
  // A stranger's line in view keeps the chat where it is, as before: it is read first-hand.
  if (opts?.roomTurn?.outsiderInView === true) return true;
  return marksForTurn(opts).teammate !== undefined;
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

  const read = deps.levelOf ?? resolveAgentLaunchLevel;
  /** One agent's level as this runtime's mode; `null` when nothing is set, `'unreadable'` on a failure. */
  const modeOf = async (path: string): Promise<string | null | 'unreadable'> => {
    try {
      return (await read({ agentPath: path, capabilities })).mode ?? null;
    } catch (err) {
      logger.warn(
        '[agent-level] could not read the agent’s level; holding the turn to the default',
        {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        }
      );
      return 'unreadable';
    }
  };
  const modes = [await modeOf(agentPath)];
  if (agent.alsoBoundBy) modes.push(await modeOf(agent.alsoBoundBy));
  // Nothing configured anywhere: the runtime's own default decides, as for a new chat.
  if (modes.every((m) => m === null)) return opts;
  const levels = modes.map((m) =>
    m === 'unreadable'
      ? levelOfMode(declared, declared.default)
      : m === null
        ? undefined
        : levelOfMode(declared, m)
  );
  const known = levels.filter((l): l is TurnPermissionLevel => l !== undefined);
  if (known.length === 0) return opts;
  const level = known.reduce(stricterLevel);
  // The level a chat rises to is its own agent's, read cleanly, with no second agent.
  const levelMode =
    !agent.alsoBoundBy && typeof modes[0] === 'string' && modes[0] !== 'unreadable'
      ? modes[0]
      : undefined;

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
