/**
 * Marketplace management routes -- sources, cache status, installed
 * package listing, plus package discovery/preview/install/uninstall/update
 * under `/api/marketplace/*`.
 *
 * The router is constructed via a factory that injects its dependencies
 * (source manager, cache, fetcher, installer, uninstall flow, update flow,
 * dorkHome) so the same factory can be exercised under supertest without
 * touching the real filesystem.
 *
 * @module routes/marketplace
 */
import { Router, type Request, type Response } from 'express';
import { lstat, open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  mergeMarketplace,
  primaryCategory,
  type MergedMarketplaceEntry,
  type PluginSource,
} from '@dorkos/marketplace';
import type { AggregatedPackage } from '@dorkos/shared/marketplace-schemas';
import { logger } from '../lib/logger.js';
import type { MarketplaceCache, CachedPackage } from '../services/marketplace/marketplace-cache.js';
import type { MarketplaceSourceManager } from '../services/marketplace/marketplace-source-manager.js';
import type { PackageFetcher } from '../services/marketplace/package-fetcher.js';
import type { InstallerLike } from '../services/marketplace/marketplace-installer.js';
import {
  ConflictError,
  InvalidPackageError,
} from '../services/marketplace/marketplace-installer.js';
import {
  PackageNotFoundError,
  MarketplaceNotFoundError,
} from '../services/marketplace/package-resolver.js';
import {
  PackageNotInstalledError,
  type UninstallFlow,
} from '../services/marketplace/flows/uninstall.js';
import type { UpdateFlow } from '../services/marketplace/flows/update.js';
import {
  assertPackageName,
  MarketplacePathError,
  PathEscapeError,
} from '../services/marketplace/lib/package-paths.js';
import {
  installCountsProvider,
  enrichWithInstallCounts,
} from '../services/marketplace/install-counts.js';
import { updatedAtProvider, enrichWithUpdatedAt } from '../services/marketplace/updated-at.js';
import type { MarketplaceSource } from '../services/marketplace/types.js';
import {
  scanInstalledPackages,
  scanInstallationsAcrossScopes,
  computeProvides,
  type AgentScopeRef,
  type InstalledPackage,
} from '../services/marketplace/installed-scanner.js';
import { validateBoundary, BoundaryError } from '../lib/boundary.js';
import {
  APPROVAL_TOKEN_HEADER,
  authorizeCapability,
  trustedCaller,
  type CapabilityRegistry,
  type TierEnforcementDecision,
} from '../services/core/capabilities/index.js';
import { resolveDecisionAuthority } from '../services/core/approvals/index.js';
import { getRequestAgentIdentity } from '../middleware/agent-identity.js';
import { readCallerAuthority } from '../lib/caller-authority.js';
import {
  OPERATOR_ONLY_MARKETPLACE_SOURCE_CODE,
  describeMarketplaceSourceRefusal,
  marketplaceSourceRefusalError,
  type MarketplaceSourceAction,
} from '../services/marketplace/source-write-policy.js';

/**
 * Re-export the canonical {@link InstalledPackage} type from this route module
 * so external callers that historically imported it from `routes/marketplace`
 * keep working after the scan helper moved into `services/marketplace/`.
 */
export type { InstalledPackage } from '../services/marketplace/installed-scanner.js';

/** Dependencies injected into {@link createMarketplaceRouter}. */
export interface MarketplaceRouteDeps {
  /** Source manager for marketplaces.json CRUD. */
  sourceManager: MarketplaceSourceManager;
  /** Cache abstraction for marketplace.json documents and cloned packages. */
  cache: MarketplaceCache;
  /** Fetcher that resolves marketplace.json documents and package clones. */
  fetcher: PackageFetcher;
  /** Installer orchestrator for preview and install dispatch. */
  installer: InstallerLike;
  /** Uninstall flow — removes installed packages. */
  uninstallFlow: UninstallFlow;
  /** Update flow — advisory-by-default update checker and applier. */
  updateFlow: UpdateFlow;
  /** Resolved DorkOS data directory (see `.claude/rules/dork-home.md`). */
  dorkHome: string;
  /**
   * The composed capability registry, read lazily because it is built AFTER this
   * router (`index.ts`) — the same late-bound read the approval service uses.
   *
   * These routes perform marketplace mutations directly rather than through
   * `registry.invoke`, because they own a response contract the cockpit and the
   * CLI already depend on. They therefore have to reach the tier gate explicitly,
   * through `authorizeCapability`. Returning `undefined` here means the registry
   * is not composed yet, which FAILS CLOSED for a destructive route rather than
   * waving it through — see {@link createMarketplaceRouter}.
   */
  capabilityRegistry: () => CapabilityRegistry | undefined;
  /**
   * Optional callback fired after a successful install/uninstall. Carries the
   * change context (which package, which action, and the project root for a
   * project-scoped change) so the handler can both refresh the runtime plugin
   * cache and project the plugin's assets to the project's other harnesses
   * (Harness Sync auto-projection, GAP-4). `projectPath` is `undefined` for a
   * global install/uninstall.
   */
  onPluginsChanged?: (ctx: PluginsChangedContext) => void;
  /**
   * List the registered agents whose project directories the cross-scope
   * installed scan should walk (typically `meshCore.listWithPaths()`). When
   * absent — mesh disabled or not yet initialized — the installed listing
   * falls back to global scopes only.
   */
  listAgentScopes?: () => AgentScopeRef[];
}

/**
 * Context passed to {@link MarketplaceRouteDeps.onPluginsChanged} describing the
 * install/uninstall that just succeeded.
 */
