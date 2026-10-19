/**
 * The permission level a `session_start` launch runs at (spec
 * `inherited-start-permission`, ADR `261004-235818`): the calling chat's own
 * live level or lower, never higher.
 *
 * The ceiling comes only from server-bound state — the calling chat's live
 * `AgentSession.permissionMode` read at call time, its stored settings row, its
 * runtime's declared default — and never from the tool's input. Levels are
 * compared by what each runtime DECLARES its modes do (`isNoLooserThan`), never
 * by id, so the rule holds when the new chat runs on another runtime.
 *
 * @module services/runtimes/claude-code/mcp-tools/session-start-permission
 */
import type {
  AgentRuntime,
  PermissionModeDescriptor,
  PermissionStop,
} from '@dorkos/shared/agent-runtime';
import {
  actsWithoutAsking,
  isNoLooserThan,
  isSilentReadOnly,
  resolveStopMode,
} from '@dorkos/shared/permission-semantics';
import { logError, logger } from '../../../../lib/logger.js';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import {
  readAgentExecutionDefaults,
  resolveUnattendedDefaultStop,
} from '../../../session/resolution/resolve-session-defaults.js';
import { NEVER_ASK_MODE_ID } from '../runtime-constants.js';
import { gatePermissionMode, isPersonOnlyMode } from '../turn-permission.js';
import type { McpToolSession } from './types.js';

/**
 * The ceiling for a caller that has no chat (the external `/mcp` server) and no
 * Files & commands stop to go by: Claude Code's `acceptEdits`. There is no chat
 * level to inherit, so it keeps the limit every caller had before chats could
 * pass on their own. A registered agent with a stop is held to that stop
 * instead (spec `trusted-by-default-flip` §5.2).
 */
const NO_CHAT_CEILING_MODE = 'acceptEdits';

/** The runtime {@link NO_CHAT_CEILING_MODE} is named on. */
export const NO_CHAT_CEILING_RUNTIME = 'claude-code';

/**
 * The level held when nothing better is known: reads only. What a ceiling falls
 * back to when neither the caller's mode nor its runtime's default can be
 * resolved, so a broken lookup can only make the answer stricter.
 */
const FLOOR: Pick<PermissionModeDescriptor, 'asks' | 'reach'> = { asks: 'always', reach: 'read' };

/** What {@link FLOOR} is called in a refusal. */
const FLOOR_LABEL = 'Read only';

/**
 * Claude Code's Auto mode. It declares the same asking and reach as Accept
 * edits, but it is not the same grant: under Auto a safety classifier approves
 * commands that Accept edits stops to ask a person about. So an Auto grant needs
 * a ceiling that is itself Auto, or one that never asks at all
 * ({@link allowsAuto}). Named by id because the difference is one the
 * declarations do not carry.
 */
const AUTO_MODE_ID = 'auto';

/** The mode a turn runs at when Auto cannot be trusted on its model. */
const AUTO_FALLBACK_MODE_ID = 'default';

/**
 * The mode a live Claude Code session's turn REALLY runs at, read at call time.
 *
 * Its stored `permissionMode` can say Auto while the turn runs at Default: the
 * launcher coerces Auto down for a model that cannot do it, per query, without
 * rewriting the session's choice (`messaging/launch-resolver.ts`). Auto counts
 * only when the launcher confirmed it for the session's current model; anything
 * else — a model it could not vouch for, a model changed since — reads as
 * Default. Fails closed.
 *
 * @param session - The live session, or undefined when there is none.
 */
export function runningPermissionMode(
  session:
    | Pick<
        McpToolSession,
        | 'permissionMode'
        | 'model'
        | 'autoModeConfirmedFor'
        | 'turnPermissionCeiling'
        | 'backgroundPermissionCeiling'
      >
    | undefined
): string | undefined {
  // The turn's ceiling first: a chat a stranger's message woke runs below its
  // own level for that turn, and must start nothing above it (spec
  // `trusted-by-default-flip` §4).
  const mode = session
    ? gatePermissionMode({
        permissionMode: session.permissionMode,
        ...(session.turnPermissionCeiling !== undefined
          ? { turnPermissionCeiling: session.turnPermissionCeiling }
          : {}),
        // And background work an earlier ceilinged turn left running, which can
        // call `session_start` too (`warm-ceiling.ts`).
        ...(session.backgroundPermissionCeiling !== undefined
          ? { backgroundPermissionCeiling: session.backgroundPermissionCeiling }
          : {}),
      })
    : undefined;
  if (mode !== AUTO_MODE_ID) return mode;
  const confirmed =
    session?.autoModeConfirmedFor !== undefined &&
    session.autoModeConfirmedFor === (session.model ?? '');
  return confirmed ? mode : AUTO_FALLBACK_MODE_ID;
}

