/**
 * Approvals routes (spec `agent-trust` §3.3).
 *
 * The cockpit's side of the approval primitive: list what is waiting, then say
 * yes or no.
 *
 * - `GET /api/approvals/pending` — approvals still waiting on a person
 * - `POST /api/approvals/:id/grant` — allow the requested action
 * - `POST /api/approvals/:id/deny` — refuse it, with an optional reason
 * - `GET /api/approvals/grants` — the standing permissions that are live now
 * - `DELETE /api/approvals/grants/:id` — end one
 *
 * Decisions are made by approval id, never by token: the person deciding should
 * not have to hold the requester's secret, and no response here ever returns
 * token material.
 *
 * ## Deciding needs proof of a person, not the absence of proof of a machine
 *
 * Who may decide is `resolveDecisionAuthority` in
 * `services/core/approvals/decision-authority.ts`, and its module TSDoc is the
 * honest statement of what that guarantees under each posture — including what it
 * cannot guarantee when local login is off. Read it before changing anything here:
 * the earlier version of this file refused a caller that PRESENTED an agent
 * identity and let every other caller through, which made a bare `curl` with no
 * headers a complete self-approval bypass.
 *
 * Every recorded decision is written to the Activity feed with the posture it was
 * made under, so a "yes" that nobody clicked in the cockpit still leaves a trace.
 *
 * ## Under login, deciding needs a session cookie (DOR-474)
 *
 * `resolveDecisionAuthority` alone was not enough, and the residual it named is
 * the one this route now closes. `sessionGate` accepts a per-user API key as the
 * same identity a browser session proves, and the key is in an agent's hands
 * LEGITIMATELY — `packages/cli/src/lib/api-client.ts` reads it from
 * `DORKOS_API_KEY` or `<dork home>/api-key`, and without it a Codex or OpenCode
 * agent cannot reach the operator surface at all when login is on. So an agent
 * that asked for a destructive capability, got the 202 with the approval id, and
 * then called this route with its key while omitting both headers cleared every
 * refusal and approved its own work. The two header checks could not help: both
 * read headers the caller chose to send. The credential check could not help
 * either: it asked whether a credential was present, never what kind.
 *
 * So `POST /:id/grant` and `POST /:id/deny` run
 * {@link requireOperatorCookieUnderLogin} as a second bar, and every API key is
 * refused at both. **Deny is guarded for the same reason as grant, not as a
 * symmetry**: an agent that can deny can suppress a person's decision and bury
 * the card that would have told them.
 *
 * Reading (`GET /pending`, `GET /grants`) and REVOKING (`DELETE /grants/:id`) are
 * deliberately left on the `resolveDecisionAuthority` bar alone. Neither one lets
 * anything happen that a person did not already allow: revoking only narrows what
 * an agent may do, and the reasoning for each already sits at its handler.
 *
 * **Login off is unchanged, and that is deliberate rather than overlooked.**
 * `requireOperatorCookieUnderLogin` allows in that posture because there is no
 * cookie for anyone to present, and login off is the default. A credential-free
 * caller with shell access is indistinguishable from the cockpit there, so this
 * bar contributes nothing and does not pretend to. Turning on Require login is
 * what closes it, exactly as `decision-authority.ts` says.
 *
 * Transport auth is the global `sessionGate` mounted in `app.ts` — every `/api/*`
 * path inherits it, so these routes need no gate of their own; the authority check
 * below is a second, independent one.
 *
 * ## Opening a standing permission clears TWO bars, and needs both
 *
 * `standing: true` on the grant body says "and stop asking about this agent doing
 * this thing" (spec `agent-approval-settings` §3.5). Creating one requires:
 *
 * 1. The same authority as deciding the approval — `resolveDecisionAuthority`,
 *    which refuses any caller naming itself an agent and any caller holding the
 *    approval token, in every posture.
 * 2. A session cookie, checked by `requireOperatorCookie`. Bar 1 alone is not
 *    enough: under `local-trust` it is satisfied by omitting two headers, which is
 *    exactly the chain `__tests__/standing-grants-chain.test.ts` reproduces. Bar 2
 *    is what makes bar 1 mean something, and it is why standing permissions need
 *    Require login to be on.
 *
 * Every REFUSAL happens before anything is granted. A caller that asked for two
 * things and can only have one gets neither, and is told which part failed —
 * because a silent fallback to a plain one-time yes would leave a person believing
 * they had created a permission that does not exist.
 *
 * That is a claim about refusals, not about atomicity, and the two are not the
 * same. The one-time yes and the permission are separate writes: if the store
 * fails between them, the yes stands and the permission does not exist. The route
 * answers `STANDING_PERMISSION_NOT_RECORDED` and names both halves rather than
 * returning a bare 500, because retrying the whole call would then answer 409 and
 * read like success.
 *
 * Re-granting the same pair replaces the live permission rather than stacking a
 * second one, and the replacement starts a fresh window. That is a human decision
 * made again, which is the only thing allowed to move an expiry: using a permission
 * never extends it.
 *
 * @module routes/approvals
 */
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  DenyApprovalBodySchema,
  GrantApprovalBodySchema,
  type StandingPermission,
} from '@dorkos/shared/approval-schemas';
import type {
  ApprovalDecisionFailure,
  ApprovalGrantRow,
  ApprovalGrantService,
  ApprovalService,
  StandingGrantSettings,
} from '../services/core/approvals/index.js';
import {
  readStandingGrantSettings,
  resolveDecisionAuthority,
  type DecisionAuthorityResult,
  type LoginEnabledLookup,
} from '../services/core/approvals/index.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import {
  readCallerAuthority,
  requireOperatorCookie,
  requireOperatorCookieUnderLogin,
  type OperatorCookieRefusal,
} from '../lib/caller-authority.js';
import { titleForMcpTool } from '../services/core/mcp-tool-tiers.js';
import { logger } from '../lib/logger.js';

