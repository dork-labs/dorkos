/**
 * The process's one account usage store, so the runtime feeds, the route and
 * the MCP tool reach it (mirrors `setSessionEventStore`).
 *
 * @module services/core/usage/current-usage-store
 */
import type { AccountUsageStore } from './account-usage-store.js';

let currentStore: AccountUsageStore | undefined;

/**
 * Install the process's one usage store.
 *
 * @param store - The store, or `undefined` to clear it (shutdown, tests).
 */
export function setAccountUsageStore(store: AccountUsageStore | undefined): void {
  currentStore = store;
}

/** The installed usage store, or `undefined` before boot wires one. */
export function getAccountUsageStore(): AccountUsageStore | undefined {
  return currentStore;
}