export interface PluginsChangedContext {
  /** The project root the change targeted, or `undefined` for a global change. */
  projectPath?: string;
  /** The marketplace package name that was installed or uninstalled. */
  packageName: string;
  /** Whether the change was an install or an uninstall. */
  action: 'install' | 'uninstall';
}

export type { AggregatedPackage } from '@dorkos/shared/marketplace-schemas';

const AddSourceBodySchema = z.object({
  name: z.string().min(1).max(128),
  source: z.string().min(1),
  enabled: z.boolean().optional(),
});

/**
 * Body schema for `POST /api/marketplace/packages/:name/preview` and
 * `POST /api/marketplace/packages/:name/install` — everything on
 * {@link InstallRequest} except `name`, which is taken from the URL
 * param.
 */
const InstallRequestBodySchema = z.object({
  marketplace: z.string().optional(),
  source: z.string().optional(),
  force: z.boolean().optional(),
  yes: z.boolean().optional(),
  projectPath: z.string().optional(),
});

/** Body schema for `POST /api/marketplace/packages/:name/uninstall`. */
const UninstallRequestBodySchema = z.object({
  purge: z.boolean().optional(),
  projectPath: z.string().optional(),
});

/** Body schema for `POST /api/marketplace/packages/:name/update`. */
const UpdateRequestBodySchema = z.object({
  apply: z.boolean().optional(),
  projectPath: z.string().optional(),
});

/** Body schema for `POST /api/marketplace/cache/prune`. */
const PruneCacheBodySchema = z.object({
  keepLastN: z.number().int().nonnegative().optional(),
});

/** Query schema for `GET /api/marketplace/packages/:name`. */
const GetPackageQuerySchema = z.object({
  marketplace: z.string().optional(),
});

/**
 * Centralized error → HTTP status mapping. Shared by every install-related
 * handler so the translation rules stay in one place and the telemetry
 * remains consistent across endpoints.
 *
 * @param err - The error thrown by the installer, uninstall flow, update
 *   flow, resolver, or fetcher.
 * @returns The HTTP status and response body to send.
 */
function mapErrorToStatus(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof InvalidPackageError) {
    return { status: 400, body: { error: err.message, errors: err.errors } };
  }
  // A containment assertion fired somewhere below. Its message names the root
  // the path escaped — a cache directory under dorkHome, which spells the
  // operator's home directory and therefore their username — so the body says
  // the path was refused and nothing about where anything lives. The full
  // message still reaches the server log through the handler's `logger.error`.
  if (err instanceof PathEscapeError) {
    return { status: 400, body: { error: 'Refused: that path resolves outside its own folder' } };
  }
  // A name the caller may not use. Echoed back on purpose, unlike the above:
  // the only thing this message contains is the name the caller just sent, and
  // saying which one was rejected is what makes the 400 actionable.
  if (err instanceof MarketplacePathError) {
    return { status: 400, body: { error: err.message } };
  }
  // Reached when the boundary refusal comes from INSIDE the install pipeline —
  // a `./local/path` install identifier pointing outside the boundary — rather
  // than from the body's `projectPath`, which each handler checks up front with
  // its own message.
  if (err instanceof BoundaryError) {
    return { status: 403, body: { error: 'Access denied: path outside directory boundary' } };
  }
  if (err instanceof ConflictError) {
    return { status: 409, body: { error: err.message, conflicts: err.conflicts } };
  }
  if (err instanceof PackageNotInstalledError) {
    return { status: 404, body: { error: err.message } };
  }
  if (err instanceof PackageNotFoundError) {
    return { status: 404, body: { error: err.message } };
  }
  if (err instanceof MarketplaceNotFoundError) {
    return { status: 404, body: { error: err.message } };
  }
  return {
    status: 500,
    body: { error: err instanceof Error ? err.message : String(err) },
  };
}

/**
 * Create the marketplace management router.
 *
 * Registers the following endpoints under the caller-chosen mount point
 * (typically `/api/marketplace`):
 *
 * - `GET /sources` — list configured marketplace sources
 * - `POST /sources` — add a new source (operator-only; agents are refused)
 * - `DELETE /sources/:name` — remove a source (operator-only; agents are refused)
 * - `POST /sources/:name/refresh` — force refetch of a source's marketplace.json
 * - `GET /installed` — list installed packages across scopes (or one project via `?projectPath`)
 * - `GET /installed/:name` — every installation of a package, one entry per scope
 * - `GET /cache` — cache status
 * - `DELETE /cache` — clear cache
 * - `GET /packages` — aggregate packages from every enabled marketplace
 * - `GET /packages/:name` — fetch and validate a single package
 * - `POST /packages/:name/preview` — build a permission preview without installing
 * - `POST /packages/:name/install` — install a package
 * - `POST /packages/:name/uninstall` — uninstall a package
 * - `POST /packages/:name/update` — advisory update check (with `apply: true` option)
 *
 * @param deps - Injected dependencies (source manager, cache, fetcher,
 *   installer, uninstall flow, update flow, dorkHome).
 */
