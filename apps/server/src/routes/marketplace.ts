/**
 * Marketplace management routes -- sources, cache status, installed
 * package listing, plus package discovery/preview/install/uninstall/update
 * and the all-packages update check under `/api/marketplace/*`.
 *
 * The router is constructed via a factory that injects its dependencies
 * (source manager, cache, fetcher, installer, uninstall flow, update flow,
 * dorkHome) so the same factory can be exercised under supertest without
 * touching the real filesystem.
 *
 * @module routes/marketplace
 */
import { Router, type Request, type Response } from 'express';
import { lstat, open, readdir } from 'node:fs/promises';
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
import type { MarketplaceCache } from '../services/marketplace/marketplace-cache.js';
import {
  UnreadableInstallsError,
  type PackageCacheRetention,
} from '../services/marketplace/package-cache-retention.js';
import { directorySize } from '../services/marketplace/lib/directory-size.js';
import type { MarketplaceSourceManager } from '../services/marketplace/marketplace-source-manager.js';
import type { PackageFetcher } from '../services/marketplace/package-fetcher.js';
import type { InstallerLike } from '../services/marketplace/marketplace-installer.js';
import {
  ConflictError,
  DisclosureChangedError,
  InvalidPackageError,
} from '../services/marketplace/marketplace-installer.js';
import {
  DisclosedEffectsSchema,
  disclosedEffectsOf,
} from '../services/marketplace/disclosed-effects.js';
import {
  activationEffectsOf,
  globalPackageDir,
  globalPackageExists,
  GLOBALLY_ACTIVATED_TYPES,
  type ApprovedPackage,
  type GlobalConsentRecorder,
} from '../services/marketplace/global-plugin-consent.js';
import {
  packageContentHash,
  ShipsRuntimeStateError,
  TreeUnhashableError,
} from '../services/marketplace/lib/content-hash.js';
import {
  decideHeldBackPackage,
  HeldBackDecisionError,
  HeldBackReviewError,
  listHeldBackPackages,
  reviewHeldBackPackage,
  type AskAboutWithheldGlobalPluginsOptions,
} from '../services/marketplace/ask-withheld-global-plugins.js';
import { disclosesAnything, type DisclosedEffects } from '@dorkos/shared/marketplace-schemas';
import type {
  ConfirmationProvider,
  ConfirmationRequest,
} from '../services/marketplace-mcp/confirmation-provider.js';
import {
  PackageNotFoundError,
  MarketplaceNotFoundError,
} from '../services/marketplace/package-resolver.js';
import {
  PackageNotInstalledError,
  type UninstallFlow,
} from '../services/marketplace/flows/uninstall.js';
import { UnsupportedSourceUrlError } from '../services/marketplace/source-url-policy.js';
import {
  GitCommitNotFoundError,
  GitFetchError,
  GitRefNotFoundError,
  GitRemoteUnreachableError,
} from '../services/marketplace/lib/git-tree.js';
import type { UpdateFlow } from '../services/marketplace/flows/update.js';
import {
  installationUpdateName,
  PackageNotInstalledForUpdateError,
  pickInstallation,
  selectInstallations,
} from '../services/marketplace/flows/update-selection.js';
import {
  applyApprovedUpdates,
  checkInstalledUpdates,
  reinstallInputsFor,
  scanUpdateView,
  updatesNotAsShown,
  type ApprovableUpdate,
  type InstalledUpdatesDeps,
} from '../services/marketplace/flows/update-installed.js';
import {
  assertPackageName,
  MarketplacePathError,
  PathEscapeError,
} from '../services/marketplace/lib/package-paths.js';
import { locateInstallRoot } from '../services/marketplace/lib/locate-install.js';
import {
  installCountsProvider,
  enrichWithInstallCounts,
} from '../services/marketplace/install-counts.js';
import { updatedAtProvider, enrichWithUpdatedAt } from '../services/marketplace/updated-at.js';
import type { MarketplaceSource, NotifyPluginsChanged } from '../services/marketplace/types.js';
import {
  scanInstallationRecords,
  scanInstallationsAcrossScopes,
  computeProvides,
  type AgentScopeRef,
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
import { OPERATOR_COOKIE_REQUIRED_CODE, readCallerAuthority } from '../lib/caller-authority.js';
import {
  OPERATOR_ONLY_MARKETPLACE_SOURCE_CODE,
  describeMarketplaceSourceRefusal,
  marketplaceSourceRefusalError,
  type MarketplaceSourceAction,
} from '../services/marketplace/source-write-policy.js';
import { withIntegrity } from '../services/marketplace/lib/integrity/verify-install.js';
import {
  describeStrictRebuild,
  rebuildRecordStrict,
} from '../services/marketplace/lib/integrity/strict-record.js';

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
  /** The package cache's retention owner; `POST /cache/prune` runs its sweep. */
  cacheRetention: PackageCacheRetention;
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
   * Fired after a successful install, uninstall or applied update. Carries the
   * change context (which package, which action, and the project root for a
   * project-scoped change) so the handler can both refresh the runtime plugin
   * cache and project the plugin's assets to the project's other harnesses
   * (Harness Sync auto-projection, GAP-4). `projectPath` is `undefined` for a
   * global install/uninstall. Required, and the same notifier the marketplace
   * MCP tools receive, so neither surface can skip it (DOR-2057).
   */
  onPluginsChanged: NotifyPluginsChanged;
  /**
   * The server's one marketplace confirmation provider, shared with the MCP
   * tools: an agent's update over HTTP raises the same approval card, bound
   * the same way, as `marketplace_update` does (DOR-2306).
   */
  confirmationProvider: ConfirmationProvider;
  /**
   * Records a person's approval of what a global package runs, where they gave
   * it (their own install or update), so it loads into sessions without a
   * second card (`global-plugin-consent.ts`, DOR-2306).
   */
  consent: GlobalConsentRecorder;
  /**
   * How a held-back global package's card is raised when a person asks for it
   * (the Installed view's Review button), and what runs after a yes: the
   * approval primitive and the plugin refresh (DOR-2306).
   */
  heldBackCards: Pick<AskAboutWithheldGlobalPluginsOptions, 'approvals' | 'onGranted'>;
  /**
   * List the registered agents whose project directories the cross-scope
   * installed scan should walk (typically `meshCore.listWithPaths()`). When
   * absent — mesh disabled or not yet initialized — the installed listing
   * falls back to global scopes only.
   */
  listAgentScopes?: () => AgentScopeRef[];
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
  // What the person was shown the package runs (the preview's `disclosed`),
  // sent back untouched. The install refuses a package that now runs anything
  // else (DOR-2306); preview ignores it.
  approvedDisclosure: DisclosedEffectsSchema.optional(),
  // The preview's `contentHash`, sent back with the disclosure: a global
  // package loads into sessions only when its installed copy hashes the same.
  approvedContentHash: z.string().min(1).optional(),
  // An agent's install of a global package that runs anything waits on an
  // approval card; the retry carries its token (DOR-2306).
  confirmationToken: z.string().min(1).optional(),
});

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

