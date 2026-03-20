/**
 * Endpoint lifecycle management for the Relay message bus.
 *
 * Handles endpoint registration/unregistration, Maildir store
 * directory management, watcher lifecycle, and query facade methods
 * for endpoints, messages, dead letters, access rules, and metrics.
 *
 * @module relay/relay-endpoint-management
 */
import type { RelayAccessRule } from '@dorkos/shared/relay-schemas';
import type { EndpointRegistry } from './endpoint-registry.js';
import type { MaildirStore } from './maildir-store.js';
import type { SqliteIndex, IndexedMessage } from './sqlite-index.js';
import type { DeadLetterQueue, DeadLetterEntry, ListDeadOptions } from './dead-letter-queue.js';
import type { AccessControl } from './access-control.js';
import type { WatcherManager } from './watcher-manager.js';
import type { EndpointInfo, RelayMetrics } from './types.js';

/** Dependencies injected into the endpoint management module. */
export interface EndpointManagementDeps {
  endpointRegistry: EndpointRegistry;
  maildirStore: MaildirStore;
  sqliteIndex: SqliteIndex;
  deadLetterQueue: DeadLetterQueue;
  accessControl: AccessControl;
  watcherManager: WatcherManager;
}

// --- Endpoint Registration ---

/**
 * Register a new message endpoint (creates Maildir directories).
 *
 * Also starts a chokidar watcher on the endpoint's `new/` directory
 * to enable push delivery to subscription handlers.
 *
 * @param subject - The hierarchical subject for this endpoint
 * @param deps - Injected dependencies
 * @returns The registered EndpointInfo
 */
export async function executeRegisterEndpoint(
  subject: string,
  deps: EndpointManagementDeps
): Promise<EndpointInfo> {
  const info = await deps.endpointRegistry.registerEndpoint(subject);
  await deps.maildirStore.ensureMaildir(info.hash);
  await deps.watcherManager.startWatcher(info);
  return info;
}

/**
 * Unregister an endpoint and stop its watcher.
 *
 * @param subject - The subject of the endpoint to unregister
 * @param deps - Injected dependencies
 * @returns `true` if the endpoint was found and removed
 */
export async function executeUnregisterEndpoint(
  subject: string,
  deps: EndpointManagementDeps
): Promise<boolean> {
  const endpoint = deps.endpointRegistry.getEndpoint(subject);
  if (endpoint) {
    await deps.watcherManager.stopWatcher(endpoint.hash);
  }
  return deps.endpointRegistry.unregisterEndpoint(subject);
}

// --- Query Facade ---

/**
 * List all registered endpoints.
 *
 * @param deps - Injected dependencies
 * @returns Array of EndpointInfo objects
 */
export function executeListEndpoints(deps: EndpointManagementDeps): EndpointInfo[] {
  return deps.endpointRegistry.listEndpoints();
}

/**
 * Get a single message from the index by ID.
 *
 * @param id - The ULID of the message
 * @param deps - Injected dependencies
 * @returns The indexed message, or null if not found
 */
export function executeGetMessage(id: string, deps: EndpointManagementDeps): IndexedMessage | null {
  return deps.sqliteIndex.getMessage(id);
}

/**
 * Query messages with optional filters and cursor-based pagination.
 *
 * @param filters - Optional query filters (subject, status, from, cursor, limit)
 * @param deps - Injected dependencies
 * @returns Object with messages array and optional nextCursor
 */
export function executeListMessages(
  filters:
    | {
        subject?: string;
        status?: string;
        from?: string;
        cursor?: string;
        limit?: number;
      }
    | undefined,
  deps: EndpointManagementDeps
): { messages: IndexedMessage[]; nextCursor?: string } {
  return deps.sqliteIndex.queryMessages({
    subject: filters?.subject,
    status: filters?.status,
    sender: filters?.from,
    cursor: filters?.cursor,
    limit: filters?.limit,
  });
}

/**
 * Read inbox messages for a specific endpoint.
 *
 * @param subject - The endpoint subject to read inbox for
 * @param options - Optional query filters (status, cursor, limit)
 * @param deps - Injected dependencies
 * @returns Object with messages array and optional nextCursor
 * @throws If the endpoint is not found
 */
export function executeReadInbox(
  subject: string,
  options: { status?: string; cursor?: string; limit?: number } | undefined,
  deps: EndpointManagementDeps
): { messages: IndexedMessage[]; nextCursor?: string } {
  const endpoint = deps.endpointRegistry.getEndpoint(subject);
  if (!endpoint) {
    const error = new Error(`Endpoint not found: ${subject}`);
    (error as Error & { code: string }).code = 'ENDPOINT_NOT_FOUND';
    throw error;
  }
  return deps.sqliteIndex.queryMessages({
    endpointHash: endpoint.hash,
    status: options?.status,
    cursor: options?.cursor,
    limit: options?.limit,
  });
}

// --- Dead Letter Queue ---

/**
 * Get dead letters, optionally filtered by endpoint hash.
 *
 * @param options - Optional filtering options
 * @param deps - Injected dependencies
 * @returns Array of dead letter entries
 */
export async function executeGetDeadLetters(
  options: ListDeadOptions | undefined,
  deps: EndpointManagementDeps
): Promise<DeadLetterEntry[]> {
  return deps.deadLetterQueue.listDead(options);
}

// --- Access Rule Management ---

/**
 * Add an access control rule.
 *
 * Delegates to the internal AccessControl module, which
 * persists the rule to `access-rules.json` on disk.
 *
 * @param rule - The access rule to add (from, to, action, priority)
 * @param deps - Injected dependencies
 */
export function executeAddAccessRule(rule: RelayAccessRule, deps: EndpointManagementDeps): void {
  deps.accessControl.addRule(rule);
}

/**
 * Remove the first access control rule matching the given patterns.
 *
 * @param from - The `from` pattern to match
 * @param to - The `to` pattern to match
 * @param deps - Injected dependencies
 */
export function executeRemoveAccessRule(
  from: string,
  to: string,
  deps: EndpointManagementDeps
): void {
  deps.accessControl.removeRule(from, to);
}

/**
 * List all access control rules, sorted by priority (highest first).
 *
 * @param deps - Injected dependencies
 * @returns A shallow copy of the current rules array
 */
export function executeListAccessRules(deps: EndpointManagementDeps): RelayAccessRule[] {
  return deps.accessControl.listRules();
}

// --- Index ---

/**
 * Rebuild the SQLite index from Maildir files on disk.
 *
 * This is the recovery mechanism for index corruption. Drops all
 * existing index data and re-scans all endpoint Maildir directories.
 *
 * @param deps - Injected dependencies
 * @returns The number of messages re-indexed
 */
export async function executeRebuildIndex(deps: EndpointManagementDeps): Promise<number> {
  const endpoints = deps.endpointRegistry.listEndpoints();
  const hashMap = new Map<string, string>();
  for (const ep of endpoints) {
    hashMap.set(ep.hash, ep.subject);
  }
  return deps.sqliteIndex.rebuild(deps.maildirStore, hashMap);
}

// --- Metrics ---

/**
 * Get aggregate metrics from the SQLite index.
 *
 * @param deps - Injected dependencies
 * @returns Relay metrics including total messages, counts by status and subject
 */
export function executeGetMetrics(deps: EndpointManagementDeps): RelayMetrics {
  return deps.sqliteIndex.getMetrics();
}
