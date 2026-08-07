import type { ManagedMcpServerView } from '@dorkos/shared/mesh-schemas';
import type { McpServerEntry } from '@dorkos/shared/transport';
import { MCP_ORDER_BANDS, orderBandFor, resolveStatusKey, usesOwnKey } from './mcp-server-state';

/** One card in the panel, in the order the panel will hold it. */
interface McpCardOrderEntry {
  /** The server's name — the identity the frozen order is keyed by. */
  name: string;
  /** Which band it sorted into when the panel opened. */
  band: number;
}

/**
 * The order the cards take when the panel opens: what needs you, then what is
 * working, then what came from elsewhere, then what is off.
 *
 * Computed from the caches alone — no sign-in flow can be in progress at mount,
 * so the parent knows every card's state as exactly as the card itself does.
 * Within a band the input order is kept, so two servers that both need you stay
 * in the order the manifest lists them.
 *
 * @param args.managed - The agent's managed servers.
 * @param args.live - The runtime's roster entries, keyed by name.
 * @param args.discovered - Roster entries with no managed match.
 */
export function initialCardOrder(args: {
  managed: readonly ManagedMcpServerView[];
  live: ReadonlyMap<string, McpServerEntry>;
  discovered: readonly McpServerEntry[];
}): string[] {
  const { managed, live, discovered } = args;
  const entries: McpCardOrderEntry[] = [
    ...managed.map((server) => ({
      name: server.name,
      band: orderBandFor(
        resolveStatusKey({
          enabled: server.enabled,
          testedOk: false,
          signedInNow: false,
          runtimeStatus: live.get(server.name)?.status,
          runtimeError: live.get(server.name)?.error,
          authStatus: server.authStatus,
          ownKey: usesOwnKey(server.connection),
        })
      ),
    })),
    ...discovered.map((entry) => ({ name: entry.name, band: MCP_ORDER_BANDS.elsewhere })),
  ];
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.band - b.entry.band || a.index - b.index)
    .map(({ entry }) => entry.name);
}

/**
 * Replay a frozen order over the servers that exist right now, and say which
 * names were not in it.
 *
 * The freeze is the whole point (spec §2.2): a card a person is mid-sign-in on
 * must never move, so a state change updates the chip, the sentence and the
 * button IN PLACE and never the position. Names the frozen order does not know —
 * a server added while the panel is open — come back separately so the caller
 * can append them rather than let them land wherever a re-sort would put them.
 *
 * @param args.frozen - The order captured when the panel opened.
 * @param args.present - The names that exist right now, in their natural order.
 */
export function replayFrozenOrder(args: {
  frozen: readonly string[];
  present: readonly string[];
}): { ordered: string[]; added: string[] } {
  const { frozen, present } = args;
  const live = new Set(present);
  const known = new Set(frozen);
  return {
    ordered: frozen.filter((name) => live.has(name)),
    added: present.filter((name) => !known.has(name)),
  };
}
