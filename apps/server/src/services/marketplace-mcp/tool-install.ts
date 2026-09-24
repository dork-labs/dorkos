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
import { shippedContentHash } from '../marketplace/lib/content-hash.js';
import { z } from 'zod';

import {
  ConflictError,
  DisclosureChangedError,
  InvalidPackageError,
  type PreviewResult,
} from '../marketplace/marketplace-installer.js';
import { disclosedEffectsOf } from '../marketplace/disclosed-effects.js';
import type { InstallResult } from '../marketplace/types.js';
import { BoundaryError, validateBoundary } from '../../lib/boundary.js';

import type {
  ConfirmationResult,
  MarketplaceConfirmationContext,
} from './confirmation-provider.js';
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
  preview: PreviewResult,
  contentHash: string,
  context?: MarketplaceConfirmationContext
): Promise<ConfirmationResult> {
  // A person already approved this exact invocation at the capability tier gate;
  // asking again would be a second card for one action.
  if (context?.preApproved) return { status: 'approved' };

  // `marketplace` and `projectPath` ride along verbatim because both reach
  // `installer.install()` after the gate. Neither is defaulted here: an absent
  // marketplace searches every enabled source (first match wins) while a named
  // one pins resolution, so substituting a default would both mis-describe the
  // card and let a retry that omits the field pass a binding built from it.
  const req = {
    packageName: args.name,
    ...(args.marketplace !== undefined && { marketplace: args.marketplace }),
    operation: 'install' as const,
    ...(args.projectPath !== undefined && { projectPath: args.projectPath }),
    preview: preview.preview,
    contentHash,
    origin: {
      version: preview.manifest.version,
      ...(args.marketplace !== undefined && { source: args.marketplace }),
    },
    ...(context?.requestedBy ? { requestedBy: context.requestedBy } : {}),
  };
  if (args.confirmationToken) {
    return deps.confirmationProvider.resolveToken(args.confirmationToken, req);
  }
  return deps.confirmationProvider.requestInstallConfirmation(req);
}

/**
 * Build the `marketplace_install` tool handler bound to the supplied
 * dependency bundle. The returned function is the MCP tool callback that
 * `marketplace-mcp-tools.ts` registers via `server.tool(...)` in task #14.
 *
 * @param deps - Marketplace MCP dependency bundle (provides `installer` and
 *   `confirmationProvider`).
 * @returns An MCP tool handler accepting {@link InstallToolArgs} and an optional
 *   caller context.
 */
