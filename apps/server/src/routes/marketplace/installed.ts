/**
 * Marketplace routes: `/installed`: every installation, or one package's installations across scopes.
 *
 * @module routes/marketplace/installed
 */
import { logger } from '../../lib/logger.js';
import { globalPackageDir } from '../../services/marketplace/consent/global-plugin-consent.js';
import { listHeldBackPackages } from '../../services/marketplace/consent/ask-withheld-global-plugins.js';
import { scanUpdateView } from '../../services/marketplace/flows/update-installed.js';
import {
  scanInstallationsAcrossScopes,
  computeProvides,
} from '../../services/marketplace/installed-scanner.js';
import { withIntegrity } from '../../services/marketplace/lib/integrity/verify-install.js';
import type { MarketplaceRouteDeps } from '../marketplace.js';
import type { MarketplaceRouteContext } from './context.js';
import { wantsVerify } from './shared.js';
import type { Router } from 'express';

/**
 * Register the `/installed` routes on the marketplace router.
 *
 * @param router - The marketplace router.
 * @param deps - The router's injected dependencies.
 * @param ctx - The helpers every route group shares.
 */
export function mountInstalledRoutes(
  router: Router,
  deps: MarketplaceRouteDeps,
  ctx: MarketplaceRouteContext
): void {
  const { dorkHome, listAgentScopes } = deps;
  const { confineProjectPath, updateDeps, readProjectPathQuery } = ctx;

  // GET /installed -- list installed packages.
  //
  // Without projectPath: one entry PER INSTALLATION across all scopes — the
  // global roots plus every install root under each registered agent's .dork/
  // (a package installed globally and on two agents yields three entries).
  // With projectPath: the merged view for that single project (global + its
  // local installs, one entry per install root AND name), which the install
  // dialog uses for scope-accurate reinstall detection. Merging on the name
  // alone would let a project's agents/foo swallow the global plugins/foo —
  // two different packages the conflict detector allows to coexist — so the
  // merged view can return two entries sharing a name (DOR-994).
  //
  // The project view is scanned at the CANONICAL path the boundary resolved,
  // exactly as `GET /updates` scans it, so a project reached through a symlink
  // lists the same `installPath`s its update checks carry and the two join.
  router.get('/installed', async (req, res) => {
    try {
      const query = readProjectPathQuery(req, res);
      if (query.refused) return query.refused;
      const confined = await confineProjectPath(res, query.projectPath);
      if (confined.refused) return confined.refused;
      const records = await scanUpdateView(updateDeps, confined.projectPath);
      // A global package held back from every session says so on its row, so
      // it never just vanishes from sessions without a word (DOR-2306).
      const heldBack = new Map(
        (await listHeldBackPackages(dorkHome, { bindings: false })).map((held) => [
          globalPackageDir(dorkHome, held.name),
          {
            reason: held.reason,
            note: held.note,
            reviewable: held.reviewable,
            ...(held.linkedPath !== undefined && { linkedPath: held.linkedPath }),
          },
        ])
      );
      const packages = records.map((r) => {
        const held = r.package.scope === 'global' ? heldBack.get(r.package.installPath) : undefined;
        return held ? { ...r.package, heldBack: held } : r.package;
      });
      // Verification hashes every shipped file, so it is asked for (DOR-2197).
      return res.json({ packages: wantsVerify(req) ? await withIntegrity(packages) : packages });
    } catch (err) {
      logger.error('[Marketplace] Failed to list installed packages', err);
      return res.status(500).json({ error: 'Failed to list installed packages' });
    }
  });

  // GET /installed/:name -- every installation of a single package across all
  // scopes, each enriched with capability counts (commands/skills/hooks) for
  // the drawer's installations panel. Enrichment stays off the list endpoint
  // to avoid N filesystem walks on every marketplace render; here N is the
  // handful of scopes one package occupies.
  router.get('/installed/:name', async (req, res) => {
    try {
      const all = await scanInstallationsAcrossScopes(dorkHome, listAgentScopes?.() ?? []);
      const matches = all.filter((p) => p.name === req.params.name);
      if (matches.length === 0) {
        return res.status(404).json({ error: `Installed package '${req.params.name}' not found` });
      }
      const installations = await Promise.all(
        matches.map(async (match) => ({
          ...match,
          provides: await computeProvides(match.installPath),
        }))
      );
      return res.json({
        installations: wantsVerify(req) ? await withIntegrity(installations) : installations,
      });
    } catch (err) {
      logger.error(`[Marketplace] Failed to get installed package ${req.params.name}`, err);
      return res.status(500).json({ error: 'Failed to get installed package' });
    }
  });
}