/** Body schema for `POST /api/marketplace/held-back/:name/decision`. */
const HeldBackDecisionBodySchema = z
  .object({
    decision: z.enum(['allow', 'refuse']),
    // Exactly as `GET /held-back` listed them: what it runs, and what the
    // decision binds (an install's recorded hash, or `linked:<path>`).
    effects: DisclosedEffectsSchema,
    bindsTo: z.string().min(1),
  })
  .strict();

/** Machine-readable code on the 403 for a batch that would need approval per install. */
const BATCH_UPDATE_NEEDS_APPROVAL_CODE = 'batch_update_needs_approval';

/**
 * Machine-readable code on the 409 when what a package runs is not what the
 * caller was shown: an update whose new version moved since the check, or an
 * install whose package changed since the preview (DOR-2306).
 */
const DISCLOSURE_CHANGED_CODE = 'disclosure_changed';

/**
 * Body schema for `POST /api/marketplace/cache/prune`: no options. Strict, so
 * the retired `keepLastN` is refused rather than silently ignored.
 */
const PruneCacheBodySchema = z.object({}).strict();

/** Query schema for `GET /api/marketplace/packages/:name`. */
const GetPackageQuerySchema = z.object({
  marketplace: z.string().optional(),
});

/**
 * Whether a list request asked for each install's integrity (`?verify=true`,
 * DOR-2197). Opt-in, because verifying hashes every shipped file.
 *
 * @param req - The request.
 */
