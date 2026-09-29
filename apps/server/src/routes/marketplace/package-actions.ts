/**
 * Marketplace routes: `/packages/:name/{preview,install,check-files,uninstall,update}`: act on one package.
 *
 * @module routes/marketplace/package-actions
 */
import { z } from 'zod';
import type { PackageType } from '@dorkos/marketplace';
import { logger } from '../../lib/logger.js';
import {
  DisclosedEffectsSchema,
  disclosedEffectsOf,
} from '../../services/marketplace/preview/disclosed-effects.js';
import type { ApprovedPackage } from '../../services/marketplace/consent/global-plugin-consent.js';
import { packageContentHash } from '../../services/marketplace/lib/content-hash.js';
import { PackageNotInstalledError } from '../../services/marketplace/flows/uninstall/support.js';
import {
  installationUpdateName,
  PackageNotInstalledForUpdateError,
  pickInstallation,
} from '../../services/marketplace/flows/update-selection.js';
import { assertPackageName } from '../../services/marketplace/lib/package-paths.js';
import { locateInstallRoot } from '../../services/marketplace/lib/locate-install.js';
import { scanInstallationRecords } from '../../services/marketplace/installed-scanner.js';
import { trustedCaller } from '../../services/core/capabilities/index.js';
import { resolveDecisionAuthority } from '../../services/core/approvals/index.js';
import { OPERATOR_COOKIE_REQUIRED_CODE, readCallerAuthority } from '../../lib/caller-authority.js';
import {
  KeptFilesChangedError,
  keepPackageFiles,
} from '../../services/marketplace/lib/integrity/keep-files.js';
import {
  describeStrictRebuild,
  rebuildRecordStrict,
} from '../../services/marketplace/lib/integrity/strict-record.js';
import type { MarketplaceRouteDeps } from '../marketplace.js';
import type { MarketplaceRouteContext } from './context.js';
import { InstallRequestBodySchema, mapErrorToStatus, outdatedClientResponse } from './shared.js';
import type { Router } from 'express';

/** Body schema for `POST /api/marketplace/packages/:name/uninstall`. */
const UninstallRequestBodySchema = z.object({
  purge: z.boolean().optional(),
  projectPath: z.string().optional(),
});

/**
 * Body schema for `POST /api/marketplace/packages/:name/check-files` (DOR-2320).
 * `installRoot` narrows the lookup to one installation the caller already
 * sees; it can never widen it past what the name and scope would find.
 */
const CheckFilesRequestBodySchema = z.object({
  projectPath: z.string().optional(),
  installRoot: z.string().optional(),
});

/**
 * Body schema for `POST /api/marketplace/packages/:name/update`: an advisory
 * check, nothing else. Strict, so the retired `apply` is refused with a 400
 * rather than silently read as a check: an update is applied only through
 * `POST /updates`, which shows what it runs first (DOR-2306).
 */
const UpdateRequestBodySchema = z
  .object({
    projectPath: z.string().optional(),
  })
  .strict();

/**
 * Body schema for `POST /api/marketplace/packages/:name/keep-files` (DOR-2341):
 * the key and, for a held-back global package, the review exactly as the
 * person was shown them.
 */
const KeepFilesRequestBodySchema = z
  .object({
    projectPath: z.string().optional(),
    installRoot: z.string().optional(),
    keepKey: z.string().min(1),
    review: z.object({ effects: DisclosedEffectsSchema, bindsTo: z.string().min(1) }).optional(),
  })
  .strict();

/**
 * Register the `/packages/:name/{preview,install,check-files,keep-files,uninstall,update}` routes on
 * the marketplace router.
 *
 * @param router - The marketplace router.
 * @param deps - The router's injected dependencies.
 * @param ctx - The helpers every route group shares.
 */
