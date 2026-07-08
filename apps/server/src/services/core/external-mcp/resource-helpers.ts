/**
 * Shared helpers for the external MCP server's `dorkos://` resources
 * (`session-resources.ts`, `agent-resources.ts`, `skill-resources.ts`).
 *
 * @module services/core/external-mcp/resource-helpers
 */
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Wrap `data` as the single `application/json` text content block every
 * `dorkos://` resource returns from its read callback.
 *
 * @param uri - The resource URI being read (echoed back per the MCP spec)
 * @param data - JSON-serializable payload, typically already validated
 *   against a Zod schema by the caller
 */
export function jsonResourceContents(uri: string, data: unknown): ReadResourceResult {
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

/**
 * Resolve a URI-template variable to a single string. The SDK types every
 * matched variable as `string | string[]` (exploded templates can repeat),
 * but the `dorkos://` templates all use single-valued variables — this
 * collapses the union for them.
 *
 * @param value - The matched template variable from the SDK
 */
export function firstVar(value: string | string[]): string {
  return Array.isArray(value) ? value[0]! : value;
}

/**
 * Throw the MCP-standard "resource not found" error. Resource read callbacks
 * (unlike tool handlers) cannot encode failure in-band via `isError` — the
 * `ReadResourceResult` shape has no such field — so a missing resource must
 * be signaled by throwing, which the SDK converts into a proper JSON-RPC
 * error response.
 *
 * @param message - Human-readable detail, e.g. `Session not found: <id>`
 */
export function resourceNotFound(message: string): never {
  throw new McpError(ErrorCode.InvalidParams, message);
}

/**
 * Throw the MCP-standard "internal error" for a resource whose backing
 * service dependency was not injected (e.g. Mesh failed to initialize).
 * Distinct from {@link resourceNotFound}: this signals a server-side
 * misconfiguration, not a caller-supplied id that doesn't exist.
 *
 * @param message - Human-readable detail naming the missing dependency
 */
export function resourceUnavailable(message: string): never {
  throw new McpError(ErrorCode.InternalError, message);
}
