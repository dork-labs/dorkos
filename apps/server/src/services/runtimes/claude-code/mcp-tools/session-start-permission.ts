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
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import { isNoLooserThan, needsConsentRitual } from '@dorkos/shared/permission-semantics';
import { logError, logger } from '../../../../lib/logger.js';
import {
  AUTONOMY_ACK_REQUIRED_CODE,
  hasStandingAutonomyAck,
} from '../../../core/approvals/autonomy-consent.js';
import { runtimeRegistry } from '../../../core/runtime-registry.js';

/**
 * The ceiling for a caller that has no chat (the external `/mcp` server): Claude
 * Code's `acceptEdits`. There is no chat level to inherit, so it keeps the limit
 * every caller had before chats could pass on their own.
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
}

/** The highest level a call may start a chat at. */
interface Ceiling {
  /** The level, as asking and reach. */
  level: Pick<PermissionModeDescriptor, 'asks' | 'reach'>;
  /** What to call it in a refusal. */
  label: string;
  /** The calling chat's mode id, or null with no chat (or none could be resolved). */
  modeId: string | null;
  /** Whether the call came from a chat, which decides how a refusal reads. */
  inChat: boolean;
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

/** The stored mode of a chat whose live session object is gone, or null. */
async function storedModeOf(sessionId: string | null): Promise<string | null> {
  if (!sessionId) return null;
  try {
    return (await runtimeRegistry.getSessionSettings(sessionId))?.permissionMode ?? null;
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
 * 1. In a chat: its live mode, read at call time.
 * 2. In a chat with no live mode: its stored settings row.
 * 3. Neither, or an id its runtime does not declare: that runtime's declared
 *    default, and {@link FLOOR} when even that cannot be found. Fails closed.
 * 4. No chat at all: {@link NO_CHAT_CEILING_MODE}.
 */
async function ceilingOf(chat: CallingChat | null): Promise<Ceiling> {
  if (!chat) {
    const found = declaredModes(NO_CHAT_CEILING_RUNTIME).values.find(
      (m) => m.id === NO_CHAT_CEILING_MODE
    );
    return found
      ? { level: found, label: found.label, modeId: null, inChat: false }
      : { level: FLOOR, label: 'read only', modeId: null, inChat: false };
  }
  const modes = declaredModes(chat.runtime);
  const id = chat.permissionMode ?? (await storedModeOf(chat.sessionId));
  const own = id ? modes.values.find((m) => m.id === id) : undefined;
  const fallback = own ?? modes.values.find((m) => m.id === modes.default);
  return fallback
    ? { level: fallback, label: fallback.label, modeId: fallback.id, inChat: true }
    : { level: FLOOR, label: 'read only', modeId: null, inChat: true };
}

/** The level a start is granted, or why it is refused. */
type Grant =
  { ok: true; mode: PermissionModeDescriptor } | { ok: false; error: string; code: string };

/**
 * The mode a start runs at, against the target runtime's declared modes: the one
 * asked for when it is not above the ceiling; with none asked for, the caller's
 * own (when the target declares it and it fits), else the target's default
 * (when it fits). Compared by declared asking and reach, never by id, so it holds
 * when the new chat runs on another runtime.
 */
function grantMode(requested: string | undefined, ceiling: Ceiling, runtimeType: string): Grant {
  const target = declaredModes(runtimeType);
  const fits = (mode: PermissionModeDescriptor) => isNoLooserThan(ceiling.level, mode);
  if (requested !== undefined) {
    const mode = target.values.find((m) => m.id === requested);
    if (!mode) {
      return {
        ok: false,
        error: `The ${runtimeType} runtime has no permission mode called ${requested}.`,
        code: 'UNKNOWN_PERMISSION_MODE',
      };
    }
    if (!fits(mode)) {
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
    return { ok: true, mode };
  }
  const own = ceiling.modeId ? target.values.find((m) => m.id === ceiling.modeId) : undefined;
  if (own && fits(own)) return { ok: true, mode: own };
  const fallback = target.values.find((m) => m.id === target.default);
  if (fallback && fits(fallback)) return { ok: true, mode: fallback };
  return {
    ok: false,
    error:
      `No permission mode of the ${runtimeType} runtime fits under ${ceiling.label} by default. ` +
      'Name a permissionMode at your level or lower.',
    code: 'NO_MODE_FITS',
  };
}

/**
 * Everything `session_start` decides about the level, in one call: the ceiling,
 * the grant against the target runtime's declared modes, and the Full autonomy
 * acknowledgement the granted mode may need. Nothing is written here; a refusal
 * leaves nothing behind.
 *
 * @param requested - The mode the tool was asked for, if any.
 * @param chat - The calling chat, or null for a caller with none.
 * @param runtimeType - The runtime the new chat runs on.
 */
export async function resolveStartPermission(
  requested: string | undefined,
  chat: CallingChat | null,
  runtimeType: string
): Promise<
  { ok: true; permission: SessionStartPermission } | { ok: false; error: string; code: string }
> {
  const ceiling = await ceilingOf(chat);
  const grant = grantMode(requested, ceiling, runtimeType);
  if (!grant.ok) return grant;
  if (needsConsentRitual(grant.mode) && !hasStandingAutonomyAck()) {
    return {
      ok: false,
      error:
        `Starting a chat at ${grant.mode.label} needs the person's standing okay for Full ` +
        'autonomy, and there is none on file. Ask for a lower mode, or ask the person.',
      code: AUTONOMY_ACK_REQUIRED_CODE,
    };
  }
  return {
    ok: true,
    permission: {
      mode: grant.mode.id,
      label: grant.mode.label,
      callerMode: ceiling.modeId,
      sameAsCaller: ceiling.modeId !== null && isNoLooserThan(grant.mode, ceiling.level),
    },
  };
}
