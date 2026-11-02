/**
 * The schedule a `schedule.*` notification is about, as both its payloads carry
 * it. Its own module so the registry, which may not grow, names it once.
 *
 * @module services/notifications/emitters/schedule-subject
 */

/** Which schedule, and who its runs act as. */
export interface ScheduleSubject {
  /** The schedule's id. */
  taskId: string;
  /** What the person calls it. */
  taskName: string;
  /** The agent it is filed under; absent for a global schedule. */
  agentId?: string;
  /**
   * Who its runs act as: the agent's name, or `no agent` for a global one
   * (DOR-3640). Absent on a notification stored before it was carried.
   */
  runsAs?: string;
}
