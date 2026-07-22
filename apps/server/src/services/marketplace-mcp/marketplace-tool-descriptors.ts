/**
 * Transport-neutral descriptor table for the marketplace MCP tools.
 *
 * This is the single, shared source of truth for the marketplace tool surface:
 * each descriptor pairs a tool's identity (name, description, annotations,
 * input schema) with its dependency-injected handler factory. Both MCP servers
 * consume this one table:
 *
 * - the external `/mcp` server (`registerMarketplaceTools`, built on
 *   `@modelcontextprotocol/sdk`'s `McpServer`), and
 * - the in-session `dorkos` server (`getMarketplaceTools`, built on the Claude
 *   Agent SDK's `createSdkMcpServer`/`tool()` helper).
 *
 * The handlers themselves already live in their own sibling files
 * (`tool-search.ts`, `tool-install.ts`, …) and are transport-neutral — they
 * take plain args and return an MCP text-content result, importing neither MCP
 * SDK. This module deliberately imports neither SDK either: the two servers own
 * the SDK-specific registration glue, and share everything else from here so
 * the tool catalog stays defined in exactly one place.
 *
 * @module services/marketplace-mcp/marketplace-tool-descriptors
 */
import type { z, ZodRawShape } from 'zod';

import { ToolAnnotationPresets } from '../core/mcp-tool-metadata.js';

import type { MarketplaceMcpDeps } from './marketplace-mcp-tools.js';
import { createSearchHandler, SearchInputSchema } from './tool-search.js';
import { createGetHandler, GetInputSchema } from './tool-get.js';
import { createListMarketplacesHandler } from './tool-list-marketplaces.js';
import { createListInstalledHandler, ListInstalledInputSchema } from './tool-list-installed.js';
import { createRecommendHandler, RecommendInputSchema } from './tool-recommend.js';
import { createInstallHandler, InstallInputSchema } from './tool-install.js';
import { createUninstallHandler, UninstallInputSchema } from './tool-uninstall.js';
import { createCreatePackageHandler, CreatePackageInputSchema } from './tool-create-package.js';

const A = ToolAnnotationPresets;

/**
 * The MCP text-content result shape every marketplace handler returns. A
 * locally-defined structural type (not the MCP SDK's `CallToolResult`) so this
 * shared layer stays SDK-free; both servers' handler slots accept it because
 * their `CallToolResult` is a strict superset of this shape.
 */
export type MarketplaceToolResult = {
  /** One or more text blocks carrying the JSON-encoded tool payload. */
  content: { type: 'text'; text: string }[];
  /** Set on failure paths so MCP clients can distinguish errors from payloads. */
  isError?: boolean;
};

/**
 * One of the four-hint annotation presets declared in
 * {@link ToolAnnotationPresets}. Carried on each descriptor for the external
 * server (which advertises read/write/destructive/open-world hints); the
 * in-session SDK `tool()` helper has no annotations slot and ignores it.
 */
export type MarketplaceToolAnnotations =
  (typeof ToolAnnotationPresets)[keyof typeof ToolAnnotationPresets];

/**
 * A single marketplace tool, described independently of any MCP SDK. Schema
 * and handler-arg types are erased to the array-element boundary via
 * {@link defineMarketplaceTool}, which type-checks the pairing before erasing.
 */
export interface MarketplaceToolDescriptor {
  /** Registered tool name, e.g. `marketplace_search`. */
  name: string;
  /** Human-facing tool description shown to the model. */
  description: string;
  /** Read/write/destructive/open-world hints for the external server. */
  annotations: MarketplaceToolAnnotations;
  /** Zod field-map input schema (empty object for argument-less tools). */
  inputSchema: ZodRawShape;
  /** Build the dependency-bound handler for this tool. */
  createHandler: (
    deps: MarketplaceMcpDeps
  ) => (args: Record<string, unknown>) => Promise<MarketplaceToolResult>;
}

/**
 * Build a descriptor, type-checking that the handler's argument type matches
 * the declared input schema before erasing both to the shared
 * {@link MarketplaceToolDescriptor} element type. The single `unknown` cast is
 * confined here so every call site stays fully type-checked.
 *
 * @template Schema - The tool's Zod field-map input schema.
 * @param spec - The tool's identity, schema, and handler factory.
 * @returns The type-erased descriptor for the shared table.
 */
function defineMarketplaceTool<Schema extends ZodRawShape>(spec: {
  name: string;
  description: string;
  annotations: MarketplaceToolAnnotations;
  inputSchema: Schema;
  createHandler: (
    deps: MarketplaceMcpDeps
  ) => (args: z.infer<z.ZodObject<Schema>>) => Promise<MarketplaceToolResult>;
}): MarketplaceToolDescriptor {
  return spec as unknown as MarketplaceToolDescriptor;
}

