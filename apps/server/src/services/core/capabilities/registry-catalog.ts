/** Catalog rendering, stable content hashing and isolated invocation observation. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { stableStringify, type SerializedCapability } from '@dorkos/shared/capabilities';
import type { CapabilityDefinition } from './capability-definition.js';
import type {
  CapabilityInvocationContext,
  CapabilityInvocationObserver,
} from './registry-context.js';

/**
 * Convert one capability to its serializable catalog entry: drop `invoke` and
 * render both Zod schemas as JSON Schema via Zod v4's native conversion.
 *
 * `area` is always present (`null` for an area-less capability), because the
 * declaration on the definition is meant to have exactly one answer everywhere:
 * the gate resolves it, the permissions pages read each area's actions off the
 * live catalog instead of a static list that would drift, and the docs
 * projection reports the same field.
 *
 * `source` is present only for an extension's capability, naming the
 * extension, so every reader of the catalog can say where a tool came from.
 *
 * @param capability - The runtime capability definition.
 * @returns The serialized, wire-safe entry.
 */
export function serializeCapability(capability: CapabilityDefinition): SerializedCapability {
  return {
    id: capability.id,
    title: capability.title,
    description: capability.description,
    tier: capability.tier,
    inputSchema: z.toJSONSchema(capability.input),
    outputSchema: z.toJSONSchema(capability.output),
    surfaces: capability.surfaces,
    area: capability.area,
    // Only a definition the host built for a running extension has a source;
    // a core capability's entry stays exactly as it was (DOR-2685).
    ...(capability.source ? { source: { ...capability.source } } : {}),
  };
}

/**
 * Call an invocation observer, swallowing anything it throws.
 *
 * Attribution is a side channel: it must never turn a successful capability
 * call into a failed one, nor mask the handler's own error with its own.
 */
export function notify(
  observer: CapabilityInvocationObserver,
  capability: CapabilityDefinition,
  context: CapabilityInvocationContext,
  ok: boolean,
  error?: unknown
): void {
  try {
    observer({ capability, context, ok, ...(ok ? {} : { error }) });
  } catch {
    // Deliberately ignored — see the TSDoc above.
  }
}

/**
 * Compute the stable `catalogVersion` content hash over a set of serialized
 * capabilities.
 *
 * The hash is order-independent in two senses: capabilities are sorted by id,
 * and every object's keys are sorted recursively ({@link stableStringify}),
 * before hashing — so neither the order domains were composed in nor the order
 * fields were written in changes the version. Only the actual content does.
 *
 * @param capabilities - The serialized capabilities to hash.
 * @returns The first 12 hex chars of the SHA-256 digest.
 */
export function computeCatalogVersion(capabilities: readonly SerializedCapability[]): string {
  const sorted = [...capabilities].sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha256').update(stableStringify(sorted)).digest('hex').slice(0, 12);
}
