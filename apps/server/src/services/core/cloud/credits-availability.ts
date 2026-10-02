/**
 * Whether DorkOS credits can be had on this server right now (ADR
 * 261001-000811): not switched off by `DORKOS_CLOUD_CREDITS`, and this
 * computer linked to a DorkOS account.
 *
 * Its own small module, reading only the environment and the config, so the
 * surfaces that offer credits (the Runs on list, "Continue on another
 * account") can ask without loading the cloud client.
 *
 * @module services/core/cloud/credits-availability
 */
import { env } from '../../../env.js';
import { configManager } from '../config-manager.js';

/** The environment variable that can switch credits off for this server. */
export const CREDITS_KILL_SWITCH_NAME = 'DORKOS_CLOUD_CREDITS';

/**
 * Whether a kill-switch value turns credits off. Only the negative spellings
 * do; anything else (including the old `1`) leaves the person's choice in
 * charge, because the variable can take spending away and never add it.
 *
 * @param value - The raw environment value, or `undefined`.
 */
export function isCreditsKillSwitchOn(value: string | undefined): boolean {
  return ['0', 'false', 'no', 'off'].includes(value?.trim().toLowerCase() ?? '');
}

/**
 * The kill switch, read ONCE at module scope, so no other file's `vi.stubEnv`
 * can change it mid-run.
 */
const CREDITS_KILLED = isCreditsKillSwitchOn(env.DORKOS_CLOUD_CREDITS);

/** Whether the kill switch has turned credits off for this server. */
export function creditsKilled(): boolean {
  return CREDITS_KILLED;
}

/**
 * Whether credits can be chosen right now: not switched off, and linked.
 * `false` when the link cannot be read, which offers nothing.
 */
export function creditsCanBeHad(): boolean {
  if (CREDITS_KILLED) return false;
  try {
    const token = configManager.get('cloud')?.instanceToken;
    return typeof token === 'string' && token.trim() !== '';
  } catch {
    return false;
  }
}
