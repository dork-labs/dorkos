/**
 * The capabilities the mount serves for the audit read side, in mount order:
 * the audit domain's own reads and the work graph's reads, which take their
 * reader and roster from it (`services/work-graph/reads/`). One stretch of the
 * mount list `./capability-http.test.ts` pins.
 *
 * @module routes/__tests__/audit-read-side-mounted
 */

/** The audit read side's mounted capabilities, in the order the mount serves them. */
export const AUDIT_READ_SIDE_MOUNTED: readonly string[] = [
  'audit.verify',
  'audit.query',
  'audit.get',
  'audit.account_timeline',
  'audit.running_chats',
  'work-graph.agent_chats',
  'work-graph.chat_tree',
  'work-graph.agent_work',
  'work-graph.chat_work',
];
