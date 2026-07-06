/**
 * The device-link wire contract shared between the cloud (this task, 2.3) and
 * the local cloud-link service (task 2.4).
 *
 * A linking instance sends its display metadata (name, platform, DorkOS version)
 * to the cloud on the RFC 8628 `POST /device/code` request in the OAuth `scope`
 * field, encoded by {@link encodeInstanceDescriptor}. The cloud persists it on
 * the device-code record, surfaces it at `/activate` (so the human sees which
 * instance is asking before approving), and — on approval — copies it into the
 * issued API key's metadata. The instance re-sends the same fields on every
 * `POST /api/instances/heartbeat`, which is authoritative for the registry.
 *
 * @module lib/instance-descriptor
 */

/**
 * Stable `client_id` a DorkOS instance presents on the device-authorization
 * endpoints. RFC 8628 requires a client id; the flow is not per-app-registered,
 * so a single shared identifier is sufficient.
 */
export const INSTANCE_CLIENT_ID = 'dorkos-instance';

/**
 * Permission marker stamped on every instance-scoped API key
 * (`permissions: { instance: [...] }`) so future cloud features can gate on
 * "is this an instance key" without inspecting metadata.
 */
export const INSTANCE_PERMISSION_RESOURCE = 'instance';

/** The action granted to an instance key under {@link INSTANCE_PERMISSION_RESOURCE}. */
export const INSTANCE_PERMISSION_ACTION = 'link';

/** Prefix applied to instance API keys, so a leaked value is self-identifying. */
export const INSTANCE_KEY_PREFIX = 'dork_inst';

/** The instance display metadata carried through the device-link flow. */
export interface InstanceDescriptor {
  /** Human-readable instance name (typically the hostname). */
  name: string;
  /** `process.platform` of the instance (e.g. `darwin`, `linux`, `win32`). */
  platform: string;
  /** DorkOS version the instance is running (e.g. `0.4.2`). */
  dorkosVersion: string;
}

/** Copy shown when an instance did not send a usable descriptor. */
const UNKNOWN_NAME = 'A DorkOS instance';
const UNKNOWN_PLATFORM = 'unknown';
const UNKNOWN_VERSION = 'unknown';

/**
 * Encode an instance descriptor for the device-code `scope` field.
 *
 * @param descriptor - The instance's display metadata.
 * @returns A compact JSON string safe to carry as an OAuth scope value.
 */
export function encodeInstanceDescriptor(descriptor: InstanceDescriptor): string {
  return JSON.stringify({
    name: descriptor.name,
    platform: descriptor.platform,
    dorkosVersion: descriptor.dorkosVersion,
  });
}

/**
 * Decode an instance descriptor from a device-code `scope` value, tolerating a
 * missing or malformed value with honest "unknown" fallbacks (a linking instance
 * is untrusted input until it heartbeats).
 *
 * @param scope - The raw `scope` string persisted on the device-code record, if any.
 * @returns A fully-populated descriptor; unknown fields fall back to placeholders.
 */
export function parseInstanceDescriptor(scope: string | null | undefined): InstanceDescriptor {
  const fallback: InstanceDescriptor = {
    name: UNKNOWN_NAME,
    platform: UNKNOWN_PLATFORM,
    dorkosVersion: UNKNOWN_VERSION,
  };
  if (!scope) return fallback;
  try {
    const parsed: unknown = JSON.parse(scope);
    if (!parsed || typeof parsed !== 'object') return fallback;
    const record = parsed as Record<string, unknown>;
    return {
      name: typeof record.name === 'string' && record.name.trim() ? record.name : fallback.name,
      platform:
        typeof record.platform === 'string' && record.platform.trim()
          ? record.platform
          : fallback.platform,
      dorkosVersion:
        typeof record.dorkosVersion === 'string' && record.dorkosVersion.trim()
          ? record.dorkosVersion
          : fallback.dorkosVersion,
    };
  } catch {
    return fallback;
  }
}