export function createMarketplaceRouter(deps: MarketplaceRouteDeps): Router {
  const {
    sourceManager,
    cache,
    fetcher,
    installer,
    uninstallFlow,
    updateFlow,
    dorkHome,
    onPluginsChanged,
    listAgentScopes,
    capabilityRegistry,
  } = deps;
  const router = Router();

  /**
   * Run the tier gate for the capability this route is about to perform itself.
   *
   * These routes predate the Capability Registry and own a response contract the
   * cockpit and `dorkos install|uninstall` already depend on, so they cannot be
   * re-pointed at `registry.invoke` without changing what those callers receive.
   * What they CAN do — and until DOR-467 did not — is answer to the same gate.
   *
   * The caller that clears {@link trustedCaller} skips it, and that is the whole
   * cockpit story: a person clicking Uninstall sends no `X-DorkOS-Agent` header
   * and no approval token, so they are the caller `resolveDecisionAuthority`
   * already lets DECIDE approvals — asking them to approve their own click would
   * be a card for something they just did. An agent following its instructions
   * carries `DORKOS_AGENT_TOKEN`, so `dorkos uninstall` from inside a session
   * presents an identity and is gated, which is the door this ticket closes.
   *
   * @param req - The incoming request.
   * @param res - The response, for `sessionGate`'s resolved user.
   * @param id - The capability id whose tier governs this effect.
   * @param input - The effect's arguments, parsed against that capability's schema.
   * @returns What the gate decided. Proceed only on `allowed`.
   */
  const authorize = (
    req: Request,
    res: Response,
    id: string,
    input: unknown
  ): TierEnforcementDecision => {
    const registry = capabilityRegistry();
    if (!registry) {
      // Fail closed: with no registry there is no tier to read and nobody to ask,
      // and treating "not wired yet" as "allowed" is how a wiring mistake becomes
      // an unreviewed destructive action.
      return {
        outcome: 'denied',
        payload: {
          status: 'denied',
          capabilityId: id,
          capabilityTitle: id,
          tier: 'destructive',
          reason: 'enforcement_unavailable',
          approvable: false,
          message:
            'DorkOS cannot check permissions for this action right now, so it was refused. Try again in a moment.',
        },
      };
    }
    const identity = getRequestAgentIdentity(res);
    const header = req.headers[APPROVAL_TOKEN_HEADER];
    const approvalToken = (Array.isArray(header) ? header[0] : header)?.trim();
    const trusted = trustedCaller(readCallerAuthority(req, res));
    return authorizeCapability(registry, id, input, {
      ...(trusted ? { trusted } : {}),
      ...(identity ? { identity } : {}),
      ...(approvalToken ? { approvalToken } : {}),
      retryChannel: 'http-header',
    });
  };

  /**
   * Turn a non-`allowed` gate decision into this router's HTTP answer: `202` when
   * a person has been asked and the caller should come back with the token, `403`
   * when no retry can change the answer.
   */
  const gateResponse = (
    res: Response,
    decision: Exclude<TierEnforcementDecision, { outcome: 'allowed' }>
  ): Response =>
    res.status(decision.outcome === 'approval_required' ? 202 : 403).json(decision.payload);

  /**
   * Confine a body-supplied `projectPath` to the directory boundary, answering
   * `403` with a message that names the field, and hand back the CANONICAL
   * spelling of the path it accepted.
   *
   * Kept separate from the catch blocks below so a boundary refusal raised
   * DEEPER in the install pipeline — a `./local/path` install identifier
   * pointing off the boundary, refused by the package resolver — is not
   * mislabelled as a `projectPath` problem. That one falls through to
   * {@link mapErrorToStatus}.
   *
   * ## Why the canonical path is returned rather than discarded (DOR-711)
   *
   * `validateBoundary` realpaths what it validates, and this helper used to
   * throw that result away, leaving every route below to act on the raw body
   * string. Two spellings of one project directory — `/work/proj` and a
   * symlink `/work/current` pointing at it — then produced two different
   * install targets for one directory, which is one directory being installed
   * into under two names. The install engine's per-target lock now resolves its
   * own key too, so it holds either way; passing the canonical path is the
   * other half, and it also keeps the path an install is RECORDED against the
   * same one it was CHECKED against.
   *
   * Only the EFFECT is re-pointed — the install, uninstall, update and preview
   * calls, which are what compute an install target on disk. Two things
   * deliberately keep the caller's own spelling:
   *
   * - **The tier gate.** An approval token binds to the arguments the caller
   *   sent, and `dorkos call marketplace.uninstall` must still mint a token
   *   this route honours, so rewriting the hashed arguments would break that
   *   parity.
   * - **{@link MarketplaceRouteDeps.onPluginsChanged}.** It is a notification
   *   keyed to the caller's project, not a filesystem write, and its listeners
   *   match it against project paths spelled the way the person picked them.
   *
   * Neither is load-bearing for the race: the install engine resolves its own
   * lock key from the filesystem, so it holds however the caller spelled the
   * path.
   *
   * @param res - The response to answer on.
   * @param projectPath - The body's `projectPath`, when it sent one.
   * @returns `{ refused }` carrying the sent `403`, or `{ projectPath }` with
   *   the canonical path (or `undefined` when the body sent none). Callers must
   *   `return` the refusal so the effect below never runs.
   */
  const confineProjectPath = async (
    res: Response,
    projectPath: string | undefined
  ): Promise<{ refused: Response } | { refused?: undefined; projectPath?: string }> => {
    if (!projectPath) return {};
    try {
      return { projectPath: await validateBoundary(projectPath) };
    } catch (err) {
      if (err instanceof BoundaryError) {
        return {
          refused: res.status(403).json({ error: 'Access denied: projectPath outside boundary' }),
        };
      }
      throw err;
    }
  };

  /**
   * Refuse a package-source write unless the caller is the operator (DOR-502).
   *
   * This is NOT the tier gate above and deliberately not shaped like it: there is
   * no approval a caller could come back with, because there is no capability and
   * no card. Changing which feeds this install fetches code from is the person's,
   * the same way `CONFIG_WRITE_POLICY` makes the hosts DorkOS reaches the person's.
   * The full reasoning, including why the `PATCH /api/config` cookie bar is not
   * copied here, lives in `services/marketplace/source-write-policy.ts`.
   *
   * ## Why this reads the resolver directly instead of asking for a marker
   *
   * It used to call `trustedCaller` and throw the marker away, using it as a
   * boolean. That stopped being the same question when DOR-474 put a cookie
   * requirement inside `trustedCaller`: a marker now means "may act without an
   * approval", and under login only a session cookie earns one. This route wants
   * the OTHER thing — the agent bar, which refuses anything naming itself an agent
   * or holding an approval token, and accepts the person's API key from their own
   * terminal. `dorkos marketplace add|remove` has no cookie to present and no
   * approval card to fall back to, so demanding one here is a lockout rather than
   * a hardening (DOR-502). Reading `resolveDecisionAuthority` says exactly that,
   * and cannot silently inherit a tightening aimed at a different question.
   *
   * @param req - The incoming request.
   * @param res - The response, for `sessionGate`'s resolved user.
   * @param action - Which write was attempted, for the refusal wording.
   * @returns The sent `403` response when refused, otherwise `undefined`. Callers
   *   must `return` a truthy result so the effect below never runs.
   */
  const refuseUntrustedSourceWrite = (
    req: Request,
    res: Response,
    action: MarketplaceSourceAction
  ): Response | undefined => {
    if (resolveDecisionAuthority(readCallerAuthority(req, res)).allowed) return undefined;
    return res.status(403).json({
      error: marketplaceSourceRefusalError(action),
      code: OPERATOR_ONLY_MARKETPLACE_SOURCE_CODE,
      message: describeMarketplaceSourceRefusal(action),
    });
  };

  // GET /sources -- list configured marketplace sources
  router.get('/sources', async (_req, res) => {
    try {
      const sources = await sourceManager.list();
      res.json({ sources });
    } catch (err) {
      logger.error('[Marketplace] Failed to list sources', err);
      res.status(500).json({ error: 'Failed to list marketplace sources' });
    }
  });

  // POST /sources -- add a new marketplace source (operator-only, DOR-502)
  router.post('/sources', async (req, res) => {
    // Ahead of validation on purpose: a caller that may not do this at all gets
    // one answer whatever it sent, rather than a schema it can probe.
    //
    // This deliberately does NOT match the three sibling mutation routes below.
    // `install`, `uninstall` and `update` all `safeParse` first and answer a bad
    // body with a 400 carrying `z.flattenError` details, before their gate ever
    // runs. That order is the older one and it is not changed here, because
    // reordering three gated routes is a separate change with its own blast
    // radius. Recording it so the difference reads as a decision rather than as
    // drift somebody has to rediscover: `uninstall` is the one worth revisiting,
    // since it is `destructive` and hands its schema to a caller it is then going
    // to stop with an approval card.
    const refused = refuseUntrustedSourceWrite(req, res, 'add');
    if (refused) return refused;

    const parsed = AddSourceBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: z.flattenError(parsed.error) });
    }

    try {
      const created = await sourceManager.add(parsed.data);
      return res.status(201).json(created);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add marketplace source';
      if (message.includes('already exists')) {
        return res.status(409).json({ error: message });
      }
      logger.error('[Marketplace] Failed to add source', err);
      return res.status(500).json({ error: 'Failed to add marketplace source' });
    }
  });

  // DELETE /sources/:name -- remove a marketplace source (operator-only, DOR-502)
  router.delete('/sources/:name', async (req, res) => {
    const refused = refuseUntrustedSourceWrite(req, res, 'remove');
    if (refused) return refused;

    try {
      await sourceManager.remove(req.params.name);
      res.status(204).send();
    } catch (err) {
      logger.error(`[Marketplace] Failed to remove source ${req.params.name}`, err);
      res.status(500).json({ error: 'Failed to remove marketplace source' });
    }
  });

  // POST /sources/:name/refresh -- force refetch of a source's marketplace.json
  router.post('/sources/:name/refresh', async (req, res) => {
    try {
      const source = await sourceManager.get(req.params.name);
      if (!source) {
        return res.status(404).json({ error: `Marketplace source '${req.params.name}' not found` });
      }

      const marketplace = await fetcher.fetchMarketplaceJson(source);
      return res.json({ marketplace, fetchedAt: new Date().toISOString() });
    } catch (err) {
      logger.error(`[Marketplace] Failed to refresh source ${req.params.name}`, err);
      const message = err instanceof Error ? err.message : 'Failed to refresh marketplace source';
      return res.status(502).json({ error: message });
    }
  });

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
  router.get('/installed', async (req, res) => {
    try {
      const projectPath =
        typeof req.query.projectPath === 'string' ? req.query.projectPath : undefined;
      if (projectPath) {
        await validateBoundary(projectPath);
      }
      const packages: InstalledPackage[] = projectPath
        ? await scanInstalledPackages(dorkHome, projectPath)
        : await scanInstallationsAcrossScopes(dorkHome, listAgentScopes?.() ?? []);
      res.json({ packages });
    } catch (err) {
      if (err instanceof BoundaryError) {
        return res.status(403).json({ error: 'Access denied: projectPath outside boundary' });
      }
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
      return res.json({ installations });
    } catch (err) {
      logger.error(`[Marketplace] Failed to get installed package ${req.params.name}`, err);
      return res.status(500).json({ error: 'Failed to get installed package' });
    }
  });

  // GET /cache -- cache status (marketplace count, package count, total bytes)
  router.get('/cache', async (_req, res) => {
    try {
      const status = await computeCacheStatus(cache);
      res.json(status);
    } catch (err) {
      logger.error('[Marketplace] Failed to read cache status', err);
      res.status(500).json({ error: 'Failed to read cache status' });
    }
  });

  // DELETE /cache -- wipe the marketplace cache
  router.delete('/cache', async (_req, res) => {
    try {
      await cache.clear();
      res.status(204).send();
    } catch (err) {
      logger.error('[Marketplace] Failed to clear cache', err);
      res.status(500).json({ error: 'Failed to clear marketplace cache' });
    }
  });

  // POST /cache/prune -- garbage-collect cached packages by keepLastN
  router.post('/cache/prune', async (req, res) => {
    const parsed = PruneCacheBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: z.flattenError(parsed.error) });
    }

    try {
      // Snapshot package sizes before pruning so we can report freed bytes —
      // the descriptors returned from `prune()` point at deleted directories
      // that can no longer be stat'd.
      const sizesBeforePrune = new Map<string, number>();
      const cachedBefore = await cache.listPackages();
      await Promise.all(
        cachedBefore.map(async (pkg) => {
          sizesBeforePrune.set(pkg.path, await sumDirectorySize(pkg.path));
        })
      );

      const { removed } = await cache.prune(parsed.data);
      const freedBytes = removed.reduce(
        (sum, pkg) => sum + (sizesBeforePrune.get(pkg.path) ?? 0),
        0
      );

      return res.json({
        removed: removed.map((pkg) => ({
          packageName: pkg.packageName,
          commitSha: pkg.commitSha,
          path: pkg.path,
          cachedAt: pkg.cachedAt.toISOString(),
        })),
        freedBytes,
      });
    } catch (err) {
      logger.error('[Marketplace] Failed to prune cache', err);
      return res.status(500).json({ error: 'Failed to prune marketplace cache' });
    }
  });

  // GET /packages -- aggregate packages from every enabled marketplace
  router.get('/packages', async (_req, res) => {
    try {
      const sources = await sourceManager.list();
      const enabled = sources.filter((source) => source.enabled);
      const packages = await aggregatePackages(enabled, fetcher);
      // Enrich with community install counts and registry-recency dates so the
      // client can offer the Popular and Recent sorts. Both read cached maps
      // (background-refreshed) — never block the browse response on the
      // dorkos.ai network calls, and each degrades to no data (hiding its sort)
      // when the cache is cold or the site is unreachable.
      const withCounts = enrichWithInstallCounts(packages, installCountsProvider.getCounts());
      const enriched = enrichWithUpdatedAt(withCounts, updatedAtProvider.getUpdatedAt());
      res.json({ packages: enriched });
    } catch (err) {
      logger.error('[Marketplace] Failed to aggregate packages', err);
      const mapped = mapErrorToStatus(err);
      res.status(mapped.status).json(mapped.body);
    }
  });

  // GET /packages/:name -- fetch and validate a single package entry
  router.get('/packages/:name', async (req, res) => {
    const parsedQuery = GetPackageQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: z.flattenError(parsedQuery.error) });
    }

    try {
      const { preview, manifest, packagePath } = await installer.preview({
        name: req.params.name,
        marketplace: parsedQuery.data.marketplace,
      });
      // The installer already staged the package locally, so read its README
      // straight off disk — no extra network fetch. Omitted when absent so the
      // response shape stays clean (the client shows nothing rather than an
      // empty placeholder).
      const readme = await readPackageReadme(packagePath);
      return res.json({ manifest, packagePath, preview, ...(readme !== undefined && { readme }) });
    } catch (err) {
      logger.error(`[Marketplace] Failed to fetch package ${req.params.name}`, err);
      const mapped = mapErrorToStatus(err);
      return res.status(mapped.status).json(mapped.body);
    }
  });

  // POST /packages/:name/preview -- build a PermissionPreview without installing
  router.post('/packages/:name/preview', async (req, res) => {
    const parsed = InstallRequestBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: z.flattenError(parsed.error) });
    }

    try {
      // The same confinement the three sibling mutation routes apply, and the
      // one this route most needs: preview is the only one of the four that is
      // NOT tier-gated, and it READS. `PermissionPreviewBuilder` joins
      // `projectPath` into an install root and the conflict detector walks it,
      // so an unbounded preview answers "does this directory exist, and what is
      // in it" for any absolute path on the machine, with no approval card in
      // the way.
      const confined = await confineProjectPath(res, parsed.data.projectPath);
      if (confined.refused) return confined.refused;
      const { preview, manifest, packagePath } = await installer.preview({
        name: req.params.name,
        ...parsed.data,
        ...(confined.projectPath !== undefined && { projectPath: confined.projectPath }),
      });
      return res.json({ preview, manifest, packagePath });
    } catch (err) {
      logger.error(`[Marketplace] Failed to preview package ${req.params.name}`, err);
      const mapped = mapErrorToStatus(err);
      return res.status(mapped.status).json(mapped.body);
    }
  });

  // POST /packages/:name/install -- install a marketplace package
  //
  // TODO: SSE clone progress (see services/discovery/scan-stream pattern).
  // The spec mentions optional streaming for clone progress; we ship the
  // unary JSON response first and will wire a dedicated `/install/stream`
  // variant in a follow-up rather than ship a half-implemented SSE here.
  router.post('/packages/:name/install', async (req, res) => {
    const parsed = InstallRequestBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: z.flattenError(parsed.error) });
    }

    try {
      const confined = await confineProjectPath(res, parsed.data.projectPath);
      if (confined.refused) return confined.refused;
      // `marketplace.install` is tier `act`, so this passes for every caller
      // today and no approval card appears for a person clicking Install. It is
      // gated anyway so the route answers to the capability's declared tier
      // rather than to nothing: raise that tier and this route follows.
      const decision = authorize(req, res, 'marketplace.install', {
        name: req.params.name,
        ...(parsed.data.marketplace !== undefined && { marketplace: parsed.data.marketplace }),
        ...(parsed.data.projectPath !== undefined && { projectPath: parsed.data.projectPath }),
      });
      if (decision.outcome !== 'allowed') return gateResponse(res, decision);
      const result = await installer.install({
        name: req.params.name,
        ...parsed.data,
        ...(confined.projectPath !== undefined && { projectPath: confined.projectPath }),
      });
      // Report the RESOLVED manifest name, never the raw `:name` route param.
      // For `dorkos install ./local/path` or `github:user/repo` the param is
      // an install identifier, not the package name, and consumers (Harness
      // Sync auto-projection) look up `.dork/plugins/<packageName>` (DOR-264).
      onPluginsChanged?.({
        projectPath: parsed.data.projectPath,
        packageName: result.packageName,
        action: 'install',
      });
      return res.json(result);
    } catch (err) {
      logger.error(`[Marketplace] Failed to install package ${req.params.name}`, err);
      const mapped = mapErrorToStatus(err);
      return res.status(mapped.status).json(mapped.body);
    }
  });

  // POST /packages/:name/uninstall -- remove an installed package
  router.post('/packages/:name/uninstall', async (req, res) => {
    const parsed = UninstallRequestBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: z.flattenError(parsed.error) });
    }

    // Ahead of the tier gate on purpose. Unlike every other route here, this
    // one's `:name` is not an install identifier to be resolved — it is joined
    // straight into `dorkHome` by the flow, and Express decodes params after
    // routing, so `..%2F..%2Fvictim` arrives as a working climb. Refusing it
    // here also means no approval card is ever raised for an uninstall that
    // could not name a real package.
    try {
      assertPackageName(req.params.name);
    } catch (err) {
      const mapped = mapErrorToStatus(err);
      return res.status(mapped.status).json(mapped.body);
    }

    try {
      const confined = await confineProjectPath(res, parsed.data.projectPath);
      if (confined.refused) return confined.refused;
      // The door DOR-467 closed. `marketplace.uninstall` is the one `destructive`
      // capability, and this route used to remove a package with no tier check,
      // no approval and no attribution — which is what `dorkos uninstall`, the
      // verb the seeded skill pack taught every agent, rides.
      //
      // The arguments are gated in the capability's own schema shape, so the
      // approval a person grants here binds to the same hash `dorkos call
      // marketplace.uninstall` would produce: a token minted on one surface is
      // honored on the other, and neither can be replayed for a different action.
      const decision = authorize(req, res, 'marketplace.uninstall', {
        name: req.params.name,
        ...parsed.data,
      });
      if (decision.outcome !== 'allowed') return gateResponse(res, decision);
      const result = await uninstallFlow.uninstall({
        name: req.params.name,
        ...parsed.data,
        ...(confined.projectPath !== undefined && { projectPath: confined.projectPath }),
      });
      // Resolved name, not the raw route param — see the install route (DOR-264).
      onPluginsChanged?.({
        projectPath: parsed.data.projectPath,
        packageName: result.packageName,
        action: 'uninstall',
      });
      return res.json(result);
    } catch (err) {
      logger.error(`[Marketplace] Failed to uninstall package ${req.params.name}`, err);
      const mapped = mapErrorToStatus(err);
      return res.status(mapped.status).json(mapped.body);
    }
  });

  // POST /packages/:name/update -- advisory update check (pass apply:true to apply)
  router.post('/packages/:name/update', async (req, res) => {
    const parsed = UpdateRequestBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: z.flattenError(parsed.error) });
    }

    try {
      const confined = await confineProjectPath(res, parsed.data.projectPath);
      if (confined.refused) return confined.refused;
      // Only an APPLIED update is an effect. Without `apply` this route reports
      // what a newer version would change and touches nothing, so gating it would
      // be gating a read. An applied update reinstalls the package in place
      // (`MarketplaceInstaller.update` = uninstall then install), which is why it
      // is authorized as `marketplace.install` rather than under an id of its own.
      if (parsed.data.apply) {
        const decision = authorize(req, res, 'marketplace.install', {
          name: req.params.name,
          ...(parsed.data.projectPath !== undefined && { projectPath: parsed.data.projectPath }),
        });
        if (decision.outcome !== 'allowed') return gateResponse(res, decision);
      }
      const result = await updateFlow.run({
        name: req.params.name,
        ...parsed.data,
        ...(confined.projectPath !== undefined && { projectPath: confined.projectPath }),
      });
      // An applied in-place update reinstalls the package, so its skills and
      // commands may have changed: treat it like an install for projection +
      // command-cache refresh, matching the install/uninstall routes. Advisory
      // checks (no apply, empty `applied`) change nothing and stay silent.
      // One event per applied result, each carrying its RESOLVED manifest name
      // (never the raw route param, which may be empty or an identifier —
      // DOR-264); a bulk `apply` can reinstall several packages.
      for (const applied of result.applied) {
        onPluginsChanged?.({
          projectPath: parsed.data.projectPath,
          packageName: applied.packageName,
          action: 'install',
        });
      }
      return res.json(result);
    } catch (err) {
      logger.error(`[Marketplace] Failed to update package ${req.params.name}`, err);
      const mapped = mapErrorToStatus(err);
      return res.status(mapped.status).json(mapped.body);
    }
  });

  return router;
}

