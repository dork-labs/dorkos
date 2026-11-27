/**
 * The package reads of the agent facts port, as the harness code holds them
 * (spec `computer-side-starts-alone` §5.3): DorkOS's marketplace sources, their
 * cached catalogs, the install index and an install folder's digest, read
 * without reaching across the wall into the marketplace code that keeps them.
 *
 * Startup, harness boot and the CLI's harness verbs fill it with the
 * marketplace's own reads (`marketplace/package-facts.ts`). Until then every
 * read rejects and names the missing wiring.
 *
 * @module services/harness/agent-facts
 */
import { createPackageFactsSlot, type PackageFactsPort } from '@dorkos/shared/agent-facts';

const slot = createPackageFactsSlot();

/**
 * Hand this code the package reads, or clear them.
 *
 * @param next - The reads, or `undefined` to clear them.
 */
export function setHarnessPackageFacts(next: PackageFactsPort | undefined): void {
  slot.set(next);
}

/** The package reads, or the unwired ones before they are handed over. */
export function harnessPackageFacts(): PackageFactsPort {
  return slot.get();
}