export function mountPackageActionRoutes(
  router: Router,
  deps: MarketplaceRouteDeps,
  ctx: MarketplaceRouteContext
): void {
  const {
    fetcher,
    installer,
    uninstallFlow,
    updateFlow,
    dorkHome,
    onPluginsChanged,
    listAgentScopes,
    consent,
    heldBackCards,
  } = deps;
  const { authorize, gateResponse, confineProjectPath, askAboutAgentInstall } = ctx;

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
      // `disclosed` is what an install is held to and `contentHash` the files
      // it binds: the caller shows them and sends them back as
      // `approvedDisclosure` and `approvedContentHash` (DOR-2306).
      return res.json({
        preview,
        manifest,
        packagePath,
        disclosed: disclosedEffectsOf(preview),
        contentHash: await packageContentHash(packagePath),
      });
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
      const decision = await authorize(req, res, 'marketplace.install', {
        name: req.params.name,
        ...(parsed.data.marketplace !== undefined && { marketplace: parsed.data.marketplace }),
        ...(parsed.data.projectPath !== undefined && { projectPath: parsed.data.projectPath }),
      });
      if (decision.outcome !== 'allowed') return gateResponse(res, decision);
      const { approvedDisclosure, approvedContentHash, confirmationToken, ...request } =
        parsed.data;
      const global = confined.projectPath === undefined;
      let approved: ApprovedPackage | undefined;
      let heldTo = approvedDisclosure;
      let heldToFiles: string | undefined;
      let heldToType: PackageType | undefined;
      if (trustedCaller(readCallerAuthority(req, res))) {
        // The person saw what it runs and which files: the installer holds the
        // install to the disclosure, and consent records it only when the
        // installed copy hashes the same (DOR-2306).
        if (approvedDisclosure && approvedContentHash) {
          approved = { disclosed: approvedDisclosure, contentHash: approvedContentHash };
        }
      } else {
        // An agent's global install can load into every session, and an agent
        // package lands in a folder whose sessions run its skills, wherever
        // the call was scoped: both wait on a card (DOR-2306, DOR-2325).
        const asked = await askAboutAgentInstall(
          req,
          res,
          {
            ...request,
            ...(confined.projectPath !== undefined && { projectPath: confined.projectPath }),
          },
          confirmationToken,
          global
        );
        if ('refused' in asked) return asked.refused;
        // Held to the files and the type the preview fetched, card or not: the
        // install is a second fetch, and a source that serves something else
        // to it is refused before anything lands (DOR-2325).
        heldToFiles = asked.contentHash;
        heldToType = asked.packageType;
        if (!('unasked' in asked)) {
          approved = asked.approved;
          // Held to what was previewed either way: a source that changes what
          // it runs before the install lands is refused, card or not.
          heldTo = asked.previewed;
        }
      }
      const result = await installer.install({
        name: req.params.name,
        ...request,
        ...(heldTo !== undefined && { approvedDisclosure: heldTo }),
        ...(heldToFiles !== undefined && { approvedContentHash: heldToFiles }),
        ...(heldToType !== undefined && { approvedPackageType: heldToType }),
        ...(confined.projectPath !== undefined && { projectPath: confined.projectPath }),
      });
      // After the install landed, never before: a failed install records nothing.
      await consent.settle(
        { installPath: result.installPath, type: result.type, global },
        approved
      );
      // Report the RESOLVED manifest name, never the raw `:name` route param.
      // For `dorkos install ./local/path` or `github:user/repo` the param is
      // an install identifier, not the package name, and consumers (Harness
      // Sync auto-projection) look up `.dork/plugins/<packageName>` (DOR-264).
      onPluginsChanged({
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
  // POST /packages/:name/check-files -- give an install an older DorkOS made its
  // installed-files record, from the exact commit it was installed at, or say
  // why not (DOR-2320). Not tier-gated, on purpose: it writes only a record
  // that must match the live files byte for byte, so it cannot change what
  // runs or claim any file that is not the package's; like refreshing a
  // source, it only brings DorkOS's own bookkeeping up to date.
  router.post('/packages/:name/check-files', async (req, res) => {
    const parsed = CheckFilesRequestBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: z.flattenError(parsed.error) });
    }
    try {
      assertPackageName(req.params.name);
    } catch (err) {
      const mapped = mapErrorToStatus(err);
      return res.status(mapped.status).json(mapped.body);
    }
    try {
      const confined = await confineProjectPath(res, parsed.data.projectPath);
      if (confined.refused) return confined.refused;
      const root = await locateInstallRoot({
        dorkHome,
        name: req.params.name,
        ...(confined.projectPath !== undefined && { projectPath: confined.projectPath }),
        ...(parsed.data.installRoot !== undefined && { installRoot: parsed.data.installRoot }),
      });
      if (root === null) throw new PackageNotInstalledError(req.params.name);
      // A person's Check files also sorts what an update kept unproven (DOR-2322).
      const result = await rebuildRecordStrict(root, { fetcher, logger }, { sortUnproven: true });
      return res.json({
        outcome: result.outcome,
        message: describeStrictRebuild(req.params.name, result),
      });
    } catch (err) {
      const mapped = mapErrorToStatus(err);
      if (mapped.status >= 500) {
        logger.error(`[Marketplace] Failed to check the files of ${req.params.name}`, err);
      }
      return res.status(mapped.status).json(mapped.body);
    }
  });

  // POST /packages/:name/keep-files -- a person's "Keep these as mine" for the
  // files an update kept but nothing could sort (DOR-2341). The same bar as
  // deciding a held-back package: claiming files decides what every later
  // update keeps, so an agent cannot, and under login only a signed-in session
  // can. Moves and deletes nothing; see `services/marketplace/lib/integrity/keep-files.ts`.
  router.post('/packages/:name/keep-files', async (req, res) => {
    const authority = readCallerAuthority(req, res);
    if (!trustedCaller(authority)) {
      if (!resolveDecisionAuthority(authority).allowed) {
        return res.status(403).json({
          error: 'Only you can keep these files as yours, not an agent.',
          code: 'operator_only',
        });
      }
      return res.status(403).json({
        error:
          'DorkOS requires sign-in, so a person signed in to the app has to do this. Open ' +
          'DorkOS, go to Marketplace, then Installed, and press Keep these as mine on the package.',
        code: OPERATOR_COOKIE_REQUIRED_CODE,
      });
    }
    const parsed = KeepFilesRequestBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: z.flattenError(parsed.error) });
    }
    try {
      assertPackageName(req.params.name);
      const confined = await confineProjectPath(res, parsed.data.projectPath);
      if (confined.refused) return confined.refused;
      const root = await locateInstallRoot({
        dorkHome,
        name: req.params.name,
        ...(confined.projectPath !== undefined && { projectPath: confined.projectPath }),
        ...(parsed.data.installRoot !== undefined && { installRoot: parsed.data.installRoot }),
      });
      if (root === null) throw new PackageNotInstalledError(req.params.name);
      const global = confined.projectPath === undefined;
      const result = await keepPackageFiles({
        dorkHome,
        root,
        name: req.params.name,
        global,
        keepKey: parsed.data.keepKey,
        ...(global && parsed.data.review && { review: parsed.data.review }),
      });
      if (result.approved) await heldBackCards.onGranted();
      return res.json(result);
    } catch (err) {
      if (err instanceof KeptFilesChangedError) {
        return res.status(409).json({ error: err.message, code: 'kept_files_changed' });
      }
      const mapped = mapErrorToStatus(err);
      if (mapped.status >= 500) {
        logger.error(`[Marketplace] Failed to keep the files of ${req.params.name}`, err);
      }
      return res.status(mapped.status).json(mapped.body);
    }
  });

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
      const decision = await authorize(req, res, 'marketplace.uninstall', {
        name: req.params.name,
        ...parsed.data,
      });
      if (decision.outcome !== 'allowed') return gateResponse(res, decision);
      const result = await uninstallFlow.uninstall({
        name: req.params.name,
        ...parsed.data,
        ...(confined.projectPath !== undefined && { projectPath: confined.projectPath }),
      });
      // A removed global package's approvals go with it, so the same bytes put
      // back later are asked about again (DOR-2306).
      if (confined.projectPath === undefined) consent.removed(result.packageName);
      // Resolved name, not the raw route param — see the install route (DOR-264).
      onPluginsChanged({
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

  // POST /packages/:name/update -- advisory update check of one package.
  //
  // Advisory only. Applying an update goes through `POST /updates`, whose body
  // carries what the person was shown each new version runs (DOR-2306); this
  // body schema is strict, so a retired `apply: true` is a 400, never a check
  // that a caller mistakes for an update.
  router.post('/packages/:name/update', async (req, res) => {
    if ((req.body as { apply?: unknown } | undefined)?.apply === true) {
      return outdatedClientResponse(res);
    }
    const parsed = UpdateRequestBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: z.flattenError(parsed.error) });
    }

    try {
      const confined = await confineProjectPath(res, parsed.data.projectPath);
      if (confined.refused) return confined.refused;
      const name = req.params.name;
      // The flow checks one installation in this request's scope, so it cannot
      // tell "installed in another scope" (a scoped `unknown` result) from
      // "installed nowhere". The route can see every scope, so it answers the
      // second as a 404. Without a project, the scope is the global slice of the
      // every-scope scan, so nothing is walked twice.
      const everywhere = await scanInstallationRecords(dorkHome, {
        agents: listAgentScopes?.() ?? [],
      });
      const inScope = confined.projectPath
        ? await scanInstallationRecords(dorkHome, { projectPath: confined.projectPath })
        : everywhere.filter((r) => r.package.scope === 'global');
      if (![...everywhere, ...inScope].some((r) => installationUpdateName(r) === name)) {
        throw new PackageNotInstalledForUpdateError(name);
      }
      return res.json(
        await updateFlow.run({ name, installation: pickInstallation(inScope, name) })
      );
    } catch (err) {
      logger.error(`[Marketplace] Failed to check package ${req.params.name} for updates`, err);
      const mapped = mapErrorToStatus(err);
      return res.status(mapped.status).json(mapped.body);
    }
  });
}