/** The permission level a started session was granted. */
export interface SessionStartPermission {
  /** The mode id it runs at, on its own runtime. */
  mode: string;
  /** That mode's name, as its runtime declares it. */
  label: string;
  /** The calling chat's mode at the moment of the start, or `null` with no chat. */
  callerMode: string | null;
  /** Whether it runs at the calling chat's level exactly (false with no chat). */
  sameAsCaller: boolean;
}

/** The chat a call is made from, as the server knows it. */
export interface CallingChat {
  /** Its id, or null when the live session has none yet. */
  sessionId: string | null;
  /** Its live permission mode, or null when the live session object has none. */
  permissionMode: string | null;
  /** The runtime it runs on. */
  runtime: string;
  /**
   * Whether the chat is SET to "Never ask", whatever its turn runs at. A
   * stricter ceiling can hold the turn to Plan, which asks; a chat set to never
   * ask still starts only chats that cannot ask.
   */
  neverAsks?: boolean;
}

/** The highest level a call may start a chat at. */
interface Ceiling {
  /** The level, as asking and reach. */
  level: Pick<PermissionModeDescriptor, 'asks' | 'reach'>;
  /** What to call it in a refusal. */
  label: string;
  /**
   * The mode id an absent `permissionMode` inherits: the caller's own, or the
   * fallback the ceiling resolved to. Null when there is none to inherit.
   */
  inheritId: string | null;
  /**
   * The calling chat's ACTUAL mode id, as recorded on the start — never a
   * fallback standing in for it. Null with no chat, or when none is known.
   */
  callerMode: string | null;
  /** Whether the level IS the caller's own declared mode, not a fallback. */
  exact: boolean;
  /** Whether the call came from a chat, which decides how a refusal reads. */
  inChat: boolean;
  /** Whether the calling chat never asks: set to, or running at, "Never ask". */
  neverAsks: boolean;
}

/** The modes a registered runtime declares, or an empty list. */
function declaredModes(runtimeType: string): {
  values: readonly PermissionModeDescriptor[];
  default?: string;
} {
  if (!runtimeRegistry.has(runtimeType)) return { values: [] };
  const modes = runtimeRegistry.get(runtimeType).getCapabilities().permissionModes;
  return modes?.supported ? modes : { values: [] };
}

/**
 * The stored mode of a chat whose live session object is gone, or null.
 *
 * A stored Auto reads as Default: with no live launch, nothing has confirmed
 * Auto for the chat's model ({@link runningPermissionMode}).
 */
async function storedModeOf(sessionId: string | null): Promise<string | null> {
  if (!sessionId) return null;
  try {
    const stored = (await runtimeRegistry.getSessionSettings(sessionId))?.permissionMode ?? null;
    return stored === AUTO_MODE_ID ? AUTO_FALLBACK_MODE_ID : stored;
  } catch (err) {
    logger.warn("[session_start] could not read the calling chat's settings", {
      sessionId,
      ...logError(err),
    });
    return null;
  }
}

/**
 * The ceiling of a call (spec `inherited-start-permission` §2), from server-bound
 * state only:
 *
 * 1. In a chat: the mode its turn runs at, read at call time.
 * 2. In a chat with no live mode: its stored settings row.
 * 3. Neither, or an id its runtime does not declare: that runtime's declared
 *    default, and {@link FLOOR} when even that cannot be found. Fails closed.
 * 4. No chat at all: the calling agent's own Files & commands stop, as the new
 *    chat's runtime declares it; {@link NO_CHAT_CEILING_MODE} when it has none
 *    or that runtime declares no mode at it.
 */
async function ceilingOf(
  chat: CallingChat | null,
  noChat: { stop: PermissionStop | null; runtimeType: string }
): Promise<Ceiling> {
  if (!chat) {
    const ownStop = resolveStopMode(noChat.stop, declaredModes(noChat.runtimeType).values);
    const found = ownStop
      ? declaredModes(noChat.runtimeType).values.find((m) => m.id === ownStop)
      : declaredModes(NO_CHAT_CEILING_RUNTIME).values.find((m) => m.id === NO_CHAT_CEILING_MODE);
    const base = { callerMode: null, exact: false, inChat: false, neverAsks: false };
    return found
      ? { ...base, level: found, label: found.label, inheritId: null }
      : { ...base, level: FLOOR, label: FLOOR_LABEL, inheritId: null };
  }
  const modes = declaredModes(chat.runtime);
  const id = chat.permissionMode ?? (await storedModeOf(chat.sessionId));
  const own = id ? modes.values.find((m) => m.id === id) : undefined;
  if (own) {
    return {
      level: own,
      label: own.label,
      inheritId: own.id,
      callerMode: own.id,
      exact: true,
      inChat: true,
      neverAsks: chat.neverAsks === true || isPersonOnlyMode(own.id),
    };
  }
  const fallback = modes.values.find((m) => m.id === modes.default);
  const base = {
    callerMode: id ?? null,
    exact: false,
    inChat: true,
    neverAsks: chat.neverAsks === true || isPersonOnlyMode(id ?? undefined),
  };
  return fallback
    ? { ...base, level: fallback, label: fallback.label, inheritId: fallback.id }
    : { ...base, level: FLOOR, label: FLOOR_LABEL, inheritId: null };
}

