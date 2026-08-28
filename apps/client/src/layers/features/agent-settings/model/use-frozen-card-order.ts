import { useRenderSlot } from '@/layers/shared/lib';
import type { ManagedMcpServerView } from '@dorkos/shared/mesh-schemas';
import type { McpServerEntry } from '@dorkos/shared/transport';
import { initialCardOrder, replayFrozenOrder } from '../lib/mcp-card-order';

/** Everything the frozen order needs to answer "what order are the cards in right now?". */
export interface FrozenCardOrderInput {
  /** Whether BOTH the managed roster and the runtime's roster have settled. */
  bothSettled: boolean;
  /** The agent's managed servers, in manifest order. */
  managed: readonly ManagedMcpServerView[];
  /** The runtime's roster entries, keyed by name. */
  live: ReadonlyMap<string, McpServerEntry>;
  /** Roster entries with no managed match. */
  discovered: readonly McpServerEntry[];
  /** Every card name that exists right now, in its natural order. */
  present: readonly string[];
}

/**
 * The card order for one mount of the MCP panel: sorted once, then frozen.
 *
 * The first render where BOTH queries have settled captures the order, and every
 * render after replays it. Servers that appear later are APPENDED, never
 * inserted, so nothing already on screen moves. The next mount sorts again.
 *
 * Waiting for both sources is the correctness of the sort, not politeness. They
 * land independently — the manifest is a file read, the runtime's status goes
 * through the runtime — and freezing on whichever arrived first sorted only that
 * half. Managed-first (the likely race) meant no runtime-only state could ever
 * reach the attention band: a server the runtime reports as failed was appended
 * AFTER the freeze, below every working card, which is precisely the card the
 * sort exists to lift.
 *
 * The capture lives in a {@link useRenderSlot} because it is read during the
 * same render that writes it — a card must not be drawn unsorted even for a
 * frame — which rules out both a ref and state.
 */
export function useFrozenCardOrder(): (input: FrozenCardOrderInput) => string[] {
  const frozen = useRenderSlot<string[] | null>(null);

  return ({ bothSettled, managed, live, discovered, present }) => {
    if (frozen.read() === null && bothSettled && present.length > 0) {
      frozen.write(initialCardOrder({ managed, live, discovered }));
    }
    const { ordered, added } = replayFrozenOrder({ frozen: frozen.read() ?? [], present });
    if (added.length > 0 && frozen.read() !== null) frozen.write([...ordered, ...added]);
    return [...ordered, ...added];
  };
}
