/**
 * Marketplace routes: `/updates`: check every installation in view for updates, and apply exactly what a person was shown.
 *
 * @module routes/marketplace/updates
 */
import { z } from 'zod';
import { logger } from '../../lib/logger.js';
import { DisclosedEffectsSchema } from '../../services/marketplace/preview/disclosed-effects.js';
import { selectInstallations } from '../../services/marketplace/flows/update-selection.js';
import {
  applyApprovedUpdates,
  checkInstalledUpdates,
  reinstallInputsFor,
  scanUpdateView,
  updatesNotAsShown,
} from '../../services/marketplace/flows/update-installed.js';
import { trustedCaller } from '../../services/core/capabilities/index.js';
import { getRequestAgentIdentity } from '../../middleware/agent-identity.js';
import { readCallerAuthority } from '../../lib/caller-authority.js';
import type { MarketplaceRouteDeps } from '../marketplace.js';
import type { MarketplaceRouteContext } from './context.js';
import {
  BATCH_UPDATE_NEEDS_APPROVAL_CODE,
  fromOutdatedClient,
  mapErrorToStatus,
  outdatedClientResponse,
  updateRefusalResponse,
  type UpdateRefusal,
} from './shared.js';
import type { Router } from 'express';

/**
 * Body schema for `POST /api/marketplace/updates`. `apply` must be the literal
 * `true`: the read is `GET /updates`, and an empty or advisory POST must never
 * be the request that reinstalls every package.
 *
 * `targets` names each installation exactly as a check reported it AND as the
 * person was shown it: the version offered and what that version runs, sent
 * back untouched (DOR-2306). The server recomputes both and refuses the whole
 * apply if either moved. Strict, so the retired `names` / `installPaths`
 * selectors are refused rather than ignored.
 */
const ApplyUpdatesBodySchema = z
  .object({
    apply: z.literal(true),
    projectPath: z.string().optional(),
    targets: z
      .array(
        z.object({
          installPath: z.string().min(1),
          latestVersion: z.string(),
          disclosed: DisclosedEffectsSchema.nullable(),
          contentHash: z.string().min(1),
        })
      )
      .min(1),
    // The token an earlier call's `requires_confirmation` answer carried, once
    // a person has approved the card (an agent's apply only).
    confirmationToken: z.string().min(1).optional(),
  })
  .strict();

/**
 * Register the `/updates` routes on the marketplace router.
 *
 * @param router - The marketplace router.
 * @param deps - The router's injected dependencies.
 * @param ctx - The helpers every route group shares.
 */
export function mountUpdateRoutes(
  router: Router,
  deps: MarketplaceRouteDeps,
  ctx: MarketplaceRouteContext
): void {
  const { consent } = deps;
  const {
    authorize,
    gateResponse,
    confineProjectPath,
    updateDeps,
    readProjectPathQuery,
    batchNeedsApproval,
    askAboutUpdates,
  } = ctx;

  // GET /updates -- advisory update check of every installation in view.
  //
  // One scan, handed to the flow, which answers one check per installation with
  // that installation's identity (`installPath` joins it to `GET /installed`)
  // and, for each newer version, what it runs (`disclosed`): what a confirm step
  // shows and an apply sends back (DOR-2306). A read: nothing installed
  // changes, so it is not gated, exactly like the per-package route.
  router.get('/updates', async (req, res) => {
    try {
      const query = readProjectPathQuery(req, res);
      if (query.refused) return query.refused;
      const confined = await confineProjectPath(res, query.projectPath);
      if (confined.refused) return confined.refused;
      return res.json(await checkInstalledUpdates(updateDeps, confined.projectPath));
    } catch (err) {
      logger.error('[Marketplace] Failed to check installed packages for updates', err);
      const mapped = mapErrorToStatus(err);
      return res.status(mapped.status).json(mapped.body);
    }
  });

  // POST /updates -- reinstall exactly the installations a person was shown,
  // each held to the version and the disclosure they saw (DOR-2306). Each
  // reinstall stays in the scope its installation was found in; a failed one is
  // reported on that installation and the rest carry on.
  router.post('/updates', async (req, res) => {
    if (fromOutdatedClient(req.body)) return outdatedClientResponse(res);
    const parsed = ApplyUpdatesBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: z.flattenError(parsed.error) });
    }
    const { targets, confirmationToken } = parsed.data;

    try {
      const confined = await confineProjectPath(res, parsed.data.projectPath);
      if (confined.refused) return confined.refused;
      if (batchNeedsApproval(req, res)) {
        return res.status(403).json({
          error:
            'Updating several packages at once cannot wait for a person to approve each ' +
            'install. Ask a person to update them in DorkOS.',
          code: BATCH_UPDATE_NEEDS_APPROVAL_CODE,
        });
      }
      const requested = {
        projectPath: confined.projectPath,
        callerProjectPath: parsed.data.projectPath,
      };
      const installPaths = targets.map((target) => target.installPath);

      // The capability tier gate first, as `marketplace.install` per package and
      // scope — what the per-package route always asked for one — BEFORE any
      // network work. The first refusal ends the batch unrun.
      const records = selectInstallations(await scanUpdateView(updateDeps, requested.projectPath), {
        installPaths,
      });
      for (const input of reinstallInputsFor(records, requested)) {
        const decision = await authorize(req, res, 'marketplace.install', input);
        if (decision.outcome !== 'allowed') return gateResponse(res, decision);
      }

      const trusted = trustedCaller(readCallerAuthority(req, res)) !== undefined;
      const identity = getRequestAgentIdentity(res);
      const outcome = await applyApprovedUpdates<UpdateRefusal>(
        updateDeps,
        { ...requested, installPaths },
        async (updates) => {
          // What would be reinstalled now must be exactly what was shown:
          // another version, or a version that runs anything else, stops the
          // whole apply before anything is removed.
          const changed = updatesNotAsShown(updates, targets);
          if (changed.length > 0) return { kind: 'changed', changed };
          if (!trusted) {
            // An agent can read any disclosure the app can, so sending one
            // back proves nothing about a person having looked. It gets the
            // card `marketplace_update` raises, bound the same way.
            const confirmation = await askAboutUpdates(
              updates,
              confirmationToken,
              identity ? identity.displayName || identity.agentPath : undefined
            );
            if (confirmation) return confirmation;
          }
          return undefined;
        },
        // Only what landed, and only now that it has (DOR-2306): each is
        // recorded as approved when its installed copy is what was shown.
        async (landed) => {
          for (const update of landed) {
            await consent.settle(
              {
                installPath: update.installPath,
                type: update.type,
                global: update.scope === 'global',
              },
              { disclosed: update.disclosed, contentHash: update.contentHash }
            );
          }
        }
      );
      if ('refused' in outcome) return updateRefusalResponse(res, outcome.refused);
      // The response is the record of what changed: each installation's
      // `applied` or `applyError`.
      return res.json(outcome.result);
    } catch (err) {
      logger.error('[Marketplace] Failed to apply updates', err);
      const mapped = mapErrorToStatus(err);
      return res.status(mapped.status).json(mapped.body);
    }
  });
}
