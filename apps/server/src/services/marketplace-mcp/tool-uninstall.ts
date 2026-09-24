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
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { PackageNameSchema } from '@dorkos/marketplace';

import { PackageNotInstalledError, type UninstallResult } from '../marketplace/flows/uninstall.js';
import { BoundaryError, validateBoundary } from '../../lib/boundary.js';
import { locateInstallRoot } from '../marketplace/lib/locate-install.js';

import type { MarketplaceMcpDeps } from './marketplace-mcp-tools.js';
import type { MarketplaceConfirmationContext } from './confirmation-provider.js';

/**
 * Zod input schema for `marketplace_uninstall`. Exported as a property bag
 * (not a `z.object`) to match the `server.tool(name, description, schema, handler)`
 * shape used by `@modelcontextprotocol/sdk`.
 */
export const UninstallInputSchema = {
  // The canonical package-name schema, not a bare string: this name is joined
  // straight into `dorkHome` by the uninstall flow, and an installed package's
  // directory is always its (schema-validated) manifest name, so nothing looser
  // could ever name a real install.
  name: PackageNameSchema.describe('Package name to uninstall'),
  purge: z
    .boolean()
    .optional()
    .describe('Also remove the files you and your agents added or changed (default false)'),
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
 * @returns An MCP tool handler accepting {@link UninstallToolArgs} and an
 *   optional caller context.
 */
export function createUninstallHandler(deps: MarketplaceMcpDeps) {
  return async (args: UninstallToolArgs, context?: MarketplaceConfirmationContext) => {
    // 0. Path safety, BEFORE the confirmation. Both checks refuse arguments no
    //    approval could make safe, so asking a person about them would be a
    //    card for an action that is not going to happen either way. The name is
    //    already pinned by `UninstallInputSchema`, and the flow checks it again
    //    — this is the middle layer, and the only one that runs when a handler
    //    is called directly. `projectPath` has no other check on this path at
    //    all: the HTTP route confines it and, until now, the tool did not.
    if (!PackageNameSchema.safeParse(args.name).success) {
      return errorContent(new Error(`Invalid package name: ${args.name}`), 'INVALID_NAME');
    }
    //    Confining `projectPath` returns its canonical path, which is what the
    //    uninstall flow receives, as with the HTTP route's `confineProjectPath`.
    //    The confirmation below keeps `args.projectPath`, because an approval
    //    binds to the arguments as the caller sent them, and so does the
    //    post-change notification, because its listeners key on the path the way
    //    the person spelled it (DOR-711).
    let projectPath: string | undefined;
    if (args.projectPath !== undefined) {
      try {
        projectPath = await validateBoundary(args.projectPath);
      } catch (err) {
        if (err instanceof BoundaryError) {
          return errorContent(
            new Error('Access denied: projectPath outside directory boundary'),
            'OUTSIDE_BOUNDARY'
          );
        }
        throw err;
      }
    }

    // 1. Resolve confirmation. A supplied token comes from a previous
    //    `requires_confirmation` response — never issue a fresh request when
    //    the agent is resuming an out-of-band flow.
    // Every value that reaches `uninstallFlow.uninstall()` below rides in the
    // confirmation request, so the approval is bound to this exact effect —
    // notably `purge`, the difference between a reversible uninstall and one
    // that deletes the package's saved data and secrets.
    // The card has to say what removing an AGENT package takes away (DOR-2245),
    // so the request names the installed package's type when it can.
    const installedType = await installedPackageType(deps.dorkHome, args.name, projectPath);
    const confirmationRequest = {
      packageName: args.name,
      marketplace: 'installed',
      operation: 'uninstall' as const,
      purge: args.purge ?? false,
      ...(installedType === 'agent' && { packageType: 'agent' }),
      ...(args.projectPath !== undefined && { projectPath: args.projectPath }),
      ...(context?.requestedBy ? { requestedBy: context.requestedBy } : {}),
    };
    // `uninstall` is a destructive capability, so the tier gate in front of this
    // handler may already have spent an approval a person granted for these exact
    // arguments. Asking again would put a second card in front of them for one
    // action (spec `agent-trust` §3.2).
    const confirmation = context?.preApproved
      ? ({ status: 'approved' } as const)
      : args.confirmationToken
        ? await deps.confirmationProvider.resolveToken(args.confirmationToken, confirmationRequest)
        : await deps.confirmationProvider.requestInstallConfirmation(confirmationRequest);

    if (confirmation.status === 'pending') {
      return jsonContent({
        status: 'requires_confirmation',
        confirmationToken: confirmation.token,
        // A `reason` means this card replaced an approval that no longer covered
        // the uninstall; see the same branch in `tool-install.ts`.
        message: `${confirmation.reason ? `${confirmation.reason} ` : ''}User must confirm uninstall before proceeding. Re-call this tool with the confirmationToken once the user has approved.`,
      });
    }
    if (confirmation.status === 'declined') {
      return jsonContent({
        status: 'declined',
        reason: confirmation.reason ?? 'User declined uninstall',
      });
    }

    // 2. Approved — run the rollback-safe uninstall flow.
    let result: UninstallResult;
    try {
      result = await deps.uninstallFlow.uninstall({
        name: args.name,
        purge: args.purge ?? false,
        projectPath,
      });
    } catch (err) {
      if (err instanceof PackageNotInstalledError) {
        return errorContent(err, 'NOT_INSTALLED');
      }
      return errorContent(err, 'UNINSTALL_FAILED');
    }

    // 3. Clean up after the package, exactly as the HTTP uninstall route does:
    //    refresh the runtime's plugin list and prune the package's harness
    //    projections (DOR-2057). The files are already gone, so a notifier that
    //    throws is logged and the uninstall is still reported as what it is.
    //    The RAW project path, as the HTTP route sends it (DOR-711). A removed
    //    global package's approvals go with it (DOR-2306).
    try {
      if (args.projectPath === undefined) deps.consent.removed(result.packageName);
      deps.onPluginsChanged({
        projectPath: args.projectPath,
        packageName: result.packageName,
        action: 'uninstall',
      });
    } catch (err) {
      deps.logger.warn('[marketplace_uninstall] post-uninstall notification failed', {
        packageName: result.packageName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
  };
}

/**
 * The type of the installed package an uninstall would remove, or `undefined`
 * when it is not found or its manifest cannot be read. Only used to word the
 * approval card.
 *
 * @param dorkHome - Resolved DorkOS data directory.
 * @param name - The package name.
 * @param projectPath - The project scope, when one was named.
 */
async function installedPackageType(
  dorkHome: string,
  name: string,
  projectPath: string | undefined
): Promise<string | undefined> {
  const root = await locateInstallRoot({ dorkHome, name, ...(projectPath && { projectPath }) });
  if (!root) return undefined;
  try {
    const manifest = JSON.parse(
      await readFile(path.join(root, '.dork', 'manifest.json'), 'utf-8')
    ) as { type?: unknown };
    return typeof manifest.type === 'string' ? manifest.type : undefined;
  } catch {
    return undefined;
  }
}