function wantsVerify(req: Request): boolean {
  return req.query.verify === 'true';
}

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
  // A package that ships DorkOS's own settings, secrets or records path, or a file
  // whose bytes cannot be pinned: refused before anything is written, and the
  // message says which path (DOR-2306). Package-relative, so nothing about
  // where it was staged leaks.
  if (err instanceof ShipsRuntimeStateError || err instanceof TreeUnhashableError) {
    return { status: 400, body: { error: err.message } };
  }
  // The package that resolved for the install is not the one the person was
  // shown. Nothing was written; the next move is to look again.
  if (err instanceof DisclosureChangedError) {
    return { status: 409, body: { error: err.message, code: DISCLOSURE_CHANGED_CODE } };
  }
  if (err instanceof PackageNotInstalledError) {
    return { status: 404, body: { error: err.message } };
  }
  if (err instanceof PackageNotInstalledForUpdateError) {
    return {
      status: 404,
      body: { error: err.message, packageNames: err.packageNames, installPaths: err.installPaths },
    };
  }
  if (err instanceof PackageNotFoundError) {
    return { status: 404, body: { error: err.message } };
  }
  if (err instanceof MarketplaceNotFoundError) {
    return { status: 404, body: { error: err.message } };
  }
  // A configured marketplace whose address is not one we will hand to `git`
  // (DOR-1710). Its message is written for the person reading it and says which
  // forms do work, so it goes back verbatim.
  if (err instanceof UnsupportedSourceUrlError) {
    return { status: 400, body: { error: err.message } };
  }
  // Git's own failures (DOR-2248). A branch, tag or commit the repository does
  // not have is a not-found; a remote that could not be reached, or a fetch that
  // failed or could not be verified, is the upstream's fault — a bad gateway.
  // Each message already says what went wrong in words, and names the remote
  // without credentials, so it goes back verbatim.
  if (err instanceof GitRefNotFoundError || err instanceof GitCommitNotFoundError) {
    return { status: 404, body: { error: err.message } };
  }
  if (err instanceof GitRemoteUnreachableError || err instanceof GitFetchError) {
    return { status: 502, body: { error: err.message } };
  }
  return {
    status: 500,
    body: { error: err instanceof Error ? err.message : String(err) },
  };
}

/** Machine-readable code for a request only an older dorkos CLI sends. */
const OUTDATED_CLIENT_CODE = 'client_outdated';

/**
 * Whether a `POST /updates` body is one only an older client sends: an apply
 * with no `targets`, or with the retired `names` / `installPaths` selectors.
 */
function fromOutdatedClient(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return b.apply === true && (!('targets' in b) || 'names' in b || 'installPaths' in b);
}

/**
 * Answer a request from a client older than this server with a sentence that
 * says what to do, instead of a schema error (DOR-2306): updates now show what
 * each new version runs before anything is applied, which an old client cannot.
 */
function outdatedClientResponse(res: Response): Response {
  return res.status(400).json({
    error:
      'This dorkos CLI is older than the DorkOS it is talking to, so nothing was updated. ' +
      'Update the CLI (npm install -g dorkos), then run the update again: it now shows what ' +
      'each new version runs before it installs anything.',
    code: OUTDATED_CLIENT_CODE,
  });
}

/** Why `POST /updates` ran nothing, as its gate decided. */
type UpdateRefusal =
  /** What a reinstall would run now is not what the caller was shown. */
  | { kind: 'changed'; changed: ApprovableUpdate[] }
  /** A person has been asked; the caller retries with the token once they approve. */
  | { kind: 'pending'; token: string; updates: ApprovableUpdate[]; reason?: string }
  /** A person said no, or the card could not be raised honestly. */
  | { kind: 'declined'; reason: string };

/**
 * Answer a refused `POST /updates`: 409 when what would run moved since it was
 * shown, 202 while a person decides, 403 when they said no. Nothing was
 * reinstalled in any of them.
 *
 * @param res - The response to answer on.
 * @param refusal - Why the apply ran nothing.
 * @returns The sent response.
 */