/** Optional collaborators the boot wiring supplies; omitted in unit tests. */
export interface ApprovalsRouterOptions {
  /**
   * Activity feed writer. Every decision is recorded with its posture, which is
   * the only mitigation available in the `local-trust` posture: DorkOS cannot
   * prove a person clicked, so it makes sure the click is visible.
   */
  activity?: ActivityService;
  /**
   * Whether local login is on. Defaults to the live user config; injected in
   * tests so both postures are exercised against the real route.
   */
  isLoginEnabled?: LoginEnabledLookup;
  /**
   * The two settings that shape a standing permission. Defaults to the live user
   * config; injected in tests so a route can be driven without a config manager.
   */
  readStandingGrantSettings?: () => StandingGrantSettings;
  /**
   * Resolves a capability's human-facing title for the permissions list. Omitted
   * in boots without a registry, where an unknown id falls back to its own id —
   * the same fallback the approval card already uses.
   */
  describeCapability?: (capabilityId: string) => { title: string } | undefined;
}

/**
 * Decide whether this request may record a decision.
 *
 * The request facts come from {@link readCallerAuthority}, shared with the two
 * mutation routes that skip the tier gate for a person (DOR-467) — so "who counts
 * as a person" cannot mean one thing at the endpoint that DECIDES an approval and
 * something else at the endpoints that act without one.
 *
 * @param req - The incoming request.
 * @param res - The response carrying `sessionGate`'s resolved user.
 * @param isLoginEnabled - Optional login-state lookup for tests.
 * @returns Permission with its posture, or a structured refusal.
 */
function decisionAuthority(
  req: Request,
  res: Response,
  isLoginEnabled?: LoginEnabledLookup
): DecisionAuthorityResult {
  return resolveDecisionAuthority({
    ...readCallerAuthority(req, res),
    ...(isLoginEnabled ? { loginEnabled: isLoginEnabled } : {}),
  });
}

