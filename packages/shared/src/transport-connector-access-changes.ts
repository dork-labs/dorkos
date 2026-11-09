/**
 * An agent's change to another agent's access to a connected app, as the
 * person reads and undoes it from its Needs-you item (spec
 * `agent-grant-autonomy`). A slice of the `Transport` (`transport-slices.ts`).
 *
 * @module shared/transport-connector-access-changes
 */
import type {
  ConnectorAccessChange,
  ConnectorAccessChangeUndo,
} from './connector-exclusion-schemas.js';

/** Read and undo one agent-made access change. */
export interface ConnectorAccessChangeTransport {
  /**
   * The newest access changes on the person's own connections, newest first
   * (`GET /api/connectors/access-changes`, at most 200). A person's read only:
   * the server refuses agents.
   *
   * @param limit - How many to read; the server's default is 50.
   */
  listAccessChanges(limit?: number): Promise<ConnectorAccessChange[]>;
  /**
   * One change, with the agent's own reason (`GET /api/connectors/access-changes/:id`).
   * A person's read only: the server refuses agents. Show the reason as plain
   * text, attributed to the agent.
   *
   * @param changeId - The change, as its Needs-you item names it.
   */
  getAccessChange(changeId: string): Promise<ConnectorAccessChange>;
  /**
   * Put back what the change took away (`POST /api/connectors/access-changes/:id/undo`).
   * Refused with `UNDO_STALE` once access changed since.
   *
   * @param changeId - The change to undo.
   */
  undoAccessChange(changeId: string): Promise<ConnectorAccessChangeUndo>;
}
