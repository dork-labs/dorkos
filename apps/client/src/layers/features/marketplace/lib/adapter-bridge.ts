import { CONNECTOR_ADAPTER_TYPE } from '@dorkos/marketplace';
import type { MarketplacePackageType } from '@dorkos/shared/marketplace-schemas';

/** The plain-language line that says what an installed adapter adds to Connections. */
export interface AdapterBridge {
  /** One sentence connecting this adapter to what the user sees on the Connections page. */
  line: string;
}

/**
 * Bridge an adapter package's marketplace vocabulary ("adapter", "connector")
 * to the user-facing Connections vocabulary.
 *
 * The marketplace keeps its author-domain type names (ADR 260804-021140), so a
 * card and its install toast carry an explicit line instead:
 * a messaging adapter (Telegram, Slack, webhook) adds a way to *reach* your
 * agents, and a connector-refinement adapter (`adapterType === 'connector'`)
 * adds a *service your agents act on*. Returns `null` for every non-adapter
 * package, which carries no such bridge.
 *
 * @param type - The package type (`undefined` defaults to non-adapter).
 * @param adapterType - The adapter's type identifier, when the package is an adapter.
 * @returns The bridge line, or `null` for non-adapters.
 */
export function adapterBridge(
  type: MarketplacePackageType | undefined,
  adapterType: string | undefined
): AdapterBridge | null {
  if (type !== 'adapter') return null;
  if (adapterType === CONNECTOR_ADAPTER_TYPE) {
    return { line: 'Adds a new service your agents can act on' };
  }
  return { line: 'Adds a new way to reach your agents' };
}