/**
 * What a caller is told when it tried to answer an approval without a session
 * cookie while login is on.
 *
 * Written for whoever ends up reading it, which is often an agent relaying it to
 * a person: it says WHERE the answer has to happen, not which header was missing.
 * A refusal that names a header reads as a hint about how to get around it.
 */
const DECIDE_NEEDS_COCKPIT =
  'Approving or refusing a risky action has to happen inside DorkOS, by a person who is signed in. ' +
  'A program holding an API key cannot answer for you. Open DorkOS and answer it there.';

/**
 * With login on, require that a person in the cockpit is answering (DOR-474).
 *
 * The same predicate `PATCH /api/config` and the extension-approval route use, so
 * "who counts as a person" cannot mean one thing here and another there. Only the
 * sentence differs, because the shared one is worded for changing a SETTING and
 * this is not one — the same split `routes/config.ts` already makes when it keeps
 * `refusal.code` and supplies its own `error`.
 *
 * Runs AFTER `resolveDecisionAuthority`, so a caller that names itself an agent
 * still hears `AGENT_CANNOT_DECIDE`. That answer is more specific and more useful
 * than "sign in", and an honest agent should be told the thing it did wrong.
 *
 * @param res - The response carrying `sessionGate`'s resolved user.
 * @param isLoginEnabled - Optional login-state lookup for tests.
 * @returns `undefined` when the caller may decide, or the refusal to answer with.
 */
function requirePersonToDecide(
  res: Response,
  isLoginEnabled?: LoginEnabledLookup
): OperatorCookieRefusal | undefined {
  const refusal = requireOperatorCookieUnderLogin(
    res,
    'whether a risky action goes ahead',
    isLoginEnabled
  );
  return refusal ? { ...refusal, error: DECIDE_NEEDS_COCKPIT } : undefined;
}

/** Map a decision failure onto the HTTP status and code the cockpit branches on. */
function decisionFailureResponse(failure: ApprovalDecisionFailure): {
  status: number;
  body: { error: string; code: string };
} {
  switch (failure) {
    case 'unknown':
      return {
        status: 404,
        body: { error: 'No such approval', code: 'UNKNOWN_APPROVAL' },
      };
    case 'not_pending':
      return {
        status: 409,
        body: { error: 'This approval was already decided', code: 'APPROVAL_NOT_PENDING' },
      };
    case 'expired':
      return {
        status: 410,
        body: { error: 'This approval expired before it was decided', code: 'APPROVAL_EXPIRED' },
      };
  }
}

/**
 * Create the approvals router.
 *
 * @param approvals - The approval service that owns the token lifecycle.
 * @param grants - The store that owns standing permissions. Required rather than
 *   optional: an optional store would mean a branch answering "this build cannot
 *   do standing permissions", which is a state no boot produces and no test could
 *   keep honest.
 * @param options - Boot collaborators; see {@link ApprovalsRouterOptions}.
 * @returns The configured router, to mount at `/api/approvals`.
 */