/**
 * Whether a ceiling admits an Auto grant: only one that is itself Auto, or one
 * that never asks (see {@link AUTO_MODE_ID} for why the declarations alone do
 * not decide it).
 */
function allowsAuto(ceiling: Ceiling): boolean {
  return (ceiling.exact && ceiling.callerMode === AUTO_MODE_ID) || ceiling.level.asks === 'never';
}

/** The level a start is granted, or why it is refused. */
type Grant =
  { ok: true; mode: PermissionModeDescriptor } | { ok: false; error: string; code: string };

/**
 * Whether a chat that never asks may start one at this mode: only one that
 * cannot ask either. "Never ask" refuses what Default would put to a person, so
 * a chat it starts may not put those same calls to a person instead (DOR-2838):
 * "Never ask" itself, or a mode that only reads and has nothing to ask about
 * (`isSilentReadOnly`, Codex's read-only sandbox).
 */
function cannotAsk(mode: PermissionModeDescriptor): boolean {
  return mode.id === NEVER_ASK_MODE_ID || isSilentReadOnly(mode);
}

/** The refusal for a mode above the ceiling. */
function aboveRefusal(ceiling: Ceiling, mode: PermissionModeDescriptor): Grant {
  return {
    ok: false,
    error: ceiling.inChat
      ? `This chat runs at ${ceiling.label}, so it cannot start a chat at ${mode.label}. ` +
        `Ask for ${ceiling.label} or lower.`
      : `Without a chat of your own, you can start a chat at ${ceiling.label} or lower, ` +
        `not ${mode.label}.`,
    code: 'ABOVE_YOUR_LEVEL',
  };
}

/** The refusal for a chat that never asks naming a mode that can ask. */
function neverAsksRefusal(mode: PermissionModeDescriptor): Grant {
  return {
    ok: false,
    error:
      `This chat never asks, so it cannot start a chat at ${mode.label}, which can. ` +
      'Leave permissionMode out to start one that never asks too.',
    code: 'ABOVE_YOUR_LEVEL',
  };
}

/**
 * The mode a start runs at, against the target runtime's declared modes: the one
 * asked for when it is not above the ceiling; with none asked for, the caller's
 * own (when the target declares it and it fits), else the target's default
 * (when it fits). Compared by declared asking and reach, never by id, so it holds
 * when the new chat runs on another runtime.
 */
function grantMode(requested: string | undefined, ceiling: Ceiling, runtimeType: string): Grant {
  const target = declaredModes(runtimeType);
  const callerNeverAsks = ceiling.neverAsks;
  const fits = (mode: PermissionModeDescriptor) =>
    isNoLooserThan(ceiling.level, mode) &&
    (mode.id !== AUTO_MODE_ID || allowsAuto(ceiling)) &&
    (!callerNeverAsks || cannotAsk(mode));
  // "Never ask" is a person's choice. An agent may pass it on by starting a chat
  // from one (inheriting it, or naming it from inside one), never pick it.
  if (isPersonOnlyMode(requested) && !callerNeverAsks) {
    return {
      ok: false,
      error:
        'Only a person can set a chat to never ask. Leave permissionMode out, or name another mode.',
      code: 'PERSON_ONLY_MODE',
    };
  }
  if (requested !== undefined) {
    const mode = target.values.find((m) => m.id === requested);
    if (!mode) {
      return {
        ok: false,
        error: `The ${runtimeType} runtime has no permission mode called ${requested}.`,
        code: 'UNKNOWN_PERMISSION_MODE',
      };
    }
    if (fits(mode)) return { ok: true, mode };
    return callerNeverAsks ? neverAsksRefusal(mode) : aboveRefusal(ceiling, mode);
  }
  const own = ceiling.inheritId ? target.values.find((m) => m.id === ceiling.inheritId) : undefined;
  if (own && fits(own)) return { ok: true, mode: own };
  const fallback = target.values.find((m) => m.id === target.default);
  if (fallback && fits(fallback)) return { ok: true, mode: fallback };
  if (callerNeverAsks) {
    return {
      ok: false,
      error: `The ${runtimeType} runtime has no mode that never asks, so this chat cannot start one there.`,
      code: 'NO_MODE_FITS',
    };
  }
  return {
    ok: false,
    error:
      `No permission mode of the ${runtimeType} runtime fits under ${ceiling.label} by default. ` +
      'Name a permissionMode at your level or lower.',
    code: 'NO_MODE_FITS',
  };
}

