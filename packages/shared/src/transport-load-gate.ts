/**
 * The Transport slice for the person's view of the load gate's waiting line (DOR-4209).
 *
 * @module shared/transport-load-gate
 */
import type { LoadGateJobAction, LoadGateWaitingLine } from './load-gate-queue.js';

/** What the app reads about heavy jobs waiting their turn, and a person's actions on one. */
export interface LoadGateTransport {
  /** The heavy jobs waiting their turn, first in line first. Refused anywhere but this computer. */
  getLoadGateWaitingLine(): Promise<LoadGateWaitingLine>;
  /**
   * Let one job through now, mark it urgent, or move it to the front.
   *
   * @param id - The job's id.
   * @param action - What to do.
   * @returns The line after the change.
   */
  actOnLoadGateJob(id: string, action: LoadGateJobAction): Promise<LoadGateWaitingLine>;
}
