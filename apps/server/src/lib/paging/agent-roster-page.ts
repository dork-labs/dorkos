/**
 * One page of the agent roster (DOR-4982, DOR-5480), the one rule both doors
 * that list it follow: `GET /api/mesh/agents` and the `mesh_list` agent tool.
 * Newest registered first, keyed by `[registeredAt, id]`, a key that never
 * moves, so an agent registered while someone pages is never repeated. The
 * filters are bound into the cursor, and the cursor is sealed to its reader
 * (`caller-reader-key.ts`), so a cursor given for one filter or one reader
 * does not go on in another.
 *
 * @module lib/paging/agent-roster-page
 */
import type { PageQuery } from '@dorkos/shared/paging';
import { assertPageCursor, keysetPage, type KeysetPage } from './keyset-page.js';

/** The filters a roster read takes, as both doors accept them. */
export interface AgentRosterFilters {
  /** Only agents on this runtime. */
  readonly runtime?: string | undefined;
  /** Only agents that declare this capability. */
  readonly capability?: string | undefined;
  /** Only agents in the namespaces this one can reach. */
  readonly callerNamespace?: string | undefined;
}

/** The list name a roster cursor is bound to: the filters, in one fixed order. */
function rosterList(filters: AgentRosterFilters): string {
  const { runtime, capability, callerNamespace } = filters;
  return `agents:${JSON.stringify({ runtime, capability, callerNamespace })}`;
}

/**
 * Refuse a cursor the roster did not give for these filters and this reader,
 * before the registry is read.
 *
 * @param filters - The read's filters.
 * @param cursor - The cursor as sent, if any.
 * @param refuse - The error to throw for one this list did not give.
 * @param sealedFor - The reader's key.
 */
export function assertAgentRosterCursor(
  filters: AgentRosterFilters,
  cursor: string | undefined,
  refuse: () => Error,
  sealedFor: string
): void {
  assertPageCursor(rosterList(filters), cursor, refuse, sealedFor);
}

/**
 * One page of the roster, newest registered first.
 *
 * @param rows - Every agent the filters keep, as the registry listed them.
 * @param filters - The read's filters, bound into the cursor.
 * @param query - The cursor, if any, and the page size.
 * @param refuse - The error to throw for a cursor this list did not give.
 * @param sealedFor - The reader's key.
 */
export function agentRosterPage<T extends { readonly id: string; readonly registeredAt: string }>(
  rows: readonly T[],
  filters: AgentRosterFilters,
  query: PageQuery,
  refuse: () => Error,
  sealedFor: string
): KeysetPage<T> {
  const keyOf = (agent: T) => [agent.registeredAt, agent.id] as const;
  return keysetPage(rosterList(filters), rows, keyOf, query, refuse, sealedFor);
}
