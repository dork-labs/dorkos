/**
 * What level each conversation's latest turn ran at, and what level each room
 * post was written at, so power flows downstream and never up (spec
 * `trusted-by-default-flip` §4).
 *
 * ## The gap this closes
 *
 * `chat_send` and `post_to_room` run without a card even in a prompting mode,
 * so a turn a Telegram stranger started can post into a room. Before this, the
 * turn that post started on another agent ran at THAT agent's own level, and
 * nothing tied it to the poster's. Under a Full autonomy default that is a path
 * from a stranger to a shell. The rule that closes it is the one `session_start`
 * already keeps: a turn somebody else's message starts runs no looser than that
 * somebody.
 *
 * ## Why it is recorded rather than asked for later
 *
 * A post triggers its turns after the poster's own turn may have moved on, and
 * the poster's NEXT turn can run at a different level (a person talking to it
 * at Full autonomy after a stranger's turn ran at Default). So the level is
 * read at the moment the post is written, from what the poster's current turn
 * ran at, and kept with the post.
 *
 * ## Fails closed
 *
 * Both maps live in memory. After a restart, or for a session this process
 * never ran a turn on, the reader gets nothing and the caller bounds the turn
 * at the receiving runtime's default: a prompt, never a widening. Both maps are
 * bounded, oldest first.
 *
 * @module services/core/turn-power/turn-levels
 */
import type {
  AgentRuntime,
  MessageOpts,
  TurnPermissionBound,
  TurnPermissionLevel,
} from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { turnAgentOf } from '../agent-identity/agent-home.js';
import { agentIsReadingOutsider, countWhileRunning } from './live-outsider-turns.js';
import { primaryOf } from '../../session/resolution/session-key-registry.js';
import {
  ceilingCarriesOutsider,
  levelOfMode,
  READ_ONLY_LEVEL,
  resolveCeilingLevel,
  stricterLevel,
  type DeclaredModes,
} from '@dorkos/shared/permission-semantics';

/** How many conversations and posts each map remembers. */
export const TURN_LEVEL_MEMORY = 10_000;

/** Claude Code's Auto id, read as Default unless a launch confirmed it. */
const AUTO_MODE_ID = 'auto';
const AUTO_FALLBACK_MODE_ID = 'default';

const turnLevels = new Map<string, TurnPermissionLevel>();
const entryLevels = new Map<string, TurnPermissionLevel>();
/** Where each marked turn stood, so a turn its agent starts later is counted against the same agent. */
const outsiderPlaces = new Map<string, { cwd?: string; forAgent?: string }>();
/** How many turns this process has sent on each conversation, so a per-turn count knows when a turn is new. */
const turnSerials = new Map<string, number>();
let nextTurnSerial = 0;