/**
 * Aggregate package entries from every enabled marketplace source into a
 * single flat list, tagging each entry with its origin marketplace name.
 * A single marketplace fetch failure is logged and skipped so one broken
 * source never blocks the whole listing.
 *
 * On completion, logs an info summary of `source → plugin count` for
 * every source — including zero-count sources — so the "empty results"
 * case is self-explanatory in logs without having to grep for warnings.
 */
async function aggregatePackages(
  sources: MarketplaceSource[],
  fetcher: PackageFetcher
): Promise<AggregatedPackage[]> {
  const results: AggregatedPackage[] = [];
  const breakdown: Record<string, number | string> = {};
  for (const source of sources) {
    try {
      const [json, sidecar] = await Promise.all([
        fetcher.fetchMarketplaceJson(source),
        fetcher.fetchDorkosSidecar(source),
      ]);
      const { entries, orphans } = mergeMarketplace(json, sidecar);
      if (orphans.length > 0) {
        logger.warn('[Marketplace] Orphan sidecar entries', {
          marketplace: source.name,
          orphans,
        });
      }
      for (const entry of entries) {
        results.push(flattenMergedEntry(entry, source.name, source.source));
      }
      breakdown[source.name] = entries.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      breakdown[source.name] = `error: ${message}`;
      logger.warn(`[Marketplace] Failed to fetch marketplace for ${source.name}: ${message}`);
    }
  }
  logger.info('[Marketplace] Aggregated packages from enabled sources', {
    totalPlugins: results.length,
    sourceCount: sources.length,
    perSource: breakdown,
  });
  return results;
}

