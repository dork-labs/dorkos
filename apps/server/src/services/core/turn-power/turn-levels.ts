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
import type { AgentRuntime, MessageOpts, TurnPermissionLevel } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import {
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
 * The level one turn runs at, as well as this process can tell without asking
 * the runtime: the stricter of the stored mode and a per-send mode, else the
 * runtime's default, then held to the turn's ceiling. Errs strict, because what
 * it feeds is a ceiling for somebody else: a runtime that cannot describe its
 * modes records {@link READ_ONLY_LEVEL}.
 */
function levelForTurn(
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
      : resolveCeilingLevel(declared, 'runtime-default');
  return opts?.permissionCeiling !== undefined
    ? stricterLevel(base, resolveCeilingLevel(declared, opts.permissionCeiling))
    : base;
}

/** Copy only turn-level DATA at the native stream's original construction. */
export function captureTurnLevelOptions(opts: MessageOpts | undefined): Readonly<MessageOpts> {
  const bound = (value: import('@dorkos/shared/agent-runtime').TurnPermissionBound) =>
    value === 'runtime-default'
      ? value
      : Object.freeze({
          asks: value.asks,
          reach: value.reach,
          ...(value.auto === true ? { auto: true as const } : {}),
        });
  const permissionMode = opts?.permissionMode;
  const ceiling = opts?.permissionCeiling;
  return Object.freeze({
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(ceiling !== undefined
      ? {
          permissionCeiling:
            typeof ceiling === 'string'
              ? ceiling
              : 'asks' in ceiling
                ? bound(ceiling)
                : Object.freeze(ceiling.map(bound)),
        }
      : {}),
  });
}

/**
 * Record one genuine turn's permission DATA without opening another runtime stream.
 * The registry uses this for captured original native sends; ordinary sends use
 * the same calculation below. This records a downstream bound, never grants a turn.
 *
 * @param runtime - The selected original runtime whose modes describe the turn.
 * @param stored - Its current stored session mode, or none when unavailable.
 * @param sessionId - The original turn's session id.
 * @param opts - The exact options forwarded to the native entry.
 */
export function recordRuntimeTurnLevel(
  runtime: AgentRuntime,
  stored: string | null | undefined,
  sessionId: string,
  opts?: MessageOpts,
  beforeRecord?: () => void
): void {
  const level = levelForTurn(runtime, stored, opts);
  beforeRecord?.();
  remember(turnLevels, sessionId, level);
}

/**
 * Wrap a runtime so every turn sent through it records the level it runs at.
 * Applied once, at the registry's registration seam, which every turn passes
 * through (the composer, a room reply, a scheduled run, a relay delivery).
 *
 * Synchronous on purpose, like the other decorators at that seam: it records
 * at the call and hands back the runtime's own generator untouched, so it adds
 * no step between a dispatch and the turn it starts.
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
          recordRuntimeTurnLevel(target, stored, sessionId, opts);
          return target.sendMessage(sessionId, content, opts);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
