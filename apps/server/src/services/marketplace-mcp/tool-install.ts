/**
 * `marketplace_install` MCP tool — gates a package install behind explicit
 * user approval, then runs the rollback-safe `MarketplaceInstaller` pipeline.
 *
 * The handler is the highest-stakes tool in the marketplace surface — it
 * writes files to disk on behalf of an external AI agent — so the
 * confirmation gate is unconditional. The flow is:
 *
 * 1. Build `installer.preview()` FIRST. This catches resolve/fetch/validation
 *    errors before any disk mutation and gives the confirmation provider a
 *    full {@link PermissionPreview} to render to the user.
 * 2. If the caller passes a `confirmationToken`, resolve it via the injected
 *    {@link ConfirmationProvider}. Otherwise issue a fresh confirmation
 *    request, attaching the preview so external clients can render it
 *    out-of-band.
 * 3. On `pending`, return `requires_confirmation` with the token AND the
 *    preview so the agent can show the user exactly what they are approving.
 * 4. On `declined`, return `declined` with the user's reason.
 * 5. On `approved`, invoke `installer.install()` and report the result.
 *
 * `ConflictError` and `InvalidPackageError` are mapped to structured error
 * codes (`CONFLICT`, `INVALID_PACKAGE`) so MCP clients can branch on the
 * failure mode without regex-matching error strings. Any other failure is
 * mapped to `INSTALL_FAILED`.
 *
 * @module services/marketplace-mcp/tool-install
 */
import { z } from 'zod';

import {
  ConflictError,
  InvalidPackageError,
  type PreviewResult,
} from '../marketplace/marketplace-installer.js';
import type { InstallResult } from '../marketplace/types.js';

import type { ConfirmationResult } from './confirmation-provider.js';
import type { MarketplaceMcpDeps } from './marketplace-mcp-tools.js';

/**
 * Zod input schema for `marketplace_install`. Exported as a property bag (not
 * a `z.object`) to match the `server.tool(name, description, schema, handler)`
 * shape used by `@modelcontextprotocol/sdk`.
 */
export const InstallInputSchema = {
  name: z.string().describe('Package name to install'),
  marketplace: z
    .string()
    .optional()
    .describe('Specific marketplace to install from (defaults to first match across enabled)'),
  projectPath: z.string().optional().describe('Project-local install path (defaults to global)'),
  confirmationToken: z
    .string()
    .optional()
    .describe(
      'Token returned from a previous call where status was requires_confirmation. ' +
        'Re-call with this token after the user has approved out-of-band.'
    ),
};

/** Argument shape derived from {@link InstallInputSchema}. */
export interface InstallToolArgs {
  name: string;
  marketplace?: string;
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
 * for error-class-specific metadata (e.g., `conflicts` or `errors` lists).
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
 * Resolve the user's confirmation. If the caller passed a token they are
 * resuming an out-of-band approval flow — never issue a fresh request in
 * that case. Otherwise issue a new request with the preview attached so the
 * provider can render the full set of effects to the user.
 *
 * @internal
 */
async function resolveConfirmation(
  deps: MarketplaceMcpDeps,
  args: InstallToolArgs,
  preview: PreviewResult
): Promise<ConfirmationResult> {
  if (args.confirmationToken) {
    return deps.confirmationProvider.resolveToken(args.confirmationToken);
  }
  return deps.confirmationProvider.requestInstallConfirmation({
    packageName: args.name,
    marketplace: args.marketplace ?? 'dorkos-community',
    operation: 'install',
    preview: preview.preview,
  });
}

/**
 * Build the `marketplace_install` tool handler bound to the supplied
 * dependency bundle. The returned function is the MCP tool callback that
 * `marketplace-mcp-tools.ts` registers via `server.tool(...)` in task #14.
 *
 * @param deps - Marketplace MCP dependency bundle (provides `installer` and
 *   `confirmationProvider`).
 * @returns An MCP tool handler accepting {@link InstallToolArgs}.
 */
export function createInstallHandler(deps: MarketplaceMcpDeps) {
  return async (args: InstallToolArgs) => {
    // 1. Build the preview FIRST so resolve/fetch/validation errors short-
    //    circuit before any user prompt or disk mutation. The preview is
    //    also what the confirmation provider hands to the UI so the user
    //    can see every effect before approving.
    let preview: PreviewResult;
    try {
      preview = await deps.installer.preview({
        name: args.name,
        marketplace: args.marketplace,
        projectPath: args.projectPath,
      });
    } catch (err) {
      return errorContent(err, 'INSTALL_FAILED');
    }

    // 2. Resolve confirmation. A supplied token comes from a previous
    //    `requires_confirmation` response — never issue a fresh request when
    //    the agent is resuming an out-of-band flow.
    const confirmation = await resolveConfirmation(deps, args, preview);

    if (confirmation.status === 'pending') {
      return jsonContent({
        status: 'requires_confirmation',
        preview: preview.preview,
        confirmationToken: confirmation.token,
        message:
          'User must confirm install before proceeding. Re-call this tool with the confirmationToken once the user has approved.',
      });
    }
    if (confirmation.status === 'declined') {
      return jsonContent({
        status: 'declined',
        reason: confirmation.reason ?? 'User declined installation',
      });
    }

    // 3. Approved — run the rollback-safe install pipeline.
    try {
      const result: InstallResult = await deps.installer.install({
        name: args.name,
        marketplace: args.marketplace,
        projectPath: args.projectPath,
      });
      return jsonContent({
        status: 'installed',
        package: {
          name: result.packageName,
          version: result.version,
          type: result.type,
        },
        installPath: result.installPath,
        warnings: result.warnings,
      });
    } catch (err) {
      if (err instanceof ConflictError) {
        return errorContent(err, 'CONFLICT', { conflicts: err.conflicts });
      }
      if (err instanceof InvalidPackageError) {
        return errorContent(err, 'INVALID_PACKAGE', { errors: err.errors });
      }
      return errorContent(err, 'INSTALL_FAILED');
    }
  };
}
