/** Stable catalog hashing, separate from runtime registry composition. */
import { createHash } from 'node:crypto';
import { stableStringify, type SerializedCapability } from '@dorkos/shared/capabilities';

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
