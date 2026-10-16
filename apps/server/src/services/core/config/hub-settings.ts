/**
 * The settings a hub keeps whatever is written (DOR-2934).
 *
 * A hub is a person's own DorkOS in the cloud, reached only from other
 * devices, so login is always on there. Rather than teach every reader of
 * `auth.enabled` about hubs, the settings themselves say so: on a hub a read
 * of `auth` always reports it on, and a write that would turn it off is
 * refused with a sentence the person can read. On a person's own computer
 * both are no-ops.
 *
 * @module services/core/config/hub-settings
 */
import { currentServerRole } from '../../../lib/server-role.js';

/** Why a write was refused on a hub. */
export const HUB_LOGIN_ALWAYS_ON = 'Login is always on here. It cannot be turned off.';

/**
 * A config section as a hub reads it: `auth.enabled` is always `true`.
 *
 * @param key - The top-level section, or a dot-path into one.
 * @param value - The value as the store holds it.
 */
export function hubPinnedRead(key: string, value: unknown): unknown {
  if (currentServerRole() !== 'hub') return value;
  if (key === 'auth.enabled') return true;
  if (key === 'auth') {
    const section = value !== null && typeof value === 'object' ? value : {};
    return { ...section, enabled: true };
  }
  return value;
}

/**
 * Refuse a write that would turn login off on a hub.
 *
 * @param path - The top-level section, or a dot-path into one.
 * @param value - The value about to be written.
 * @returns The refusal, or `null` when the write may go ahead.
 */
export function hubSettingRefusal(path: string, value: unknown): string | null {
  if (currentServerRole() !== 'hub') return null;
  const enabled =
    path === 'auth.enabled'
      ? value
      : path === 'auth' && value !== null && typeof value === 'object'
        ? (value as { enabled?: unknown }).enabled
        : true;
  return enabled === false ? HUB_LOGIN_ALWAYS_ON : null;
}
