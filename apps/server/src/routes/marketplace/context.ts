/**
 * Marketplace routes: What every marketplace route group shares: the tier gate, the boundary and query checks, and the approval asks, built once per router on its dependencies.
 *
 * @module routes/marketplace/context
 */
import type { Context } from 'hono';
import { z } from 'zod';
import type { PackageType } from '@dorkos/marketplace';
import { disclosedEffectsOf } from '../../services/marketplace/preview/disclosed-effects.js';
import {
  activationEffectsOf,
  globalPackageExists,
  GLOBALLY_ACTIVATED_TYPES,
  type ApprovedPackage,
} from '../../services/marketplace/consent/global-plugin-consent.js';
import { packageContentHash } from '../../services/marketplace/lib/content-hash.js';
import { disclosesAnything, type DisclosedEffects } from '@dorkos/shared/marketplace-schemas';
import type { ConfirmationRequest } from '../../services/marketplace-mcp/confirmation-provider.js';
import { computeTargetDir } from '../../services/marketplace/flows/install-agent.js';
import type {
  ApprovableUpdate,
  InstalledUpdatesDeps,
} from '../../services/marketplace/flows/update-installed.js';
import { validateBoundary, BoundaryError } from '../../lib/boundary.js';
import {
  APPROVAL_TOKEN_HEADER,
  authorizeCapability,
  trustedCaller,
  type TierEnforcementDecision,
} from '../../services/core/capabilities/index.js';
import { resolveDecisionAuthority } from '../../services/core/approvals/index.js';
import { NEEDS_PERSON_AT_THIS_COMPUTER, readCallerAuthority } from '../../lib/caller-authority.js';
import { isAtThisComputer } from '../../services/core/auth/gate-policy.js';
import type { ApiEnv } from '../../http/api-chain.js';
import { honoRequestFacts } from '../../http/request-facts.js';
import { readQuery } from '../../http/request-query.js';
import {
  OPERATOR_ONLY_MARKETPLACE_SOURCE_CODE,
  describeMarketplaceSourceRefusal,
  marketplaceSourceRefusalError,
  type MarketplaceSourceAction,
} from '../../services/marketplace/sources/source-write-policy.js';
import type { MarketplaceRouteDeps } from '../marketplace.js';
import { InstallRequestBodySchema, type UpdateRefusal } from './shared.js';

/** The request context every marketplace route answers on. */
export type MarketplaceContext = Context<ApiEnv>;

/**
 * Build the helpers every marketplace route group shares, on the router's
 * dependencies.
 *
 * @param deps - The router's injected dependencies.
 * @returns The shared helpers.
 */