/**
 * A ceiling held to the new chat's runtime default as well, for a start whose
 * turn is marked (DOR-3107, Dorian 2026-10-19 15:07, Security 15:10): the chat
 * it opens is born capped, as one a marked turn's chat message opens is, since
 * its first turn's ceiling alone would leave every later turn at the caller's
 * level. The stricter of the two: a caller already at or below the default
 * keeps its own level, and a caller set to never ask still starts only chats
 * that cannot ask.
 *
 * @param ceiling - The caller's own ceiling.
 * @param runtimeType - The runtime the new chat runs on.
 */
function cappedForMarkedStart(ceiling: Ceiling, runtimeType: string): Ceiling {
  const modes = declaredModes(runtimeType);
  const fallback = modes.values.find((m) => m.id === modes.default);
  const level = fallback ?? FLOOR;
  if (isNoLooserThan(level, ceiling.level)) return ceiling;
  return {
    ...ceiling,
    level,
    label: fallback?.label ?? FLOOR_LABEL,
    inheritId: fallback?.id ?? null,
    exact: false,
  };
}

/**
 * The ceiling a caller with no chat (the external `/mcp` server) is held to:
 * the agent the token names, at its own Files & commands stop (spec
 * `trusted-by-default-flip` §5.2). Only a registered agent reaches here: a plain
 * key, a per-user key or an unidentified caller is refused before it.
 *
 * @param chat - The calling chat, or null for a caller with none.
 * @param runtime - The runtime the new chat runs on, for its config section.
 * @param agentPath - The calling agent's folder.
 * @returns The agent's resolved stop, or `null` in a chat, whose own level is
 *   the ceiling.
 */
export async function chatlessCallerStop(
  chat: CallingChat | null,
  runtime: Pick<AgentRuntime, 'getCapabilities'>,
  agentPath: string | undefined
): Promise<PermissionStop | null> {
  if (chat) return null;
  return resolveUnattendedDefaultStop({
    configSection: runtime.getCapabilities().settings.configSection,
    agent: await readAgentExecutionDefaults(agentPath),
  });
}

/**
 * Everything `session_start` decides about the level, in one call: the ceiling,
 * the grant against the target runtime's declared modes, and the rule that Full
 * autonomy is only ever granted when asked for by name. Nothing is written here; a refusal
 * leaves nothing behind.
 *
 * @param requested - The mode the tool was asked for, if any.
 * @param chat - The calling chat, or null for a caller with none.
 * @param runtimeType - The runtime the new chat runs on.
 * @param callerStop - With no chat, the calling agent's own resolved Files &
 *   commands stop (its own, then the runtime's, then the global one), which
 *   is its ceiling; `null` keeps {@link NO_CHAT_CEILING_MODE}. Ignored in a
 *   chat, whose own level is the ceiling. * @param marked - Whether the starting turn carries a mark: the new chat is
 *   then also held to its runtime's default ({@link cappedForMarkedStart}).
 */
export async function resolveStartPermission(
  requested: string | undefined,
  chat: CallingChat | null,
  runtimeType: string,
  callerStop: PermissionStop | null = null,
  marked = false
): Promise<
  { ok: true; permission: SessionStartPermission } | { ok: false; error: string; code: string }
> {
  const own = await ceilingOf(chat, { stop: callerStop, runtimeType });
  const ceiling = marked ? cappedForMarkedStart(own, runtimeType) : own;
  const grant = grantMode(requested, ceiling, runtimeType);
  if (!grant.ok) return grant;
  // Full autonomy is never granted silently. An approval card shows only the
  // arguments a call sent, so an inherited Full autonomy would be invisible to
  // the person approving it: that level has to be asked for by name.
  if (requested === undefined && actsWithoutAsking(grant.mode)) {
    return {
      ok: false,
      error:
        `A new chat at ${grant.mode.label} has to be asked for by name, so the person ` +
        `approving can see it. Pass permissionMode "${grant.mode.id}", or a lower mode.`,
      code: 'NAME_FULL_AUTONOMY',
    };
  }
  return {
    ok: true,
    permission: {
      mode: grant.mode.id,
      label: grant.mode.label,
      callerMode: ceiling.callerMode,
      sameAsCaller: ceiling.exact && isNoLooserThan(grant.mode, ceiling.level),
    },
  };
}