/**
 * The shared marketplace tool catalog. Order is the registration order on both
 * servers: read-only lookups first, then the confirmation-gated mutations.
 *
 * Read-only tools (search, get, list_marketplaces, list_installed, recommend)
 * never mutate disk and require no confirmation. Mutation tools (install,
 * uninstall, create_package) always route through the
 * {@link MarketplaceMcpDeps.confirmationProvider} before any side effect — the
 * install/create-package confirmation-token trust boundary is preserved
 * unchanged regardless of which server invokes the handler.
 */
export const MARKETPLACE_TOOL_DESCRIPTORS: readonly MarketplaceToolDescriptor[] = [
  // ── Read-only tools ─────────────────────────────────────────────────────
  defineMarketplaceTool({
    name: 'marketplace_search',
    description:
      'Search the DorkOS marketplace for installable packages (agents, plugins, skill packs, adapters). ' +
      'Returns matching entries from every enabled marketplace source. ' +
      'Filters: type (agent/plugin/skill-pack/adapter), category, tags, marketplace, query (free-text).',
    annotations: A.readOnlyOpenWorld,
    inputSchema: SearchInputSchema,
    createHandler: createSearchHandler,
  }),
  defineMarketplaceTool({
    name: 'marketplace_get',
    description:
      'Get full details for a marketplace package by name. Returns the package manifest, README, marketplace metadata, and any DorkOS-specific fields (type, category, tags).',
    annotations: A.readOnlyOpenWorld,
    inputSchema: GetInputSchema,
    createHandler: createGetHandler,
  }),
  defineMarketplaceTool({
    name: 'marketplace_list_marketplaces',
    description:
      'List configured marketplace sources. Each source includes name, source URL/path, enabled flag, and total package count.',
    annotations: A.readOnlyLocal,
    inputSchema: {},
    createHandler: createListMarketplacesHandler,
  }),
  defineMarketplaceTool({
    name: 'marketplace_list_installed',
    description:
      'List packages currently installed in this DorkOS instance, one entry per installation across scopes. ' +
      'A package installed globally and on two agents returns three entries, each tagged with scope ' +
      '(global | agent-local | override) and, for agent installs, the owning agent id and name. ' +
      'Filter by type (agent/plugin/skill-pack/adapter). Includes install path, version, and provenance.',
    annotations: A.readOnlyLocal,
    inputSchema: ListInstalledInputSchema,
    createHandler: createListInstalledHandler,
  }),
  defineMarketplaceTool({
    name: 'marketplace_recommend',
    description:
      'Recommend marketplace packages based on a context description (e.g., "I need to track errors in my Next.js app"). Uses keyword + tag matching. Returns top matches with relevance scores and reasons.',
    annotations: A.readOnlyOpenWorld,
    inputSchema: RecommendInputSchema,
    createHandler: createRecommendHandler,
  }),

  // ── Mutation tools (gated by confirmation provider) ─────────────────────
  defineMarketplaceTool({
    name: 'marketplace_install',
    description:
      'Install a package from a configured marketplace. Requires user confirmation. ' +
      'For external AI agents: the first call returns status:requires_confirmation with a token. ' +
      'After the user approves in DorkOS, re-call with confirmationToken to complete the install.',
    // Fetches the package from its configured (possibly remote) marketplace source.
    annotations: A.mutateCreateOpenWorld,
    inputSchema: InstallInputSchema,
    createHandler: createInstallHandler,
  }),
  defineMarketplaceTool({
    name: 'marketplace_uninstall',
    description:
      'Uninstall a previously installed marketplace package. Requires user confirmation. ' +
      'By default, preserves .dork/data/ and .dork/secrets.json. Pass purge:true to remove them.',
    annotations: A.mutateDeleteLocal,
    inputSchema: UninstallInputSchema,
    createHandler: createUninstallHandler,
  }),
  defineMarketplaceTool({
    name: 'marketplace_create_package',
    description:
      "Scaffold a new package in the user's personal marketplace. Creates files on disk under " +
      '~/.dork/personal-marketplace/packages/<name>/ and registers the package in personal marketplace.json. ' +
      'Requires user confirmation. Publishing to a public marketplace is a separate step.',
    annotations: A.mutateCreateLocal,
    inputSchema: CreatePackageInputSchema,
    createHandler: createCreatePackageHandler,
  }),
];
