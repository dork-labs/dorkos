/**
 * One runtime's declared settings surface, read off the capability map.
 *
 * Replaces the client's hand-kept copy of the server's config-section map: the
 * runtime declares where its settings live, and every surface reads that one
 * answer instead of a second spelling that can drift.
 *
 * @module entities/runtime/lib/settings-for-runtime
 */
import type { RuntimeCapabilities, RuntimeSettingsCapability } from '@dorkos/shared/agent-runtime';

export type { RuntimeSettingsCapability };

/**
 * One runtime's declared settings surface, from the capability map.
 *
 * Half-loaded map, unregistered runtime, or a nullish type all answer
 * `undefined`, and callers no-op on it — the optional-all-the-way-down
 * convention the settings surfaces already follow. Absence is never an error:
 * a runtime with no config section simply has no per-runtime leaf to write.
 *
 * @param capabilityMap - The `useRuntimeCapabilities()` payload, or undefined.
 * @param type - Runtime type id, e.g. `'claude-code'`.
 */
export function settingsForRuntime(
  capabilityMap: { capabilities: Record<string, RuntimeCapabilities> } | undefined,
  type: string | null | undefined
): RuntimeSettingsCapability | undefined {
  if (!type) return undefined;
  return capabilityMap?.capabilities[type]?.settings;
}
