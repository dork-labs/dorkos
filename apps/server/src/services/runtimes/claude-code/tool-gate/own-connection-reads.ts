/**
 * The two connector reads an agent uses to find its OWN access: which connected accounts it was
 * granted, and which operations each grant covers (DOR-3205).
 *
 * They join `DORKOS_AGENT_TOOLS` (`auto-allow.ts`) so a scheduled run, with nobody there to answer
 * a card, can still list its own access before it acts. Before, at `acceptEdits` or `default` it
 * was refused for want of a person, and at Never ask Claude Code refused it before DorkOS was
 * asked, so a run could not even find out which account to use.
 *
 * Why these two may skip the card: each reads only the calling agent's own grants. The principal is
 * the turn's, minted by the server; the input schemas are strict, so no owner, agent or provider
 * selector reaches them (`connectors/execution/execution-capabilities.ts`). What they return is
 * account labels and operation names the owner already granted this agent, never the accounts'
 * own content. The execute tools are NOT here and never join: those act on the accounts, and keep
 * their own gate.
 *
 * Who still cannot run them unasked:
 * - a turn that carries an outsider's words: a stranger's own, one our agents passed those words
 *   on to (`autoAllowedByCall`), or, at Never ask, one marked by a line it read
 *   (`never-ask-hook.ts`). An outsider's question must not read out which accounts the owner
 *   connected;
 * - a teammate's turn: its fence refuses both (`core/turn-power/teammate-tier.ts`).
 *
 * A turn another of our own agents started, held to its ceiling, does run them: the grants are
 * this agent's, and the colleague asking is on the same DorkOS.
 *
 * Both spellings are listed, each exactly. The capability id has a dot
 * (`connectors.list_granted_connections`); Claude Code turns characters an MCP tool name may not
 * carry into `_` when it names the tool to the model, so the gate can see either.
 *
 * @module services/runtimes/claude-code/tool-gate/own-connection-reads
 */
import { inSessionToolName } from '../mcp-tools/tool-exposure.js';

/** The two capability ids, as the connector tools are registered. */
export const OWN_CONNECTION_READ_IDS = [
  'connectors.list_granted_connections',
  'connectors.list_granted_operations',
] as const;

/** Each id by both names it can reach the gate under, bare. */
export const OWN_CONNECTION_READS: readonly string[] = OWN_CONNECTION_READ_IDS.flatMap((id) => [
  id,
  id.replace('.', '_'),
]);

/** The same reads by their in-session names, which a stranger's turn asks about. */
export const OWN_CONNECTION_READS_QUALIFIED: ReadonlySet<string> = new Set(
  OWN_CONNECTION_READS.map(inSessionToolName)
);