export function createInstallHandler(deps: MarketplaceMcpDeps) {
  return async (args: InstallToolArgs, context?: MarketplaceConfirmationContext) => {
    // 0. Confine `projectPath` to the directory boundary, ahead of the preview.
    //    The HTTP install route has always done this; the tool passed the path
    //    straight through, so an agent could aim a project-local install at any
    //    directory on the machine. Ahead of the preview because the preview
    //    clones the package to disk and then asks a person to approve it —
    //    neither is worth doing for a request that cannot be honored.
    //
    //    The canonical path it returns is what the preview and the install
    //    receive, exactly as the HTTP route's `confineProjectPath` does, so a
    //    symlinked, relative or `..` spelling of a repo installs into the same
    //    repo an HTTP install would. Two things deliberately keep the caller's
    //    own spelling: the confirmation, because an approval binds to the
    //    arguments as the caller sent them; and the post-change notification,
    //    because its listeners key on the project path the way the person picked
    //    it, and the HTTP route sends the raw spelling too (DOR-711).
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

    // 1. Build the preview FIRST so resolve/fetch/validation errors short-
    //    circuit before any user prompt or disk mutation. The preview is
    //    also what the confirmation provider hands to the UI so the user
    //    can see every effect before approving.
    let preview: PreviewResult;
    try {
      preview = await deps.installer.preview({
        name: args.name,
        marketplace: args.marketplace,
        projectPath,
      });
    } catch (err) {
      return errorContent(err, 'INSTALL_FAILED');
    }
    // The staged files the card is about: bound into the approval, and what
    // the installed copy must hash the same as to be recorded (DOR-2306).
    let contentHash: string;
    try {
      contentHash = await shippedContentHash(preview.packagePath);
    } catch (err) {
      return errorContent(err, 'INSTALL_FAILED');
    }

    // 2. Resolve confirmation. A supplied token comes from a previous
    //    `requires_confirmation` response — never issue a fresh request when
    //    the agent is resuming an out-of-band flow.
    const confirmation = await resolveConfirmation(deps, args, preview, contentHash, context);

    if (confirmation.status === 'pending') {
      return jsonContent({
        status: 'requires_confirmation',
        preview: preview.preview,
        confirmationToken: confirmation.token,
        // A `reason` means this card REPLACED an approval that no longer covered
        // the install — a stale token, or a package whose declared commands moved
        // between the card and the retry. Leading with it is the difference
        // between "still waiting" and "what you were approved for is not what
        // this is any more".
        message: `${confirmation.reason ? `${confirmation.reason} ` : ''}User must confirm install before proceeding. Re-call this tool with the confirmationToken once the user has approved.`,
      });
    }
    if (confirmation.status === 'declined') {
      return jsonContent({
        status: 'declined',
        reason: confirmation.reason ?? 'User declined installation',
      });
    }

    // 3. Approved — run the rollback-safe install pipeline.
    let result: InstallResult;
    try {
      result = await deps.installer.install({
        name: args.name,
        marketplace: args.marketplace,
        projectPath,
        // What the approval actually covered. `install()` resolves the package a
        // second time and re-checks its own resolve against this before writing
        // anything, which closes the window between THIS preview and that one
        // (DOR-647). Passed even on the `preApproved` path: the tier gate's yes is
        // still a yes about the package as it stood when this preview was built.
        approvedDisclosure: disclosedEffectsOf(preview.preview),
      });
    } catch (err) {
      // The package that resolved for the install is not the one that was
      // approved. Its own code, not `INSTALL_FAILED`: nothing is broken, and the
      // agent's next move is to ask again rather than to retry the same call.
      if (err instanceof DisclosureChangedError) {
        return errorContent(err, 'DISCLOSURE_CHANGED', {
          approved: err.approved,
          resolved: err.resolved,
        });
      }
      if (err instanceof ConflictError) {
        return errorContent(err, 'CONFLICT', { conflicts: err.conflicts });
      }
      if (err instanceof InvalidPackageError) {
        return errorContent(err, 'INVALID_PACKAGE', { errors: err.errors });
      }
      return errorContent(err, 'INSTALL_FAILED');
    }

    // After it landed: every earlier approval of this global package is
    // forgotten, and a person's yes on the card (never `preApproved`, where
    // nobody was shown anything) is recorded when the installed copy is what
    // the card showed. Before the refresh below, which reads it (DOR-2306).
    await deps.consent.settle(
      { installPath: result.installPath, type: result.type, global: projectPath === undefined },
      context?.preApproved
        ? undefined
        : { disclosed: disclosedEffectsOf(preview.preview), contentHash }
    );

    // 4. Set the package up, exactly as the HTTP install route does: refresh the
    //    runtime's plugin list and project it to the project's harnesses
    //    (DOR-2057). The package is on disk by now, so a notifier that throws is
    //    logged and the install is still reported as what it is: installed. The
    //    RESOLVED name, never `args.name`, which may be an install identifier
    //    (DOR-264); the RAW project path, as the HTTP route sends it (DOR-711).
    try {
      deps.onPluginsChanged({
        projectPath: args.projectPath,
        packageName: result.packageName,
        action: 'install',
      });
    } catch (err) {
      deps.logger.warn('[marketplace_install] post-install notification failed', {
        packageName: result.packageName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
  };
}
