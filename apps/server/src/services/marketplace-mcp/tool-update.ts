/**
 * `marketplace_update` MCP tool — says which installed packages have a newer
 * version, and, with `apply: true` and a person's approval, reinstalls them.
 *
 * It opens the same all-packages door as `GET` / `POST /api/marketplace/updates`
 * (`services/marketplace/flows/update-installed.ts`): one scan, the same
 * `names` / `installPaths` selection, every reinstall in its installation's own
 * scope, a linked install never touched, and one `onPluginsChanged` per
 * reinstall that landed. Only the permission step is this surface's own.
 *
 * ## The permission step
 *
 * An apply puts new code on the machine — hook commands, scheduled jobs, and MCP
 * servers that start in every session a global plugin loads in — so it is gated
 * like `marketplace_install`, and bound the way an install's approval is
 * (DOR-647). The apply first checks, exactly as the advisory form does, and
 * stages every stale installation's new version
 * (`applyApprovedUpdates` in `flows/update-installed.ts`). One card then lists
 * every installation that would change: where it is, its old and new version,
 * and everything the new version would run, in full. The approval binds each
 * installation by its path together with that disclosure, so it cannot be
 * stretched over another installation or a version that runs something else.
 * The retry recomputes all of it and asks again, with the reason, if anything
 * moved; and each reinstall is then held to what was approved, so a commit that
 * lands between the yes and the install is refused for that installation before
 * anything is removed. A list too long to show in full is refused, never cut.
 *
 * The advisory form asks nobody and changes nothing installed.
 *
 * @module services/marketplace-mcp/tool-update
 */
import { z } from 'zod';

import { BoundaryError, validateBoundary } from '../../lib/boundary.js';
import { PackageNotInstalledForUpdateError } from '../marketplace/flows/update-selection.js';
import {
  applyApprovedUpdates,
  checkInstalledUpdates,
  type ApprovableUpdate,
  type InstalledUpdatesDeps,
} from '../marketplace/flows/update-installed.js';

import type {
  ConfirmationRequest,
  MarketplaceConfirmationContext,
} from './confirmation-provider.js';
import type { MarketplaceMcpDeps } from './marketplace-mcp-tools.js';

/**
 * Zod input schema for `marketplace_update`. Exported as a property bag (not a
 * `z.object`) to match the `server.tool(name, description, schema, handler)`
 * shape used by `@modelcontextprotocol/sdk`. The selector mirrors the body of
 * `POST /api/marketplace/updates`, so both surfaces refuse the same inputs.
 */
export const UpdateInputSchema = {
  names: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe('Only these packages, in every place each is installed (default: every package)'),
  installPaths: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe(
      'Only these installations, by the installPath a check reported. Use it to update one ' +
        'copy of a package installed in several places.'
    ),
  projectPath: z
    .string()
    .optional()
    .describe(
      "Look at this project's packages (and the global ones it uses) instead of every place"
    ),
  apply: z
    .boolean()
    .optional()
    .describe('Reinstall every selected package that has a newer version (default: only check)'),
  confirmationToken: z
    .string()
    .optional()
    .describe(
      'Token returned from a previous apply call where status was requires_confirmation. ' +
        'Re-call with the same arguments and this token after the user has approved.'
    ),
};

/** Argument shape derived from {@link UpdateInputSchema}. */
export interface UpdateToolArgs {
  names?: string[];
  installPaths?: string[];
  projectPath?: string;
  apply?: boolean;
  confirmationToken?: string;
}

/**
 * Wrap a JSON-serializable payload in the MCP `text` content block shape used
 * by every handler in this directory, marking failures with `isError`.
 */
function jsonContent(data: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    ...(isError && { isError: true }),
  };
}

/**
 * Wrap an error with a structured `code` so an MCP client can branch on the
 * failure mode without matching the message. `extras` carry error-specific
 * fields.
 */
function errorContent(err: unknown, code: string, extras: Record<string, unknown> = {}) {
  return jsonContent(
    { error: err instanceof Error ? err.message : String(err), code, ...extras },
    true
  );
}

/** The MCP response a refused batch answers with. */
type ToolResponse = ReturnType<typeof jsonContent>;

/**
 * Build the `marketplace_update` handler bound to the supplied dependencies.
 *
 * @param deps - Marketplace MCP dependency bundle (reads `dorkHome`,
 *   `updateFlow`, `listAgentScopes`, `confirmationProvider`, `onPluginsChanged`
 *   and `logger`).
 * @returns An MCP tool handler accepting {@link UpdateToolArgs} and an optional
 *   caller context.
 */