/**
 * Convert a {@link PluginSource} discriminated union into a giget-compatible
 * template reference string.
 *
 * Handles all five source forms:
 * - **Relative path** (string starting with `./`) — resolved against the
 *   marketplace source URL. E.g. marketplace `https://github.com/dork-labs/marketplace`
 *   + source `./plugins/security-auditor` → `github:dork-labs/marketplace/plugins/security-auditor`.
 * - **GitHub** — `github:owner/repo`
 * - **URL** — the clone URL as-is
 * - **Git subdir** — the clone URL as-is (subpath handled at install time)
 * - **npm** — not supported for template download; passes `npm:<package>` so
 *   downstream callers produce a clear error rather than a cryptic git failure.
 *
 * @internal Exported for testing only.
 */
export function resolvePackageSource(entrySource: PluginSource, marketplaceUrl: string): string {
  // String source = relative path (e.g. `./plugins/foo`) or bare name
  if (typeof entrySource === 'string') {
    if (!entrySource.startsWith('./') && !entrySource.startsWith('../')) return entrySource;

    const ghMatch = marketplaceUrl.match(/github\.com\/([^/]+\/[^/.]+)/);
    if (!ghMatch) return entrySource; // Can't resolve — pass through as-is

    const orgRepo = ghMatch[1];
    const subpath = entrySource.replace(/^\.\//, '');
    return `github:${orgRepo}/${subpath}`;
  }

  // Object source — dispatch on discriminator
  switch (entrySource.source) {
    case 'github':
      return `github:${entrySource.repo}`;
    case 'url':
      return entrySource.url;
    case 'git-subdir':
      return entrySource.url;
    case 'npm':
      return `npm:${entrySource.package}`;
  }
}

/**
 * Flatten a {@link MergedMarketplaceEntry} (CC fields + nested DorkOS sidecar)
 * into the flat {@link AggregatedPackage} shape expected by the client.
 */
function flattenMergedEntry(
  entry: MergedMarketplaceEntry,
  marketplace: string,
  marketplaceUrl: string
): AggregatedPackage {
  return {
    name: entry.name,
    displayName: entry.dorkos?.displayName,
    source: resolvePackageSource(entry.source, marketplaceUrl),
    description: entry.description,
    version: entry.version,
    author: typeof entry.author === 'object' ? entry.author?.name : undefined,
    homepage: entry.homepage,
    repository: entry.repository,
    license: entry.license,
    keywords: entry.keywords,
    categories: entry.dorkos?.categories,
    // Primary category prefers the sidecar's categories[0], falling back to the
    // CC-inline singular category so single-category consumers keep working.
    category: primaryCategory(entry.dorkos?.categories, entry.category),
    tags: entry.tags,
    type: entry.dorkos?.type,
    // Gated on type so the AggregatedPackage contract ("present only for
    // adapter packages") is enforced here, not merely documented — a sidecar
    // that sets adapterType on a non-adapter entry does not leak it downstream.
    adapterType: entry.dorkos?.type === 'adapter' ? entry.dorkos.adapterType : undefined,
    icon: entry.dorkos?.icon,
    featured: entry.dorkos?.featured,
    marketplace,
  };
}

/** Compute counts + total size of the marketplace cache. */
async function computeCacheStatus(cache: MarketplaceCache): Promise<{
  marketplaces: number;
  packages: number;
  totalSizeBytes: number;
}> {
  const marketplacesRoot = join(cache.cacheRoot, 'marketplaces');
  const marketplaceDirs = await safeReaddir(marketplacesRoot);
  const packages = await cache.listPackages();

  const [marketplacesBytes, packagesBytes] = await Promise.all([
    sumDirectorySize(marketplacesRoot),
    sumPackageSizes(packages),
  ]);

  return {
    marketplaces: marketplaceDirs.length,
    packages: packages.length,
    totalSizeBytes: marketplacesBytes + packagesBytes,
  };
}

/** Sum the recursive size of every file under `root`. Returns 0 if absent. */
async function sumDirectorySize(root: string): Promise<number> {
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = join(dir, entry);
      try {
        const info = await stat(entryPath);
        if (info.isDirectory()) {
          await walk(entryPath);
        } else if (info.isFile()) {
          total += info.size;
        }
      } catch {
        // Race with prune/clear — skip silently.
      }
    }
  };
  await walk(root);
  return total;
}