export function createApprovalsRouter(
  approvals: ApprovalService,
  grants: ApprovalGrantService,
  options: ApprovalsRouterOptions = {}
): Router {
  const router = Router();
  const readSettings = options.readStandingGrantSettings ?? readStandingGrantSettings;

  /**
   * Name the action a permission covers, the way the approval card names it.
   *
   * Two id spaces, because two kinds of thing are grantable: registry capability
   * ids like `marketplace.uninstall`, and hand-registered MCP tool names like
   * `tasks_delete`. Only the first has a registry to ask. Missing the second left
   * a raw id in a list §3.7 promises a person can recognize — and today the tools
   * are the majority of what can actually be granted.
   */
  const titleFor = (capabilityId: string): string =>
    options.describeCapability?.(capabilityId)?.title ??
    titleForMcpTool(capabilityId) ??
    capabilityId;

  /**
   * Turn a stored permission into what the cockpit lists.
   *
   * The folder name is the handle, and the full path is the stable key. This is
   * NOT the same split the Activity observers use, and the difference is a real
   * shortcoming rather than a style choice: those prefer
   * `identity.displayName || basename` (`capability-attribution.ts`), and a
   * permission row stores no display name to prefer. So an agent whose display name
   * differs from its folder reads LESS legibly here than it does in the feed. Fixing
   * it properly means the list resolving a display name, or rendering a scope hint
   * ("dorkbot — acme-api") instead of a bare folder name; both are decisions for the
   * surface that draws the list, not for this projection.
   *
   * Who opened it, when, and under which posture are recorded in the row and in the
   * Activity event, and are deliberately not sent: nothing renders them, and the
   * `grantedBy` label is the operator's account id.
   */
  const toStandingPermission = (row: ApprovalGrantRow): StandingPermission => ({
    grantId: row.id,
    agentPath: row.agentPath,
    agentLabel: path.basename(row.agentPath),
    capabilityId: row.capabilityId,
    capabilityTitle: titleFor(row.capabilityId),
    expiresAt: row.expiresAt,
  });

  /**
   * Record a decision in the Activity feed, naming the posture it rests on.
   *
   * The `signed-in-operator` line says ACCOUNT, not person, and that word is
   * load-bearing: `sessionGate` accepts a per-user API key as well as a session
   * cookie (DOR-474), so an authenticated credential is not proof that a human
   * clicked. This record must not assert more than the gate verified — an audit
   * line that overstates is worse than no audit line, because it is believed.
   *
   * `emit` is fire-and-forget and never throws, so this cannot turn a recorded
   * decision into a failed request.
   */
  const auditDecision = (
    approvalId: string,
    outcome: 'granted' | 'denied',
    authority: Extract<DecisionAuthorityResult, { allowed: true }>
  ): void => {
    void options.activity?.emit({
      actorType: 'user',
      actorLabel: authority.decidedBy,
      category: 'agent',
      eventType: outcome === 'granted' ? 'approval.granted' : 'approval.denied',
      resourceType: 'approval',
      resourceId: approvalId,
      summary:
        authority.posture === 'signed-in-operator'
          ? `A signed-in account (${authority.decidedBy}) ${outcome} an approval`
          : `An approval was ${outcome} from this machine (login is off, so DorkOS cannot verify who)`,
      metadata: { posture: authority.posture, outcome },
    });
  };

  /**
   * Record the opening or ending of a standing permission in the Activity feed.
   *
   * A permission is a window in which DorkOS stops asking, so the moment it opens
   * and the moment it closes are the two lines that make the window itself
   * accountable. Both carry the posture, the agent, the action, and the expiry,
   * because "who decided this, and on what basis" is the question a person asks
   * when they find a permission they do not remember opening.
   */
  const auditGrantChange = (
    row: ApprovalGrantRow,
    outcome: 'created' | 'revoked',
    authority: Extract<DecisionAuthorityResult, { allowed: true }>
  ): void => {
    const who = path.basename(row.agentPath);
    const what = titleFor(row.capabilityId);
    void options.activity?.emit({
      actorType: 'user',
      actorLabel: authority.decidedBy,
      category: 'agent',
      eventType: outcome === 'created' ? 'approval.grant_created' : 'approval.grant_revoked',
      resourceType: 'approval',
      resourceId: row.id,
      resourceLabel: what,
      summary:
        outcome === 'created'
          ? `DorkOS will stop asking before ${who} runs ${what}, until ${row.expiresAt}`
          : `DorkOS will ask again before ${who} runs ${what}`,
      metadata: {
        posture: authority.posture,
        agentPath: row.agentPath,
        capabilityId: row.capabilityId,
        expiresAt: row.expiresAt,
        grantId: row.id,
      },
    });
  };

  // GET /pending -- approvals still waiting on a person
  router.get('/pending', (_req, res) => {
    res.json({ approvals: approvals.listPending() });
  });

  // GET /grants -- the standing permissions that are live right now
  router.get('/grants', (req, res) => {
    // Authorized like the three routes below it, and NOT like `GET /pending`.
    //
    // The precedent does not carry, and the difference is the whole reason this
    // check is here. A pending approval is deliberately agent-readable: it is a
    // card, and `toPendingApproval` projects a capped, secret-swept LABEL rather
    // than the `requestedByPath` column, which never leaves through that route. (The
    // label is not path-free in every case — `agent-token-env.ts` falls back to the
    // path when an agent set no display name — so the honest claim is about the
    // column, not about the bytes.) This list is the other thing. `expiresAt` is
    // PROSPECTIVE, which turns "try it and a person may refuse" into "this
    // irreversible action goes through silently right now, and here is the minute
    // the window shuts" — and, read the other way, tells an agent exactly when NOT
    // to try, which is how it avoids the card that would have told you. It also
    // names other agents' pairings, which composes with "a grant follows an agent
    // path" into a target list.
    //
    // So the same bar as deciding: an agent naming itself is refused, and so is
    // anything holding the approval token. Under `local-trust` a header-stripping
    // caller still reads it, which is the residual §3.0 states plainly and does not
    // pretend to close.
    const authority = decisionAuthority(req, res, options.isLoginEnabled);
    if (!authority.allowed) {
      return res.status(authority.status).json({ error: authority.error, code: authority.code });
    }
    return res.json({ grants: grants.list().map(toStandingPermission) });
  });

  // DELETE /grants/:id -- end one standing permission
  router.delete('/grants/:id', (req, res) => {
    // Ending a permission narrows what an agent may do, so it needs no cookie: the
    // asymmetry is deliberate. Opening one is the effect that needs proof of a
    // person, and the same authority check that decides an approval is the right
    // bar for taking one back — an agent still cannot reach this, because
    // `resolveDecisionAuthority` refuses any caller naming itself.
    const authority = decisionAuthority(req, res, options.isLoginEnabled);
    if (!authority.allowed) {
      return res.status(authority.status).json({ error: authority.error, code: authority.code });
    }

    // Read the row before revoking it, because the Activity line names the agent
    // and the action, and afterwards the row is no longer live to look up.
    const row = grants.list().find((candidate) => candidate.id === req.params.id);
    if (!grants.revoke(req.params.id)) {
      return res.status(404).json({
        error: 'No standing permission is live under that id',
        code: 'UNKNOWN_STANDING_PERMISSION',
      });
    }
    if (row) auditGrantChange(row, 'revoked', authority);
    return res.json({ ok: true, grantId: req.params.id });
  });

  // POST /:id/grant -- allow the requested action
  router.post('/:id/grant', (req, res) => {
    const authority = decisionAuthority(req, res, options.isLoginEnabled);
    if (!authority.allowed) {
      return res.status(authority.status).json({ error: authority.error, code: authority.code });
    }

    // The second bar, before anything is read off the body: under login, an API
    // key is not a person (DOR-474). See the module TSDoc.
    const notAPerson = requirePersonToDecide(res, options.isLoginEnabled);
    if (notAPerson) {
      return res.status(notAPerson.status).json({ error: notAPerson.error, code: notAPerson.code });
    }

    // Express 5 leaves `req.body` undefined on an empty POST, and `standing` is
    // optional, so an absent body is a plain one-time yes.
    const parsed = GrantApprovalBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Validation failed',
        code: 'INVALID_GRANT_BODY',
        details: z.flattenError(parsed.error),
      });
    }

    // Every standing-specific refusal happens BEFORE the approval is granted, so a
    // caller that asked for two things and can only have one gets neither and is
    // told which part failed. A fallback to a plain yes would leave a person
    // believing they had created a permission that does not exist.
    let scope: { agentPath: string; capabilityId: string } | undefined;
    if (parsed.data.standing === true) {
      // The stricter bar, checked first. See `requireOperatorCookie`: clearing
      // `resolveDecisionAuthority` above is not enough, because under `local-trust`
      // omitting two headers clears it.
      const refusal = requireOperatorCookie(res, options.isLoginEnabled);
      if (refusal) {
        return res.status(refusal.status).json({ error: refusal.error, code: refusal.code });
      }

      if (!readSettings().enabled) {
        return res.status(409).json({
          error:
            'Standing permissions are switched off. Turn them on in Settings, under Security, first.',
          code: 'STANDING_GRANTS_DISABLED',
        });
      }

      const requested = approvals.standingPermissionScope(req.params.id);
      if (!requested) {
        const mapped = decisionFailureResponse('unknown');
        return res.status(mapped.status).json(mapped.body);
      }
      // An anonymous request cannot become a permission: permissions key on the
      // agent path, and DorkOS has no name to key this one on. Refused rather than
      // keyed on the display label, which is caller-supplied text two agents can
      // share.
      if (!requested.agentPath) {
        return res.status(409).json({
          error:
            'DorkOS does not know which agent asked for this, so it cannot stop asking about that agent. Answer this one on its own.',
          code: 'APPROVAL_HAS_NO_AGENT',
        });
      }
      scope = { agentPath: requested.agentPath, capabilityId: requested.capabilityId };
    }

    const failure = approvals.grant(req.params.id);
    if (failure) {
      const mapped = decisionFailureResponse(failure);
      return res.status(mapped.status).json(mapped.body);
    }
    auditDecision(req.params.id, 'granted', authority);

    // The permission is recorded only after the one-time yes is, so a failed
    // decision can never leave a window open behind it.
    //
    // The two are NOT one transaction, and the residual is stated rather than
    // implied: if the store fails while recording the permission, the one-time yes
    // stands and the permission does not exist. That is the safe half to keep, but
    // an opaque 500 would leave the caller unable to tell it apart from "nothing
    // happened" — and retrying the whole call would answer 409, which reads like the
    // permission was created. So the answer names both halves.
    if (!scope) {
      return res.json({ ok: true, approvalId: req.params.id, outcome: 'granted' });
    }
    let row: ApprovalGrantRow;
    try {
      row = grants.create({
        ...scope,
        grantedBy: authority.decidedBy,
        posture: authority.posture,
        windowMinutes: readSettings().windowMinutes,
        sourceApprovalId: req.params.id,
      });
    } catch (err) {
      logger.error('[Approvals] the one-time yes was recorded but the permission was not', {
        approvalId: req.params.id,
        err: err instanceof Error ? err.message : String(err),
      });
      return res.status(500).json({
        error:
          'DorkOS allowed this one action, but could not record the permission to stop asking. The agent will ask again next time.',
        code: 'STANDING_PERMISSION_NOT_RECORDED',
        approvalId: req.params.id,
        outcome: 'granted',
      });
    }
    auditGrantChange(row, 'created', authority);
    return res.json({
      ok: true,
      approvalId: req.params.id,
      outcome: 'granted',
      standingPermission: toStandingPermission(row),
    });
  });

  // POST /:id/deny -- refuse the requested action
  router.post('/:id/deny', (req, res) => {
    const authority = decisionAuthority(req, res, options.isLoginEnabled);
    if (!authority.allowed) {
      return res.status(authority.status).json({ error: authority.error, code: authority.code });
    }

    // Guarded exactly like grant. Denying is not the safe direction to leave open:
    // an agent that can deny can bury the card a person would have answered.
    const notAPerson = requirePersonToDecide(res, options.isLoginEnabled);
    if (notAPerson) {
      return res.status(notAPerson.status).json({ error: notAPerson.error, code: notAPerson.code });
    }

    // Express 5 leaves `req.body` undefined on an empty POST, and a reason is
    // optional, so an absent body is a valid bare denial.
    const parsed = DenyApprovalBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Validation failed',
        code: 'INVALID_DENY_BODY',
        details: z.flattenError(parsed.error),
      });
    }

    const failure = approvals.deny(req.params.id, parsed.data.reason);
    if (failure) {
      const mapped = decisionFailureResponse(failure);
      return res.status(mapped.status).json(mapped.body);
    }
    auditDecision(req.params.id, 'denied', authority);
    return res.json({ ok: true, approvalId: req.params.id, outcome: 'denied' });
  });

  return router;
}
