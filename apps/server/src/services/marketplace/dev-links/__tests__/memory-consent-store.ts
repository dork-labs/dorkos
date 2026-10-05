/**
 * An in-memory {@link DevLinkConsentStore} for tests: the same semantics as
 * the hook-decision lists (`recordApprovedEntry` / `forgetApprovedEntries`),
 * without a config file.
 */
import type { DevLinkConsentStore } from '../consent.js';

/** The store, plus direct access to what it holds. */
export interface MemoryConsentStore extends DevLinkConsentStore {
  /** The stored yeses, in order. */
  entries: string[];
}

/**
 * Build an in-memory consent store.
 *
 * @param initial - Yeses already stored.
 */
export function memoryConsentStore(initial: string[] = []): MemoryConsentStore {
  const store: MemoryConsentStore = {
    entries: [...initial],
    approved: () => [...store.entries],
    approve(entry, replacing = () => false) {
      const kept = store.entries.filter((stored) => stored === entry || !replacing(stored));
      store.entries = kept.includes(entry) ? kept : [...kept, entry];
    },
    forget(matches) {
      store.entries = store.entries.filter((stored) => !matches(stored));
    },
  };
  return store;
}