/** Set a key as the newest, dropping the oldest past the bound. */
function remember(map: Map<string, TurnPermissionLevel>, key: string, level: TurnPermissionLevel) {
  map.delete(key);
  map.set(key, level);
  if (map.size > TURN_LEVEL_MEMORY) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/**
 * The level the latest turn on a conversation ran at, or `undefined` when this
 * process ran none.
 *
 * @param sessionId - The id the turn was sent under.
 */
export function lastTurnLevelOf(sessionId: string): TurnPermissionLevel | undefined {
  return turnLevels.get(sessionId);
}

/**
 * Which turn a conversation is on: a number that changes each time a turn is
 * sent on it, or `undefined` when this process sent none. Lets a count kept per
 * turn tell one turn from the next without a hook of its own.
 *
 * @param sessionId - The id the turn was sent under.
 */
export function turnSerialOf(sessionId: string): number | undefined {
  return turnSerials.get(sessionId);
}

/**
 * The level a post written from these sessions is kept with: the stricter of
 * every session's latest turn, or `undefined` when any of them is unknown or
 * none is named. Unknown is not a level: a post that cannot be vouched for
 * keeps nothing, and the turn it starts is held to the runtime's default.
 *
 * Callers name the session that MADE the call (the in-session tool's own
 * session) and the author's turn in the room it posts into. They can differ:
 * an agent with turns in several rooms posts from one into another, and the
 * post must not borrow a looser turn's level. Never a session id a request
 * body supplied; that would let anybody name a Full autonomy conversation.
 *
 * @param sessionIds - The sessions that vouch for the post.
 */
export function postLevelFor(
  sessionIds: readonly (string | null | undefined)[]
): TurnPermissionLevel | undefined {
  const named = sessionIds.filter((id): id is string => typeof id === 'string' && id !== '');
  if (named.length === 0) return undefined;
  const levels = named.map((id) => turnLevels.get(id));
  if (levels.some((level) => level === undefined)) return undefined;
  return (levels as TurnPermissionLevel[]).reduce(stricterLevel);
}

/**
 * The bound work a caller starts must carry because the caller's turn read an
 * outsider's words, or `undefined` when it did not (spec
 * `trusted-by-default-flip` §4.7). Read by `memory_write`, which stamps the
 * note, and `session_start`, which sends it as the new session's ceiling.
 *
 * The caller's session answers when this process recorded a turn on it: its
 * own level, which bounds no tighter than the turn already ran. A caller with
 * no session, or one with no record, is read through its agent: while any of
 * that agent's turns that read an outsider's words is running, the runtime
 * default, the bound a stranger's own message carries.
 *
 * @param sessionId - The calling session, when the surface verified one.
 * @param agentPath - The calling agent's home, from its verified identity.
 */
export function outsiderBoundOf(
  sessionId: string | null | undefined,
  agentPath: string | undefined
): TurnPermissionBound | undefined {
  const level = sessionId ? turnLevels.get(sessionId) : undefined;
  if (level !== undefined) return level.outsider ? level : undefined;
  return agentPath !== undefined && agentIsReadingOutsider(agentPath)
    ? 'runtime-default'
    : undefined;
}

/**
 * Keep a level with a room post. Called as the post is written, before
 * anything it triggers is dispatched, so a later turn of the same author
 * cannot change it.
 *
 * @param entryId - The post's id.
 * @param level - The level from {@link postLevelFor}; `undefined` keeps nothing.
 */
export function noteEntryLevel(entryId: string, level: TurnPermissionLevel | undefined): void {
  if (level !== undefined) remember(entryLevels, entryId, level);
}

/**
 * Carry a conversation's level to the id a runtime renamed it to mid-turn, so
 * a post made under the new id finds the turn it belongs to.
 *
 * @param from - The id the turn was sent under.
 * @param to - The id the runtime renamed the session to.
 */
export function aliasTurnLevel(from: string, to: string): void {
  const level = turnLevels.get(from);
  if (level !== undefined && from !== to) remember(turnLevels, to, level);
  const serial = turnSerials.get(from);
  if (serial !== undefined && from !== to) turnSerials.set(to, serial);
}

/**
 * The level a room post was written at, or `undefined` when nothing was kept.
 *
 * @param entryId - The post's id.
 */
export function entryLevelOf(entryId: string): TurnPermissionLevel | undefined {
  return entryLevels.get(entryId);
}

/**
 * The level one turn runs at, marked when the turn reads an outsider's words
 * (spec `trusted-by-default-flip` §4.7): its ceiling carries them (a
 * stranger's message, a sender DorkOS cannot vouch for, another turn that read
 * them), or a room shows it a stranger's message it does not answer. The mark
 * changes no power; it travels with the level to every turn this one's
 * messages start, and onto every note it saves to memory.
 */
function levelForTurn(
  runtime: AgentRuntime,
  stored: string | null | undefined,
  opts: MessageOpts | undefined
): TurnPermissionLevel {
  const level = powerForTurn(runtime, stored, opts);
  const outsider =
    opts?.roomTurn?.outsiderInView === true ||
    (opts?.permissionCeiling !== undefined && ceilingCarriesOutsider(opts.permissionCeiling));
  return outsider && !level.outsider ? { ...level, outsider: true } : level;
}

/**
 * The power one turn runs at, as well as this process can tell without asking
 * the runtime: the stricter of the stored mode and a per-send mode, else the
 * runtime's default, then held to the turn's ceiling. Errs strict, because what
 * it feeds is a ceiling for somebody else: a runtime that cannot describe its
 * modes records {@link READ_ONLY_LEVEL}.
 */
function powerForTurn(
  runtime: AgentRuntime,
  stored: string | null | undefined,
  opts: MessageOpts | undefined
): TurnPermissionLevel {
  let declared: DeclaredModes;
  try {
    declared = runtime.getCapabilities().permissionModes;
  } catch {
    return READ_ONLY_LEVEL;
  }
  const read = (id: string | null | undefined) =>
    levelOfMode(declared, id === AUTO_MODE_ID ? AUTO_FALLBACK_MODE_ID : id);
  const known = [read(stored), read(opts?.permissionMode)].filter(
    (level): level is TurnPermissionLevel => level !== undefined
  );
  const base =
    known.length > 0
      ? known.reduce(stricterLevel)
      : (levelOfMode(declared, declared.default) ?? READ_ONLY_LEVEL);
  return opts?.permissionCeiling !== undefined
    ? stricterLevel(base, resolveCeilingLevel(declared, opts.permissionCeiling))
    : base;
}

/** Where a turn stands and whom it is for, for {@link countWhileRunning}. */
function placeOf(runtime: AgentRuntime, sessionId: string, opts: MessageOpts | undefined) {
  let cwd = opts?.cwd ?? opts?.roomTurn?.cwd;
  try {
    cwd ??= runtime.getSessionCwd?.(sessionId);
  } catch {
    // An unknown folder is counted under no agent, which marks more, not less.
  }
  return { cwd, forAgent: turnAgentOf(opts) };
}

/**
 * Wrap a runtime so every turn sent through it records the level it runs at.
 * Applied once, at the registry's registration seam, which every turn passes
 * through (the composer, a room reply, a scheduled run, a relay delivery).
 *
 * Synchronous on purpose, like the other decorators at that seam: it records
 * at the call and hands back the runtime's own generator untouched, so it adds
 * no step between a dispatch and the turn it starts. The one exception is a
 * turn that read an outsider's words, whose stream is counted against its
 * agent while it runs ({@link countWhileRunning}); that adds no step either.
 *
 * @param runtime - The runtime to wrap.
 * @param storedModeOf - Reads a session's stored permission mode; a failure
 *   reads as none.
 */
export function recordTurnLevels(
  runtime: AgentRuntime,
  storedModeOf: (sessionId: string) => string | null | undefined
): AgentRuntime {
  return new Proxy(runtime, {
    get(target, prop) {
      if (prop === 'sendMessage') {
        return (
          sessionId: string,
          content: string,
          opts?: MessageOpts
        ): AsyncGenerator<StreamEvent> => {
          let stored: string | null | undefined;
          try {
            stored = storedModeOf(sessionId);
          } catch {
            stored = undefined;
          }
          const level = levelForTurn(target, stored, opts);
          remember(turnLevels, sessionId, level);
          // Under the id the turn was sent with AND the conversation's first
          // id, so a turn sent under a renamed id is the newest by either.
          const serial = ++nextTurnSerial;
          for (const id of new Set([sessionId, primaryOf(sessionId)])) {
            turnSerials.delete(id);
            turnSerials.set(id, serial);
          }
          while (turnSerials.size > TURN_LEVEL_MEMORY) {
            turnSerials.delete(turnSerials.keys().next().value!);
          }
          const events = target.sendMessage(sessionId, content, opts);
          if (!level.outsider) return events;
          // A caller that cannot name this session can still name its agent.
          const place = placeOf(target, sessionId, opts);
          outsiderPlaces.delete(sessionId);
          outsiderPlaces.set(sessionId, place);
          if (outsiderPlaces.size > TURN_LEVEL_MEMORY) {
            outsiderPlaces.delete(outsiderPlaces.keys().next().value!);
          }
          return countWhileRunning(place, events);
        };
      }
      if (prop === 'onRuntimeTurn' && typeof target.onRuntimeTurn === 'function') {
        // A turn the agent starts on its own (a Codex wake after background
        // work) runs under the session's latest dispatched turn, so it is
        // counted while it runs when that turn read an outsider's words: a
        // caller with no session (Codex over the external server) is read
        // through it.
        const subscribe = target.onRuntimeTurn.bind(target);
        return (listener: (sessionId: string, events: AsyncIterable<StreamEvent>) => void) =>
          subscribe((sessionId, events) =>
            listener(
              sessionId,
              turnLevels.get(sessionId)?.outsider
                ? countWhileRunning(
                    outsiderPlaces.get(sessionId) ?? placeOf(target, sessionId, undefined),
                    events
                  )
                : events
            )
          );
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
