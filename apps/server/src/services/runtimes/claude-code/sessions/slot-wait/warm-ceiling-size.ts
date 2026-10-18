/**
 * How many claude-code processes this machine may keep running at once
 * (DOR-3012).
 *
 * The ceiling used to be a fixed twelve. On 2026-10-18 a 48 GB machine filled
 * it with about 5.5 GB in use, and one room post that named seven agents turned
 * every one of them into "ran into a problem". So it is now a setting,
 * `runtimes.claudeCode.maxWarmProcesses`, and left unset it is sized to the
 * machine's memory.
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

/**
 * The warm ceiling in force right now: the person's number when they set one,
 * else {@link autoWarmCeiling} for this machine.
 *
 * @param config - Where the setting is read from; the live config by default
 * @param memoryBytes - Total memory; this machine's by default
 */
export function resolveMaxWarmSessions(
  config: ConfigReader = configManager,
  memoryBytes: number = totalmem()
): number {
  try {
    const pinned = config.get('runtimes')?.claudeCode?.maxWarmProcesses;
    if (typeof pinned === 'number' && Number.isInteger(pinned) && pinned > 0) return pinned;
  } catch (err) {
    logger.debug('[warm-ceiling-size] config unavailable, sizing to the machine', {
      err: String(err),
    });
  }
  return autoWarmCeiling(memoryBytes);
}