export function createRouteContext(deps: MarketplaceRouteDeps) {
  const {
    installer,
    updateFlow,
    dorkHome,
    onPluginsChanged,
    listAgentScopes,
    capabilityRegistry,
    confirmationProvider,
  } = deps;

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
   * @param c - The request, for the caller's identity and approval token.
   * @param id - The capability id whose tier governs this effect.
   * @param input - The effect's arguments, parsed against that capability's schema.
   * @param change - For a capability that binds its approval to a described
   *   change (`marketplace.link`): that description.
   * @returns What the gate decided. Proceed only on `allowed`.
   */
  const authorize = async (
    c: MarketplaceContext,
    id: string,
    input: unknown,
    change?: string
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
    const facts = honoRequestFacts(c);
    const identity = facts.agentIdentity;
    const header = facts.headers[APPROVAL_TOKEN_HEADER];
    const approvalToken = (Array.isArray(header) ? header[0] : header)?.trim();
    const trusted = trustedCaller(readCallerAuthority(facts));
    return authorizeCapability(
      registry,
      id,
      input,
      {
        ...(trusted ? { trusted } : {}),
        ...(identity ? { identity } : {}),
        ...(approvalToken ? { approvalToken } : {}),
        retryChannel: 'http-header',
      },
      change !== undefined ? { change } : {}
    );
  };

  /**
   * Turn a non-`allowed` gate decision into this router's HTTP answer: `202` when
   * a person has been asked and the caller should come back with the token, `403`
   * when no retry can change the answer.
   */
  const gateResponse = (
    c: MarketplaceContext,
    decision: Exclude<TierEnforcementDecision, { outcome: 'allowed' }>
  ): Response => c.json(decision.payload, decision.outcome === 'approval_required' ? 202 : 403);

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
   * @param c - The request to answer.
   * @param projectPath - The body's `projectPath`, when it sent one.
   * @returns `{ refused }` carrying the sent `403`, or `{ projectPath }` with
   *   the canonical path (or `undefined` when the body sent none). Callers must
   *   `return` the refusal so the effect below never runs.
   */
  const confineProjectPath = async (
    c: MarketplaceContext,
    projectPath: string | undefined
  ): Promise<{ refused: Response } | { refused?: undefined; projectPath?: string }> => {
    if (!projectPath) return {};
    try {
      return { projectPath: await validateBoundary(projectPath) };
    } catch (err) {
      if (err instanceof BoundaryError) {
        return {
          refused: c.json({ error: 'Access denied: projectPath outside boundary' }, 403),
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
   * Read `?projectPath` as at most one string. A repeated key reads as an
   * array (`readQuery`), which used to be dropped silently and answer for every
   * scope; that is a 400 now.
   *
   * @returns `{ refused }` carrying the sent 400, or `{ projectPath }`.
   */
  const readProjectPathQuery = (
    c: MarketplaceContext
  ): { refused: Response } | { refused?: undefined; projectPath?: string } => {
    const value = readQuery(c).projectPath;
    if (value === undefined || typeof value === 'string') {
      return value ? { projectPath: value } : {};
    }
    return { refused: c.json({ error: 'projectPath may be given only once' }, 400) };
  };

  /**
   * Whether `marketplace.install` could ask a person to approve this caller's
   * reinstall. A batch cannot carry one approval token per package, so a batch
   * that could need one is refused before any gate runs — calling the gate would
   * raise an approval request nobody could ever redeem.
   */
  const batchNeedsApproval = (c: MarketplaceContext): boolean => {
    const tier = capabilityRegistry()?.get('marketplace.install')?.tier;
    if (tier === undefined || tier === 'observe' || tier === 'act') return false;
    return !trustedCaller(readCallerAuthority(honoRequestFacts(c)));
  };

  /**
   * Refuse a package-source write unless the caller is the operator (DOR-502).
   *
   * This is NOT the tier gate above and deliberately not shaped like it: there is
   * no approval a caller could come back with, because there is no capability and
   * no card. Changing which feeds this install fetches code from is the person's,
   * the same way `CONFIG_WRITE_POLICY` makes the hosts DorkOS reaches the person's.
   * The full reasoning, including why the `PATCH /api/config` cookie bar is not
   * copied here, lives in `services/marketplace/sources/source-write-policy.ts`.
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
   * @param c - The request, for the caller's facts and the answer.
   * @param action - Which write was attempted, for the refusal wording.
   * @returns The sent `403` response when refused, otherwise `undefined`. Callers
   *   must `return` a truthy result so the effect below never runs.
   */
  const refuseUntrustedSourceWrite = (
    c: MarketplaceContext,
    action: MarketplaceSourceAction
  ): Response | undefined => {
    const facts = honoRequestFacts(c);
    if (resolveDecisionAuthority(readCallerAuthority(facts)).allowed) {
      // A person; package sources are a front-door setting, so they change only
      // at this computer (DOR-2969). Locality alone, not the full front-door
      // bar: with the password asked here, `dorkos marketplace add` presents an
      // API key from this computer, and that verb stays the operator's (pinned
      // in `marketplace.test.ts`). With it off, the open gate reads no key, so
      // once an owner exists the person adds sources in the app (DOR-3330).
      if (isAtThisComputer(facts)) return undefined;
      return c.json(
        {
          error: 'Change where packages come from on the computer DorkOS runs on.',
          code: NEEDS_PERSON_AT_THIS_COMPUTER,
        },
        403
      );
    }
    return c.json(
      {
        error: marketplaceSourceRefusalError(action),
        code: OPERATOR_ONLY_MARKETPLACE_SOURCE_CODE,
        message: describeMarketplaceSourceRefusal(action),
      },
      403
    );
  };

  /**
   * Preview an agent's install and ask a person with the card
   * `marketplace_install` raises, bound to the package, what it runs and its
   * staged files, and saying who asked, the version and where it comes from:
   *
   * - an agent package, always, wherever the call was scoped: it lands in
   *   `agents/<name>/`, whose sessions run its skills (DOR-2325); the card
   *   names that folder and binds it, and the install is held to the files
   *   the card showed;
   * - a global install that runs anything on its own or replaces a global
   *   package (DOR-2306).
   *
   * A project install of any other type is not asked about here: its hooks
   * are gated when projected.
   *
   * @returns What the install is held to (always the previewed content hash
   *   and type, DOR-2325), and the person's approval when a card was granted;
   *   `unasked` for a project install no card covers; or the response that
   *   ends the request unrun.
   */
  const askAboutAgentInstall = async (
    c: MarketplaceContext,
    request: z.infer<typeof InstallRequestBodySchema>,
    token: string | undefined,
    global: boolean
  ): Promise<
    | { refused: Response }
    | ({ contentHash: string; packageType: PackageType } & (
        { unasked: true } | { previewed: DisclosedEffects | undefined; approved?: ApprovedPackage }
      ))
  > => {
    const name = c.req.param('name') ?? '';
    const staged = await installer.preview({ name, ...request });
    const previewed = disclosedEffectsOf(staged.preview) ?? undefined;
    // What the install is held to, asked about or not (DOR-2325).
    const contentHash = await packageContentHash(staged.packagePath);
    const packageType = staged.manifest.type;
    const agentPackage = packageType === 'agent';
    if (!agentPackage) {
      if (!global) return { unasked: true, contentHash, packageType };
      const activated = GLOBALLY_ACTIVATED_TYPES.has(staged.manifest.type);
      const replaces = await globalPackageExists(dorkHome, staged.manifest.name);
      const runs = disclosesAnything(activationEffectsOf(previewed ?? null));
      if (!activated || (!replaces && !runs)) return { previewed, contentHash, packageType };
    }

    const identity = c.get('agentIdentity');
    const confirmation: ConfirmationRequest = {
      packageName: name,
      ...(request.marketplace !== undefined && { marketplace: request.marketplace }),
      operation: 'install',
      preview: staged.preview,
      contentHash,
      // Where an agent package lands is bound, not only shown: its folder is
      // where the new agent's sessions run.
      ...(agentPackage && {
        packageType: 'agent',
        projectPath: computeTargetDir(dorkHome, staged.manifest, request.projectPath),
      }),
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
        refused: c.json(
          {
            status: 'requires_confirmation',
            confirmationToken: answer.token,
            preview: staged.preview,
            message:
              `${answer.reason ? `${answer.reason} ` : ''}A person must approve this install in ` +
              'DorkOS first: ' +
              (agentPackage
                ? 'it adds an agent whose sessions run what the package brings. '
                : 'it runs things on its own in every session, or replaces a package that does. ') +
              'Send the same request again with this confirmationToken once they have.',
          },
          202
        ),
      };
    }
    if (answer.status === 'declined') {
      return {
        refused: c.json(
          { status: 'declined', reason: answer.reason ?? 'The install was not approved.' },
          403
        ),
      };
    }
    return {
      previewed,
      approved: { disclosed: previewed ?? null, contentHash },
      contentHash,
      packageType,
    };
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

  return {
    authorize,
    gateResponse,
    confineProjectPath,
    updateDeps,
    readProjectPathQuery,
    batchNeedsApproval,
    refuseUntrustedSourceWrite,
    askAboutAgentInstall,
    askAboutUpdates,
  };
}

/** The helpers {@link createRouteContext} builds. */
export type MarketplaceRouteContext = ReturnType<typeof createRouteContext>;