/** Sum the recursive size of every cached package directory. */
async function sumPackageSizes(packages: CachedPackage[]): Promise<number> {
  let total = 0;
  for (const pkg of packages) {
    total += await sumDirectorySize(pkg.path);
  }
  return total;
}

/** `fs.readdir` that swallows ENOENT so callers can walk optional trees. */
async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Hard cap on the README payload the detail endpoint returns (200 KB). READMEs
 * are a preview surface, not a source of truth — at most this many bytes are
 * ever read from disk, so a pathological file cannot balloon server memory.
 */
const MAX_README_BYTES = 200 * 1024;

/**
 * Read a package's root `README.md` from its staged directory for the detail
 * endpoint. The match is case-insensitive (`README.md`, `readme.md`, …) and
 * restricted to the package root — nested READMEs are ignored. The package is
 * already cloned locally by the installer's preview step, so this is a pure
 * filesystem read with no network access.
 *
 * Staged packages are third-party content from ANY user-added marketplace, so
 * the read is hardened:
 *
 * - **Symlinked READMEs are treated as absent.** Clones preserve symlinks, so
 *   a malicious package could otherwise commit `README.md` as a link to a
 *   sensitive file (e.g. `~/.dork/config.json`) and exfiltrate its contents at
 *   detail-view time — before any install consent. `lstat` never follows links.
 * - **The read itself is bounded.** At most {@link MAX_README_BYTES} are read
 *   through a `FileHandle` into a preallocated buffer — an attacker-sized
 *   README never loads fully into memory.
 * - **Truncation is UTF-8 safe.** A byte-offset cut can split a multibyte
 *   character; any trailing partial sequence is dropped so the payload never
 *   ends in a U+FFFD replacement glyph.
 *
 * Returns `undefined` when no README exists, the entry is not a regular file,
 * or the content is empty/whitespace, so the caller can omit the field
 * entirely. Read errors are swallowed — the detail endpoint never fails over
 * a preview.
 *
 * @param packagePath - Absolute path to the staged package directory.
 */
