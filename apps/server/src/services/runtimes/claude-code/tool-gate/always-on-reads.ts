/**
 * DorkOS's always-on reads: the hand-registered tools that only read what DorkOS itself is, so
 * nothing switches them off (tier `observe`, no permission area, `core/mcp-tool-tiers.ts`).
 *
 * They join `DORKOS_AGENT_TOOLS` (`auto-allow.ts`) so they run unasked in every mode (DOR-3373). Before, a
 * scheduled run at `acceptEdits` or `default` had them refused for want of a person, and one at
 * Never ask had them refused by Claude Code before DorkOS was asked, so a health check could
 * not even ping the server it ran on. Only reads join: nothing here acts or changes anything.
 *
 * Hand-kept, like the list it joins: a tier never grants on its own. `always-on-reads.test.ts`
 * pins that each name is still `observe` with no area, and that no always-on read is left off.
 *
 * @module services/runtimes/claude-code/tool-gate/always-on-reads
 */

/** The always-on reads, by bare tool name. */
export const ALWAYS_ON_READS = [
  'ping',
  'get_server_info',
  'get_session_count',
  'get_extension_api',
  'list_extensions',
  'get_extension_errors',
] as const;
