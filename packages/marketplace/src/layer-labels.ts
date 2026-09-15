/**
 * Human-readable labels for DorkOS package layers.
 *
 * Maps each layer value from the `DorkosEntry.layers` schema to a short
 * description suitable for permission previews and browse UI.
 *
 * Browser-safe — no dependencies.
 *
 * @module @dorkos/marketplace/layer-labels
 */

/** Maps each layer enum value to a human-readable label. */
export const LAYER_LABELS: Readonly<Record<string, string>> = {
  skills: 'Adds skill files',
  tasks: 'Schedules background tasks',
  commands: 'Adds slash commands',
  hooks: 'Installs lifecycle hooks',
  extensions: 'Installs UI extensions',
  // The KEY is the layer name a package author writes in their own manifest,
  // which ADR 260804-021140 keeps; the label a person reads is Connections
  // language, because that is the page this lands them on.
  //
  // Not "messaging": this layer is BOTH regions of that page. `scaffolder.ts`
  // gives every `type: 'adapter'` package `layers: ['adapters']`, and an adapter
  // whose `adapterType` is `connector` (`CONNECTOR_ADAPTER_TYPE`) is an Accounts
  // backend, not a Telegram or Slack hookup — `connector-composio` would have
  // read "messaging". The umbrella is the honest word for a layer that carries
  // both. Plural on purpose: "connection" on its own is retired copy (DOR-855),
  // "Connections" is the domain.
  adapters: 'Adds connections',
  'mcp-servers': 'Adds MCP servers',
  'lsp-servers': 'Adds LSP servers',
  agents: 'Adds agent definitions',
};
