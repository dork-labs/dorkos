/**
 * `marketplace_uninstall` MCP tool — gates a package uninstall behind explicit
 * user approval and then runs the rollback-safe `UninstallFlow`.
 *
 * The handler mirrors the confirmation pattern used by `marketplace_install`:
 *
 * 1. If the caller passes a `confirmationToken`, resolve it via the injected
 *    {@link ConfirmationProvider}. Otherwise request a fresh confirmation.
 * 2. On `pending`, return `requires_confirmation` with the token so an
 *    external MCP client can re-call the tool after the user approves
 *    out-of-band.
 * 3. On `declined`, return `declined` with the user's reason.
 * 4. On `approved`, invoke `UninstallFlow.uninstall()` and report the result.
 *
 * `PackageNotInstalledError` is mapped to a structured `NOT_INSTALLED` error
 * code so MCP clients can disambiguate "no such package" from a real failure.
 *
 * @module services/marketplace-mcp/tool-uninstall
 */
import { z } from 'zod';

import { PackageNotInstalledError, type UninstallResult } from '../marketplace/flows/uninstall.js';

import type { MarketplaceMcpDeps } from './marketplace-mcp-tools.js';

/**
 * Zod input schema for `marketplace_uninstall`. Exported as a property bag
 * (not a `z.object`) to match the `server.tool(name, description, schema, handler)`
 * shape used by `@modelcontextprotocol/sdk`.
 */
export const UninstallInputSchema = {
  name: z.string().describe('Package name to uninstall'),
  purge: z
    .boolean()
    .optional()
    .describe('Also remove .dork/data/ and .dork/secrets.json (default false)'),
  projectPath: z.string().optional().describe('Project-local uninstall path (defaults to global)'),
  confirmationToken: z
    .string()
    .optional()
    .describe(
      'Token returned from a previous call where status was requires_confirmation. ' +
        'Re-call with this token after the user has approved out-of-band.'
    ),
};

/** Argument shape derived from {@link UninstallInputSchema}. */
export interface UninstallToolArgs {
  name: string;
  purge?: boolean;
  projectPath?: string;
  confirmationToken?: string;
}

/**
 * Wrap a JSON-serializable payload in the MCP `text` content block shape used
 * by every handler in this directory. Sets `isError: true` when the caller
 * marks the response as a failure so MCP clients can distinguish errors from
 * successful payloads.
 */
function jsonContent(data: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    ...(isError && { isError: true }),
  };
}

/**
 * Wrap an error in the MCP `text` content block shape with a structured
 * `code` field so external clients can branch on the failure mode without
 * regex-matching error strings. Optional `extras` are merged into the payload
 * for error-class-specific metadata (parallels the install handler's
 * `errorContent(err, code, extras)` shape).
 */
function errorContent(err: unknown, code: string, extras: Record<string, unknown> = {}) {
  return jsonContent(
    {
      error: err instanceof Error ? err.message : String(err),
      code,
      ...extras,
    },
    true
  );
}

/**
 * Build the `marketplace_uninstall` tool handler bound to the supplied
 * dependency bundle. The returned function is the MCP tool callback that
 * `marketplace-mcp-tools.ts` registers via `server.tool(...)` in task #14.
 *
 * @param deps - Marketplace MCP dependency bundle (provides
 *   `confirmationProvider` and `uninstallFlow`).
 * @returns An MCP tool handler accepting {@link UninstallToolArgs}.
 */
export function createUninstallHandler(deps: MarketplaceMcpDeps) {
  return async (args: UninstallToolArgs) => {
    // 1. Resolve confirmation. A supplied token comes from a previous
    //    `requires_confirmation` response — never issue a fresh request when
    //    the agent is resuming an out-of-band flow.
    const confirmation = args.confirmationToken
      ? await deps.confirmationProvider.resolveToken(args.confirmationToken)
      : await deps.confirmationProvider.requestInstallConfirmation({
          packageName: args.name,
          marketplace: 'installed',
          operation: 'uninstall',
        });

    if (confirmation.status === 'pending') {
      return jsonContent({
        status: 'requires_confirmation',
        confirmationToken: confirmation.token,
        message:
          'User must confirm uninstall before proceeding. Re-call this tool with the confirmationToken once the user has approved.',
      });
    }
    if (confirmation.status === 'declined') {
      return jsonContent({
        status: 'declined',
        reason: confirmation.reason ?? 'User declined uninstall',
      });
    }

    // 2. Approved — run the rollback-safe uninstall flow.
    try {
      const result: UninstallResult = await deps.uninstallFlow.uninstall({
        name: args.name,
        purge: args.purge ?? false,
        projectPath: args.projectPath,
      });
      // `UninstallResult` does not carry a `type` field today — the spec
      // text references `result.type` aspirationally. Omit the field from
      // the response rather than fabricating a value: external clients that
      // need the type can call `marketplace_get` after the uninstall and we
      // avoid lying about agent packages by labeling them `plugin`.
      return jsonContent({
        status: 'uninstalled',
        package: {
          name: result.packageName,
        },
        removedFiles: result.removedFiles,
        purgedPaths: [],
        preservedPaths: result.preservedData ?? [],
      });
    } catch (err) {
      if (err instanceof PackageNotInstalledError) {
        return errorContent(err, 'NOT_INSTALLED');
      }
      return errorContent(err, 'UNINSTALL_FAILED');
    }
  };
}
