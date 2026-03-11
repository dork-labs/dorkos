/**
 * Relay adapter API version constant.
 *
 * Bump this when the RelayAdapter interface changes:
 * - MAJOR: Breaking changes to required interface members
 * - MINOR: New optional members, new types, behavioral changes
 *
 * Pre-1.0: No stability guarantees.
 * Post-1.0: Follow SemVer — MAJOR for breaking, MINOR for additive.
 *
 * @module relay/version
 */

/**
 * Current relay adapter API version.
 *
 * Third-party adapters declare this in their manifest `apiVersion` field.
 * The plugin loader emits a warning when the adapter's declared version
 * does not match the host version.
 */
export const RELAY_ADAPTER_API_VERSION = '0.1.0';