export function createUpdateHandler(deps: MarketplaceMcpDeps) {
  // The door's notifier, made total: the reinstall has already landed when it
  // fires, so a listener that throws is logged and the update still reported
  // as what it is — the same rule `marketplace_install` follows (DOR-2057).
  const door: InstalledUpdatesDeps = {
    dorkHome: deps.dorkHome,
    updateFlow: deps.updateFlow,
    listAgentScopes: deps.listAgentScopes,
    onPluginsChanged: (ctx) => {
      try {
        deps.onPluginsChanged(ctx);
      } catch (err) {
        deps.logger.warn('[marketplace_update] post-update notification failed', {
          packageName: ctx.packageName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };

  return async (args: UpdateToolArgs, context?: MarketplaceConfirmationContext) => {
    // Confine `projectPath` before anything is scanned. The canonical path is
    // what the scan and every reinstall use; the caller's own spelling is what
    // the approval binds to and the refresh names (DOR-711), as with install.
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
    const selector = { names: args.names, installPaths: args.installPaths };

    try {
      if (!args.apply) {
        const result = await checkInstalledUpdates(door, projectPath, selector);
        return jsonContent({ status: 'checked', ...result });
      }

      const outcome = await applyApprovedUpdates<ToolResponse>(
        door,
        { projectPath, callerProjectPath: args.projectPath, ...selector },
        (updates) => confirmBatch(deps, args, updates, context),
        // After each reinstall landed: a person's yes on the card (never
        // `preApproved`, where nobody was shown anything) is recorded when the
        // installed copy is what the card showed (DOR-2306).
        async (landed) => {
          for (const update of landed) {
            await deps.consent.settle(
              {
                installPath: update.installPath,
                type: update.type,
                global: update.scope === 'global',
              },
              context?.preApproved
                ? undefined
                : { disclosed: update.disclosed, contentHash: update.contentHash }
            );
          }
        }
      );
      if ('refused' in outcome) return outcome.refused;
      // Nothing was stale, or nothing stale could be shown and approved: say so,
      // rather than answer `applied` for a call that changed nothing.
      const ran = outcome.result.checks.some((c) => c.applied || c.applyError);
      return jsonContent(
        ran
          ? { status: 'applied', ...outcome.result }
          : {
              status: 'nothing-to-update',
              message:
                "Nothing was updated: no selected package has a newer version that can be approved here. Each check's status and note says why.",
              ...outcome.result,
            }
      );
    } catch (err) {
      if (err instanceof PackageNotInstalledForUpdateError) {
        return errorContent(err, 'NOT_INSTALLED', {
          packageNames: err.packageNames,
          installPaths: err.installPaths,
        });
      }
      return errorContent(err, 'UPDATE_FAILED');
    }
  };
}

/**
 * Ask a person about one batch of reinstalls, or resolve the token they were
 * asked with. Returns `undefined` when the batch may run, else the response
 * that ends the call with nothing run.
 *
 * @internal
 */
async function confirmBatch(
  deps: MarketplaceMcpDeps,
  args: UpdateToolArgs,
  updates: ApprovableUpdate[],
  context: MarketplaceConfirmationContext | undefined
): Promise<ToolResponse | undefined> {
  // A person already approved this exact call at the capability tier gate, or
  // the caller may decide approvals itself: asking again would be a second card
  // for one action.
  if (context?.preApproved) return undefined;

  const req: ConfirmationRequest = {
    packageName: [...new Set(updates.map((u) => u.packageName))].join(', '),
    operation: 'update',
    updates,
    ...(context?.requestedBy ? { requestedBy: context.requestedBy } : {}),
  };
  const confirmation = args.confirmationToken
    ? await deps.confirmationProvider.resolveToken(args.confirmationToken, req)
    : await deps.confirmationProvider.requestInstallConfirmation(req);

  if (confirmation.status === 'pending') {
    return jsonContent({
      status: 'requires_confirmation',
      confirmationToken: confirmation.token,
      updates,
      // A `reason` means this card replaced an approval that no longer covered
      // the batch; see the same branch in `tool-install.ts`.
      message: `${confirmation.reason ? `${confirmation.reason} ` : ''}User must confirm these updates before anything is reinstalled. Re-call this tool with the same arguments and the confirmationToken once the user has approved.`,
    });
  }
  if (confirmation.status === 'declined') {
    return jsonContent({
      status: 'declined',
      reason: confirmation.reason ?? 'User declined the update',
    });
  }
  return undefined;
}