async function readPackageReadme(packagePath: string): Promise<string | undefined> {
  const entries = await safeReaddir(packagePath);
  const match = entries.find((entry) => entry.toLowerCase() === 'readme.md');
  if (!match) return undefined;
  const readmePath = join(packagePath, match);
  try {
    // lstat never follows links — anything but a regular file is rejected.
    const meta = await lstat(readmePath);
    if (!meta.isFile()) return undefined;

    const handle = await open(readmePath, 'r');
    try {
      // Size from the open handle (not the earlier lstat) so the bound and the
      // read refer to the same inode.
      const { size } = await handle.stat();
      const length = Math.min(size, MAX_README_BYTES);
      if (length === 0) return undefined;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      // Only a cap-truncated read can split a character mid-sequence; a file
      // read in full keeps whatever bytes it genuinely contains.
      const end = size > bytesRead ? trimPartialUtf8Tail(buffer, bytesRead) : bytesRead;
      const text = buffer.subarray(0, end).toString('utf8');
      return text.trim().length === 0 ? undefined : text;
    } finally {
      await handle.close();
    }
  } catch {
    // A README that vanished or is unreadable between the readdir and the read
    // is treated as absent — the detail endpoint never fails over a preview.
    return undefined;
  }
}

/**
 * Drop a trailing partial UTF-8 sequence from `buffer[0, length)`.
 *
 * A byte-offset truncation can land mid-character; decoding that tail would
 * emit a U+FFFD replacement glyph. Walks back over at most three continuation
 * bytes to the final lead byte and drops the sequence when its continuation
 * bytes were cut off. Bytes that were already invalid UTF-8 are left as-is —
 * this only repairs damage done by the cap.
 *
 * @param buffer - The bytes that were read.
 * @param length - Number of valid bytes in `buffer`.
 * @returns The largest end offset that does not end in a split sequence.
 */
function trimPartialUtf8Tail(buffer: Buffer, length: number): number {
  let i = length - 1;
  const floor = Math.max(0, length - 4);
  // Walk back over continuation bytes (0b10xxxxxx) to the sequence's lead byte.
  while (i >= floor && (buffer[i] & 0xc0) === 0x80) i--;
  // Four continuation bytes in a row, or an ASCII/continuation byte where a
  // lead should be: the content was never valid UTF-8 there — leave it alone.
  if (i < floor || buffer[i] < 0x80) return length;
  const lead = buffer[i];
  let expected: number;
  if ((lead & 0xe0) === 0xc0) expected = 2;
  else if ((lead & 0xf0) === 0xe0) expected = 3;
  else if ((lead & 0xf8) === 0xf0) expected = 4;
  else return length; // Stray continuation/invalid lead — the file's own bytes.
  return length - i >= expected ? length : i;
}
