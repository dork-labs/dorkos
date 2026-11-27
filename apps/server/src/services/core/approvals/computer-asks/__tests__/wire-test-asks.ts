/**
 * Wire the asks and the consent writes for a test, as startup does
 * (`startup/computer-asks.ts`).
 *
 * @module services/core/approvals/computer-asks/__tests__/wire-test-asks
 */
import type { ComputerAsks } from '@dorkos/shared/computer-asks';
import { UserConfigSchema, type UserConfig } from '@dorkos/shared/config-schema';
import { wireComputerAsks, wireConsentWrites } from '../../../../../startup/computer-asks.js';
import type { ConsentConfigStore, ConsentSection } from '../consent-config.js';
import { computerAsks, setAskApprovals, type AskApprovals } from '../index.js';

/**
 * Hand every computer-side slot the space side's asks, the consent writes
 * their store, and the asks this approval primitive. `null` raises no card
 * (every ask answers `unwired`) but still records standing decisions, as a
 * server before its approvals step.
 *
 * @param approvals - The approval primitive, or `null`.
 * @returns The port every slot now holds.
 */
export function wireTestAsks(approvals: AskApprovals | null = null): ComputerAsks {
  setAskApprovals(approvals);
  wireComputerAsks();
  return computerAsks;
}

/** An in-memory consent store, and the sections it holds. */
export interface MemoryConsentStore extends ConsentConfigStore {
  /** The sections as written so far. */
  sections: { harness: UserConfig['harness']; permissions: UserConfig['permissions'] };
}

/** A consent store that holds both sections in memory, starting from their defaults. */
export function memoryConsentStore(): MemoryConsentStore {
  const sections = {
    harness: UserConfigSchema.shape.harness.parse(undefined),
    permissions: UserConfigSchema.shape.permissions.parse(undefined),
  };
  return {
    sections,
    get: <K extends ConsentSection>(section: K) => sections[section] as UserConfig[K],
    set: (section, value) => {
      (sections as Record<ConsentSection, unknown>)[section] = value;
    },
    logWrite: () => undefined,
  };
}

/**
 * Wire only the consent writes, for a test of the space side's writers: over
 * `store`; over a plain object holding the sections (a test's own config
 * stand-in, read and written in place); or over the process's config.
 *
 * @param store - The store, or the object holding the sections.
 */
export function wireTestConsent(
  store?: ConsentConfigStore | Partial<Record<ConsentSection, unknown>>
): void {
  if (store === undefined || typeof (store as ConsentConfigStore).get === 'function') {
    wireConsentWrites(store as ConsentConfigStore | undefined);
    return;
  }
  const held = store as Record<ConsentSection, unknown>;
  wireConsentWrites({
    get: <K extends ConsentSection>(section: K) => held[section] as UserConfig[K],
    set: (section, value) => {
      held[section] = value;
    },
    logWrite: () => undefined,
  });
}
