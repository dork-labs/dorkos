/**
 * Reads and writes of a schedule's `agent_mode_record` column (DOR-3703): the
 * agent's record, its attestation and the person's floor, each changed alone
 * (`agent-mode/agent-mode-record-field.ts` holds the shape). Kept out of
 * `task-approvals.ts`, whose methods delegate here.
 *
 * @module services/tasks/approvals/agent-mode-column
 */
import { eq } from 'drizzle-orm';
import { pulseSchedules, type Db } from '@dorkos/db';
import {
  patchAgentModeColumn,
  readAgentModeColumn,
  type AgentModeColumn,
  type AgentModeColumnPatch,
} from '../agent-mode/agent-mode-record-field.js';

/**
 * The column of one schedule, read back; empty for one that does not exist.
 *
 * @param db - The store's database.
 * @param id - The schedule.
 */
export function readAgentModeColumnOf(db: Db, id: string): AgentModeColumn {
  const row = db
    .select({ text: pulseSchedules.agentModeRecord })
    .from(pulseSchedules)
    .where(eq(pulseSchedules.id, id))
    .get();
  return readAgentModeColumn(row?.text);
}

/**
 * Change one part of the column and leave the others as they are.
 *
 * @param db - The store's database.
 * @param id - The schedule.
 * @param patch - What to set (a value) or remove (`null`).
 * @param extra - Other columns written in the same statement.
 */
export function patchAgentModeColumnOf(
  db: Db,
  id: string,
  patch: AgentModeColumnPatch,
  extra: { agentApprovalKey?: string } = {}
): void {
  const row = db
    .select({ text: pulseSchedules.agentModeRecord })
    .from(pulseSchedules)
    .where(eq(pulseSchedules.id, id))
    .get();
  if (!row) return;
  db.update(pulseSchedules)
    .set({ ...extra, agentModeRecord: patchAgentModeColumn(row.text, patch) })
    .where(eq(pulseSchedules.id, id))
    .run();
}
