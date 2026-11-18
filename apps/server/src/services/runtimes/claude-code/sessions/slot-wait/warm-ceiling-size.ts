/**
 * How many claude-code processes this machine may keep running at once
 * (DOR-3012).
 *
 * The ceiling used to be a fixed twelve. On 2026-10-18 a 48 GB machine filled
 * it with about 5.5 GB in use, and one room post that named seven agents turned
 * every one of them into "ran into a problem". So it is now a setting,
 * `runtimes.claudeCode.maxWarmProcesses`, and left unset it is sized to the
 * machine's memory, and to at least the agent chat cap (DOR-4498).
 *
 * Read at acquire time, like the rest of the registry's bounds, so a change
 * applies to the next process that starts rather than after a restart.
 *
 * @module services/runtimes/claude-code/sessions/slot-wait/warm-ceiling-size
 */
import { totalmem } from 'node:os';
import type { UserConfig } from '@dorkos/shared/config-schema';
import { SESSIONS } from '../../../../../config/constants.js';
import { logger } from '../../../../../lib/logger.js';
import { configManager } from '../../../../core/config-manager.js';

/** Minimal read surface of the config manager (injectable for tests). */
type ConfigReader = { get<K extends keyof UserConfig>(key: K): UserConfig[K] };

/** Bytes in one gigabyte, as `os.totalmem()` counts them. */
const GB = 1024 ** 3;

/** The pin and chat cap last warned about, so a warning is said once per change. */
let warnedFor: string | undefined;

/**
 * The ceiling for a machine with `memoryBytes` of memory: one process per
 * `SESSIONS.WARM_SESSION_RAM_GB`, held between `SESSIONS.MIN_WARM_SESSIONS`
 * and `SESSIONS.MAX_WARM_SESSIONS_AUTO`.
 *
 * @param memoryBytes - Total memory, as `os.totalmem()` reports it
 */
export function autoWarmCeiling(memoryBytes: number): number {
  const byMemory = Math.floor(memoryBytes / GB / SESSIONS.WARM_SESSION_RAM_GB);
  return Math.min(SESSIONS.MAX_WARM_SESSIONS_AUTO, Math.max(SESSIONS.MIN_WARM_SESSIONS, byMemory));
}

/** A positive whole number, or undefined for anything else. */
function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Say, once per change, that a pinned ceiling sits below the chat cap. More
 * busy chats than warm processes means chats take each other's processes, and
 * each one taken restarts every MCP server it ran (DOR-4498).
 */
function warnIfBelowChatCap(pinned: number, chats: number | undefined): void {
  if (chats === undefined || pinned >= chats) return;
  const key = `${pinned}/${chats}`;
  if (warnedFor === key) return;
  warnedFor = key;
  logger.warn(
    `[warm-ceiling-size] warm processes (${pinned}) is below agent chats (${chats}); expect restarts`,
    { maxWarmProcesses: pinned, maxAgentChats: chats }
  );
}

/**
 * The warm ceiling in force right now: the person's number when they set one,
 * else {@link autoWarmCeiling} for this machine, raised to `runtimes.maxAgentChats`
 * so every chat agents may run can stay warm, within
 * `SESSIONS.MAX_WARM_SESSIONS_AUTO`. A pin is never raised; one below the chat
 * cap is logged.
 *
 * @param config - Where the setting is read from; the live config by default
 * @param memoryBytes - Total memory; this machine's by default
 */
export function resolveMaxWarmSessions(
  config: ConfigReader = configManager,
  memoryBytes: number = totalmem()
): number {
  const auto = autoWarmCeiling(memoryBytes);
  try {
    const runtimes = config.get('runtimes');
    const chats = positiveInt(runtimes?.maxAgentChats);
    const pinned = positiveInt(runtimes?.claudeCode?.maxWarmProcesses);
    if (pinned !== undefined) {
      warnIfBelowChatCap(pinned, chats);
      return pinned;
    }
    return Math.min(SESSIONS.MAX_WARM_SESSIONS_AUTO, Math.max(auto, chats ?? 0));
  } catch (err) {
    logger.debug('[warm-ceiling-size] config unavailable, sizing to the machine', {
      err: String(err),
    });
  }
  return auto;
}