function updateRefusalResponse(res: Response, refusal: UpdateRefusal): Response {
  switch (refusal.kind) {
    case 'changed':
      return res.status(409).json({
        error:
          'What an update would install is not what was shown: a newer version arrived, or the ' +
          'new version now runs something else. Nothing was changed. Check again and review it.',
        code: DISCLOSURE_CHANGED_CODE,
        changed: refusal.changed,
      });
    case 'pending':
      return res.status(202).json({
        status: 'requires_confirmation',
        confirmationToken: refusal.token,
        updates: refusal.updates,
        message:
          `${refusal.reason ? `${refusal.reason} ` : ''}A person must approve these updates in ` +
          'DorkOS before anything is reinstalled. Send the same request again with this ' +
          'confirmationToken once they have.',
      });
    case 'declined':
      return res.status(403).json({ status: 'declined', reason: refusal.reason });
  }
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
 * - `POST /packages/:name/update` — advisory update check of one package
 * - `GET /updates` — advisory update check of every installation in view, with what each new version runs
 * - `POST /updates` — reinstall exactly the installations a person was shown, held to what they saw
 *
 * @param deps - Injected dependencies (source manager, cache, fetcher,
 *   installer, uninstall flow, update flow, dorkHome).
 */
export function createMarketplaceRouter(deps: MarketplaceRouteDeps): Router {
  const {
    sourceManager,
    cache,
    cacheRetention,
    fetcher,
    installer,
    uninstallFlow,
    updateFlow,
    dorkHome,
    onPluginsChanged,
    listAgentScopes,
    capabilityRegistry,
    confirmationProvider,
    consent,
    heldBackCards,
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
  const authorize = async (
    req: Request,
    res: Response,
    id: string,
    input: unknown
  ): Promise<TierEnforcementDecision> => {
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

  /** What the all-packages update door needs, shared with the MCP tools (DOR-2195). */
  const updateDeps: InstalledUpdatesDeps = {
    dorkHome,
    updateFlow,
    listAgentScopes,
    onPluginsChanged,
  };

  /**
   * Read `?projectPath` as at most one string. Express parses a repeated key as
   * an array, which used to be dropped silently and answer for every scope;
   * that is a 400 now.
   *
   * @returns `{ refused }` carrying the sent 400, or `{ projectPath }`.
   */
  const readProjectPathQuery = (
    req: Request,
    res: Response
  ): { refused: Response } | { refused?: undefined; projectPath?: string } => {
    const value = req.query.projectPath;
    if (value === undefined || typeof value === 'string') {
      return value ? { projectPath: value } : {};
    }
    return { refused: res.status(400).json({ error: 'projectPath may be given only once' }) };
  };

  /**
   * Whether `marketplace.install` could ask a person to approve this caller's
   * reinstall. A batch cannot carry one approval token per package, so a batch
   * that could need one is refused before any gate runs — calling the gate would
   * raise an approval request nobody could ever redeem.
   */
  const batchNeedsApproval = (req: Request, res: Response): boolean => {
    const tier = capabilityRegistry()?.get('marketplace.install')?.tier;
    if (tier === undefined || tier === 'observe' || tier === 'act') return false;
    return !trustedCaller(readCallerAuthority(req, res));
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
      // An address DorkOS will not fetch from. Answered here rather than left
      // to the 500 below: this is the caller's input, and the message names the
      // forms that do work. The address itself is logged rather than echoed —
      // the operator knows what they typed, and the log is where a support
      // question gets answered.
      if (err instanceof UnsupportedSourceUrlError) {
        logger.warn('[Marketplace] Refused an unsupported source address', {
          name: parsed.data.name,
          url: err.url,
        });
        return res.status(400).json({ error: err.message });
      }
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
      // "I just pushed; check again": the update check shares commit lookups
      // for a minute, and a refresh is how the operator asks it to look now.
      updateFlow.clearMemos();
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

  // GET /cache -- cache status (marketplace count, package count, total bytes,
  // and whether automatic cleanup is paused)
  router.get('/cache', async (_req, res) => {
    try {
      const status = await computeCacheStatus(cache);
      res.json({ ...status, cleanup: cacheRetention.status() });
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

  // POST /cache/prune -- remove cached packages no install needs (the same
  // sweep that runs after every fetch; see package-cache-retention.ts)
  router.post('/cache/prune', async (req, res) => {
    const parsed = PruneCacheBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: z.flattenError(parsed.error) });
    }

    try {
      const { removed, freedBytes } = await cacheRetention.sweep();
      return res.json({
        removed: removed.map((pkg) => ({
          packageName: pkg.packageName,
          commitSha: pkg.commitSha,
          path: pkg.path,
          lastUsedAt: pkg.lastUsedAt.toISOString(),
        })),
        freedBytes,
      });
    } catch (err) {
      if (err instanceof UnreadableInstallsError) {
        // Names the folder only in the log: it spells the operator's home.
        logger.warn('[Marketplace] cache prune stopped: could not read every install', {
          error: err.message,
        });
        return res.status(503).json({
          error:
            "Couldn't check every installed package, so nothing was removed. The server log names the folder it couldn't read.",
        });
      }
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
      return res.json({
        manifest,
        packagePath,
        preview,
        disclosed: disclosedEffectsOf(preview),
        // What a global install's approval binds: sent back as
        // `approvedContentHash`, and compared with the hash the installer
        // records when the package lands (DOR-2306).
        contentHash: await packageContentHash(packagePath),
        ...(readme !== undefined && { readme }),
      });
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
      if (trustedCaller(readCallerAuthority(req, res))) {
        // The person saw what it runs and which files: the installer holds the
        // install to the disclosure, and consent records it only when the
        // installed copy hashes the same (DOR-2306).
        if (approvedDisclosure && approvedContentHash) {
          approved = { disclosed: approvedDisclosure, contentHash: approvedContentHash };
        }
      } else if (global) {
        // An agent's global install can load into every session, so one that
        // runs anything, or that replaces a global package, waits on the same
        // card an agent's update does (DOR-2306).
        const asked = await askAboutAgentInstall(req, res, request, confirmationToken);
        if ('refused' in asked) return asked.refused;
        approved = asked.approved;
        // Held to what was previewed either way: a source that changes what
        // it runs before the install lands is refused, card or not.
        heldTo = asked.previewed;
      }
      const result = await installer.install({
        name: req.params.name,
        ...request,
        ...(heldTo !== undefined && { approvedDisclosure: heldTo }),
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
      const result = await rebuildRecordStrict(root, { fetcher, logger });
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

  /**
   * Preview an agent's global install and, when it runs anything on its own or
   * replaces a global package, ask a person with the card `marketplace_install`
   * raises: bound to the package, what it runs and its staged files, and
   * saying who asked, the version and where it comes from (DOR-2306).
   *
   * @returns What the install is held to, and the person's approval when a
   *   card was granted; or the response that ends the request unrun.
   */
  const askAboutAgentInstall = async (
    req: Request,
    res: Response,
    request: z.infer<typeof InstallRequestBodySchema>,
    token: string | undefined
  ): Promise<
    { refused: Response } | { previewed: DisclosedEffects | undefined; approved?: ApprovedPackage }
  > => {
    const name = String(req.params.name);
    const staged = await installer.preview({ name, ...request });
    const previewed = disclosedEffectsOf(staged.preview) ?? undefined;
    const activated = GLOBALLY_ACTIVATED_TYPES.has(staged.manifest.type);
    const replaces = await globalPackageExists(dorkHome, staged.manifest.name);
    const runs = disclosesAnything(activationEffectsOf(previewed ?? null));
    if (!activated || (!replaces && !runs)) return { previewed };

    const contentHash = await packageContentHash(staged.packagePath);
    const identity = getRequestAgentIdentity(res);
    const confirmation: ConfirmationRequest = {
      packageName: name,
      ...(request.marketplace !== undefined && { marketplace: request.marketplace }),
      operation: 'install',
      preview: staged.preview,
      contentHash,
      origin: {
        version: staged.manifest.version,
        ...((request.source ?? request.marketplace) !== undefined && {
          source: request.source ?? request.marketplace,
        }),
      },
      ...(identity && { requestedBy: identity.displayName || identity.agentPath }),
    };
    const answer = token
      ? await confirmationProvider.resolveToken(token, confirmation)
      : await confirmationProvider.requestInstallConfirmation(confirmation);
    if (answer.status === 'pending') {
      return {
        refused: res.status(202).json({
          status: 'requires_confirmation',
          confirmationToken: answer.token,
          preview: staged.preview,
          message:
            `${answer.reason ? `${answer.reason} ` : ''}A person must approve this install in ` +
            'DorkOS first: it runs things on its own in every session, or replaces a package ' +
            'that does. Send the same request again with this confirmationToken once they have.',
        }),
      };
    }
    if (answer.status === 'declined') {
      return {
        refused: res
          .status(403)
          .json({ status: 'declined', reason: answer.reason ?? 'The install was not approved.' }),
      };
    }
    return { previewed, approved: { disclosed: previewed ?? null, contentHash } };
  };

  /**
   * Ask a person about an agent's update, or resolve the card they were
   * asked with: the same confirmation `marketplace_update` raises, over the
   * same provider, so a card and its binding mean one thing on both surfaces.
   *
   * @returns `undefined` when the person approved, else the refusal.
   */
  const askAboutUpdates = async (
    updates: ApprovableUpdate[],
    token: string | undefined,
    requestedBy: string | undefined
  ): Promise<UpdateRefusal | undefined> => {
    const request: ConfirmationRequest = {
      packageName: [...new Set(updates.map((u) => u.packageName))].join(', '),
      operation: 'update',
      updates,
      ...(requestedBy ? { requestedBy } : {}),
    };
    const confirmation = token
      ? await confirmationProvider.resolveToken(token, request)
      : await confirmationProvider.requestInstallConfirmation(request);
    if (confirmation.status === 'approved') return undefined;
    if (confirmation.status === 'declined') {
      return { kind: 'declined', reason: confirmation.reason ?? 'The update was not approved.' };
    }
    return {
      kind: 'pending',
      token: confirmation.token,
      updates,
      ...(confirmation.reason ? { reason: confirmation.reason } : {}),
    };
  };

  // GET /held-back -- every global package held back from sessions, and why
  // (DOR-2306): what it runs, and the content hash a decision is bound to.
  router.get('/held-back', async (_req, res) => {
    try {
      return res.json({ packages: await listHeldBackPackages(dorkHome) });
    } catch (err) {
      logger.error('[Marketplace] Failed to list held-back packages', err);
      return res.status(500).json({ error: 'Failed to list held-back packages' });
    }
  });

  // POST /held-back/:name/review -- raise the approval card for a held-back
  // package again, because a person asked. Raising a card only ever asks a
  // person, so any caller may; deciding it is the person's.
  router.post('/held-back/:name/review', async (req, res) => {
    try {
      await reviewHeldBackPackage({ dorkHome, ...heldBackCards }, String(req.params.name));
      return res.status(202).json({ status: 'asked' });
    } catch (err) {
      if (err instanceof HeldBackReviewError) {
        return res.status(409).json({ error: err.message, code: 'not_reviewable' });
      }
      logger.error(`[Marketplace] Failed to raise a card for ${req.params.name}`, err);
      return res.status(500).json({ error: 'Failed to raise the approval card' });
    }
  });

  // POST /held-back/:name/decision -- a person's allow or refuse, made in the
  // terminal after seeing everything the package runs, bound to what they saw.
  // The same bar as deciding an approval card (`routes/approvals.ts`): a
  // trusted caller, which under login means a person's session cookie. An
  // agent, a caller holding an approval token, and an API key under login are
  // all refused; under login the terminal is pointed at the app's Review card.
  router.post('/held-back/:name/decision', async (req, res) => {
    const authority = readCallerAuthority(req, res);
    if (!trustedCaller(authority)) {
      if (!resolveDecisionAuthority(authority).allowed) {
        return res.status(403).json({
          error: 'Only you can decide whether a held-back package runs, not an agent.',
          code: 'operator_only',
        });
      }
      return res.status(403).json({
        error:
          'DorkOS requires sign-in, so this has to be decided by a person signed in to the app. ' +
          'Open DorkOS, go to Marketplace, then Installed, and press Review on the package.',
        code: OPERATOR_COOKIE_REQUIRED_CODE,
      });
    }
    const parsed = HeldBackDecisionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: z.flattenError(parsed.error) });
    }
    try {
      await decideHeldBackPackage(dorkHome, String(req.params.name), parsed.data.decision, {
        effects: parsed.data.effects,
        bindsTo: parsed.data.bindsTo,
      });
      if (parsed.data.decision === 'allow') await heldBackCards.onGranted();
      return res.status(204).send();
    } catch (err) {
      if (err instanceof HeldBackDecisionError) {
        return res.status(409).json({ error: err.message, code: 'not_decidable' });
      }
      logger.error(`[Marketplace] Failed to record a decision for ${req.params.name}`, err);
      return res.status(500).json({ error: 'Failed to record the decision' });
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
    directorySize(marketplacesRoot),
    sumPackageSizes(packages),
  ]);

  return {
    marketplaces: marketplaceDirs.length,
    packages: packages.length,
    totalSizeBytes: marketplacesBytes + packagesBytes,
  };
}

/** Sum the recursive size of every cached package directory. */
async function sumPackageSizes(packages: { path: string }[]): Promise<number> {
  let total = 0;
  for (const pkg of packages) {
    total += await directorySize(pkg.path);
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
