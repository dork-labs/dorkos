/**
 * Registers external `/mcp` tools from the in-session tool definitions, so the
 * two servers cannot describe the same tool differently (DOR-499).
 *
 * ## The problem this removes
 *
 * DorkOS registers the same ~47 tools twice: once for the in-session `dorkos`
 * server (`runtimes/claude-code/mcp-tools/`) and once for the external `/mcp`
 * server (this directory). The handlers were already shared — the files here have
 * always imported `create*Handler` from the in-session modules. The NAME, the
 * DESCRIPTION, and the INPUT SCHEMA were not: each was typed out a second time.
 *
 * They drifted, and the drift was invisible because nothing compared them. Seven
 * tools ended up with two different descriptions, and `mesh_discover` ended up
 * with two different input schemas — the external copy omitted
 * `includeRegistered`, a field the shared handler reads, so no external caller
 * could reach that branch at all. One external description also stated the wrong
 * default for `maxDepth` (3, where the scanner uses 5).
 *
 * So the definition is now written once, next to the handler, and this module
 * projects it onto the external server. A description fixed in one place is fixed
 * on both surfaces, and a new input field is reachable from both, because there is
 * no second copy to forget.
 *
 * ## What stays here, and why it is not drift
 *
 * Two things are genuinely external-only and remain declared in this directory,
 * keyed by tool name:
 *
 * - `annotations` — the MCP `ToolAnnotations` hints (`readOnlyHint` and friends).
 *   The in-session SDK server has no annotations slot to put them in.
 * - `outputSchema` — declared by the handful of tools whose result has an exact
 *   Zod schema. Only the external server advertises it.
 *
 * Those tables also decide WHICH tools reach the external server: a definition
 * with no entry is in-session-only, which is how `binding_list_sessions`,
 * `relay_notify_user`, `control_ui`, `get_ui_state`, and the three `browser_*`
 * tools stay off `/mcp`. That is now a stated fact with a name attached rather
 * than the silent consequence of one file having fewer paragraphs than another.
 *
 * @module services/core/external-mcp/register-from-definitions
 */
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { AnySchema, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { ToolRegistrar, SdkMcpTool } from '../mcp-tool-gate.js';
import type { McpToolName } from '../mcp-tool-tiers.js';

/**
 * The external-only additions for one tool.
 *
 * Presence in an {@link ExternalToolConfigs} map is what puts a tool on the
 * external server at all.
 */
interface ExternalToolConfig {
  /** The MCP read/write hints for this tool. Pick a preset from `mcp-tool-metadata.ts`. */
  annotations: ToolAnnotations;
  /**
   * The result schema, for the few tools whose handler returns
   * `structuredContent` matching an exact Zod schema. Omit otherwise.
   *
   * Accepts either a field map or a whole schema object, matching what the MCP
   * SDK's `registerTool` takes — the existing tools use both spellings.
   */
  outputSchema?: ZodRawShapeCompat | AnySchema;
}

/**
 * The external additions for one domain's tools, keyed by tool name.
 *
 * Keys are typed as {@link McpToolName}, so a typo or a stale name is a
 * compile error rather than a tool that quietly stops being registered.
 */
export type ExternalToolConfigs = Partial<Record<McpToolName, ExternalToolConfig>>;

/**
 * Register the external half of one domain from its in-session definitions.
 *
 * Every definition whose name has an entry in `configs` is registered on the
 * gated registrar with that definition's description and input schema, plus the
 * external annotations and output schema. Definitions with no entry are skipped:
 * they are in-session-only.
 *
 * Throws when `configs` names a tool the definitions do not contain. That is the
 * drift guard for this seam: renaming a tool in the in-session module, or dropping
 * one, would otherwise silently remove it from `/mcp` and nothing would say so.
 * The check runs when the server is BUILT, so it fails on the first request rather
 * than at some later call.
 *
 * @param registrar - The gated registrar from `mcp-server.ts`, which runs each
 *   tool's permission tier before its handler.
 * @param definitions - The in-session tool definitions for this domain.
 * @param configs - The external-only additions, keyed by tool name.
 * @throws If `configs` names a tool absent from `definitions`.
 */
export function registerFromDefinitions(
  registrar: ToolRegistrar,
  definitions: readonly SdkMcpTool[],
  configs: ExternalToolConfigs
): void {
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));

  const unmatched = Object.keys(configs).filter((name) => !byName.has(name));
  if (unmatched.length > 0) {
    throw new Error(
      `External MCP config names ${unmatched.length} tool(s) that no in-session definition ` +
        `provides: ${unmatched.join(', ')}. Either the tool was renamed or removed in ` +
        `services/runtimes/claude-code/mcp-tools/, or this name is a typo. Without this check ` +
        `the tool would simply stop being registered on /mcp and nothing would report it.`
    );
  }

  for (const definition of definitions) {
    const config = configs[definition.name as McpToolName];
    if (!config) continue;
    registrar.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: definition.inputSchema,
        annotations: config.annotations,
        ...(config.outputSchema ? { outputSchema: config.outputSchema } : {}),
      },
      definition.handler as never
    );
  }
}
