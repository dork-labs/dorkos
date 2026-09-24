/**
 * Approvals routes (spec `agent-trust` §3.3).
 *
 * The cockpit's side of the approval primitive: list what is waiting, then say
 * yes or no.
 *
 * - `GET /api/approvals/pending` — approvals still waiting on a person
 * - `POST /api/approvals/:id/grant` — allow the requested action, once or always
 * - `POST /api/approvals/:id/deny` — refuse it, with an optional reason
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
 * Reading (`GET /pending`) is deliberately open: a pending card is meant to be
 * agent-readable, and it carries no token material and no agent path.
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
 * ## Three answers, and each one is audited (spec `agent-permissions` D7, D14)
 *
 * The grant body is `{ answer: 'once' | 'always' }`. `once` allows this call.
 * `always` also sets this action to Allowed for the agent that asked, through
 * the same permission service Settings writes through, BEFORE the approval is
 * granted: granting is what wakes the held call, so the resumed call and the
 * new setting agree. `always` is refused (409 `ALWAYS_NOT_OFFERED`) on the same
 * three rules the card's `alwaysOffered` is computed from — DorkOS does not know
 * which agent asked, the action has no area, or its area is never Allowed — and
 * the refusal comes before anything is granted. Hiding the button is not the
 * check; this is.
 *
 * Every answer, deny included, writes exactly one `permission.answered` Activity
 * event in the `permissions` category, labelled by the honesty rule: with login
 * off it is "Someone on this computer", never "You". An Always allow also writes
 * the `permission.changed` event for the setting it created.
 *
 * The setting is written, then the approval is granted, as two steps. The
 * route checks the approval is still open before writing, so only a second
 * answer to the same card (a Deny, or the window closing) landing in the gap
 * between the two can refuse this call's yes after the setting is saved. When
 * that happens the route puts the setting back as it was, through the same
 * service with `surface: 'undo'` and the approval's id, so the history shows
 * both the write and its reversal and no Always allow outlives a card that was
 * not answered yes. Only a failure of that reversal itself can leave the
 * setting behind; it is logged, and the person is told to check the agent's
 * Permissions page.
 *
 * @module routes/approvals
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { DenyApprovalBodySchema, GrantApprovalBodySchema } from '@dorkos/shared/approval-schemas';
import {
  PERMISSION_ANSWERED_EVENT,
  type PermissionAnswer,
  type PermissionAnsweredMetadata,
  type PermissionChange,
  type PermissionState,
} from '@dorkos/shared/permissions';
import type {
  ApprovalAnswerScope,
  ApprovalDecisionFailure,
  ApprovalService,
} from '../services/core/approvals/index.js';
import {
  resolveDecisionAuthority,
  type DecisionAuthorityResult,
  type LoginEnabledLookup,
} from '../services/core/approvals/index.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import {
  readCallerAuthority,
  requireOperatorCookieUnderLogin,
  type OperatorCookieRefusal,
} from '../lib/caller-authority.js';
import {
  PermissionError,
  type PermissionAgentRef,
  type PermissionService,
  type PermissionWriter,
} from '../services/core/permissions/index.js';
import { titleForMcpTool } from '../services/core/mcp-tool-tiers.js';
import { writerForPosture } from './permissions.js';
import { logger } from '../lib/logger.js';

/** Optional collaborators the boot wiring supplies; omitted in unit tests. */
export interface ApprovalsRouterOptions {
  /**
   * Activity feed writer. Every answer is recorded with its posture, which is
   * the only mitigation available in the `local-trust` posture: DorkOS cannot
   * prove a person clicked, so it makes sure the click is visible.
   */
  activity?: Pick<ActivityService, 'emit'>;
  /**
   * The one permission write owner, which an Always allow writes through and
   * which names the agent that asked. Omitted in boots without it, where
   * `answer: 'always'` is refused rather than silently answered once.
   */
  permissions?: Pick<PermissionService, 'setAgent' | 'agentByPath'>;
  /**
   * Whether local login is on. Defaults to the live user config; injected in
   * tests so both postures are exercised against the real route.
   */
  isLoginEnabled?: LoginEnabledLookup;
  /**
   * Resolves a capability's human-facing title for the answer's audit line.
   * Omitted in boots without a registry, where an unknown id falls back to the
   * hand-registered tool table and then to its own id.
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

/** The sentence a refused `answer: 'always'` carries. */
const ALWAYS_NOT_OFFERED_MESSAGE =
  "Always allow isn't offered for this request. Answer it with Allow or Deny.";

/**
 * Create the approvals router.
 *
 * @param approvals - The approval service that owns the token lifecycle.
 * @param options - Boot collaborators; see {@link ApprovalsRouterOptions}.
 * @returns The configured router, to mount at `/api/approvals`.
 */
export function createApprovalsRouter(
  approvals: ApprovalService,
  options: ApprovalsRouterOptions = {}
): Router {
  const router = Router();

  /**
   * Name the action an approval is about, the way the card names it: the
   * registry title for a capability id, the tool table's title for a
   * hand-registered tool, and the id itself when neither knows it.
   */
  const titleFor = (capabilityId: string): string =>
    options.describeCapability?.(capabilityId)?.title ??
    titleForMcpTool(capabilityId) ??
    capabilityId;

  /**
   * Record one answer as exactly one `permission.answered` event (spec
   * `agent-permissions` D14).
   *
   * The actor follows the honesty rule: with login off it is "Someone on this
   * computer", because DorkOS cannot tell the person from any program running
   * as them, and the line says so rather than claiming a "you" nobody proved.
   *
   * `emit` is fire-and-forget and never throws, so this cannot turn a recorded
   * decision into a failed request.
   */
  const auditAnswer = (
    approvalId: string,
    scope: ApprovalAnswerScope,
    answer: PermissionAnswer,
    authority: Extract<DecisionAuthorityResult, { allowed: true }>,
    res: Response
  ): void => {
    if (!options.activity) return;
    const writer = writerForPosture(authority.posture, res);
    const agent: PermissionAgentRef | undefined = scope.agentPath
      ? options.permissions?.agentByPath(scope.agentPath)
      : undefined;
    const card = approvals.getPending(approvalId);
    const who = writer.attribution === 'signed-in' ? 'You' : writer.actorLabel;
    const agentName = agent
      ? agent.displayName || agent.name
      : (card?.requestedBy ?? 'an unidentified caller');
    const what = `"${titleFor(scope.capabilityId)}"${card?.subject ? ` on ${card.subject.label}` : ''}`;
    const summary =
      answer === 'deny'
        ? `${who} said no to ${agentName} running ${what}`
        : `${who} allowed ${agentName} to run ${what} ${answer === 'always' ? 'from now on' : 'once'}`;
    const metadata: PermissionAnsweredMetadata = {
      ...(agent ? { agentId: agent.id } : {}),
      ...(scope.agentPath ? { agentPath: scope.agentPath } : {}),
      action: scope.capabilityId,
      area: scope.area,
      answer,
      approvalId,
      blockedRequest: scope.blockedRequest,
      posture: authority.posture,
    };
    void options.activity.emit({
      actorType: writer.actorType,
      actorLabel: writer.actorLabel,
      ...(writer.actorId ? { actorId: writer.actorId } : {}),
      category: 'permissions',
      eventType: PERMISSION_ANSWERED_EVENT,
      resourceType: agent ? 'agent' : 'approval',
      resourceId: agent?.id ?? approvalId,
      resourceLabel: agentName,
      summary,
      linkPath: null,
      metadata: metadata as unknown as Record<string, unknown>,
    });
  };

  /**
   * Clear both person bars, answering the refusal when either fails.
   *
   * @returns The authority, or `undefined` when a refusal was already sent.
   */
  const personOrRefuse = (
    req: Request,
    res: Response
  ): Extract<DecisionAuthorityResult, { allowed: true }> | undefined => {
    const authority = decisionAuthority(req, res, options.isLoginEnabled);
    if (!authority.allowed) {
      res.status(authority.status).json({ error: authority.error, code: authority.code });
      return undefined;
    }
    // The second bar, before anything is read off the body: under login, an API
    // key is not a person (DOR-474). See the module TSDoc.
    const notAPerson = requirePersonToDecide(res, options.isLoginEnabled);
    if (notAPerson) {
      res.status(notAPerson.status).json({ error: notAPerson.error, code: notAPerson.code });
      return undefined;
    }
    return authority;
  };

  /**
   * Put back what an Always allow wrote, after the yes it came with was refused.
   * Each key goes back to its value from before the write; a key the write did
   * not change is left alone.
   *
   * @returns Whether the setting is back as it was.
   */
  const undoAlwaysAllow = async (
    permissions: NonNullable<ApprovalsRouterOptions['permissions']>,
    write: { agentId: string; changes: PermissionChange[] },
    approvalId: string,
    writer: PermissionWriter
  ): Promise<boolean> => {
    const actions: Record<string, PermissionState | null> = {};
    for (const change of write.changes) {
      if (change.key.kind !== 'action') continue;
      actions[change.key.action] = change.before as PermissionState | null;
    }
    if (Object.keys(actions).length === 0) return true;
    try {
      await permissions.setAgent(write.agentId, { actions, surface: 'undo', approvalId }, writer);
      return true;
    } catch (err) {
      logger.error('[Approvals] Always allow was saved but its yes was refused, and undo failed', {
        approvalId,
        err: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  };

  // GET /pending -- approvals still waiting on a person
  router.get('/pending', (_req, res) => {
    res.json({ approvals: approvals.listPending() });
  });

  // POST /:id/grant -- allow the requested action, once or from now on
  router.post('/:id/grant', async (req, res) => {
    const authority = personOrRefuse(req, res);
    if (!authority) return;

    // Express 5 leaves `req.body` undefined on an empty POST, and `answer`
    // defaults to `once`, so an absent body is a plain one-time yes.
    const parsed = GrantApprovalBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Validation failed',
        code: 'INVALID_GRANT_BODY',
        details: z.flattenError(parsed.error),
      });
    }
    const { answer } = parsed.data;

    const scope = approvals.answerScope(req.params.id);
    if (!scope) {
      const mapped = decisionFailureResponse('unknown');
      return res.status(mapped.status).json(mapped.body);
    }

    /** What an Always allow wrote, so a refused yes can put it back. */
    let alwaysWrite: { agentId: string; changes: PermissionChange[] } | undefined;
    if (answer === 'always') {
      // Every Always-allow refusal comes BEFORE anything is granted: a caller
      // that asked for two things and can only have one gets neither, and is
      // told which part failed.
      const agent = scope.agentPath ? options.permissions?.agentByPath(scope.agentPath) : undefined;
      if (!scope.alwaysOffered || !scope.area || !agent || !options.permissions) {
        return res
          .status(409)
          .json({ error: ALWAYS_NOT_OFFERED_MESSAGE, code: 'ALWAYS_NOT_OFFERED' });
      }
      // A closed or already-answered card must not leave a setting behind.
      if (scope.state !== 'pending' || scope.closed) {
        const mapped = decisionFailureResponse(scope.closed ? 'expired' : 'not_pending');
        return res.status(mapped.status).json(mapped.body);
      }
      // The setting first, then the yes: granting is what wakes a held call, so
      // the resumed call and the new setting agree (see the module TSDoc).
      try {
        const changes = await options.permissions.setAgent(
          agent.id,
          {
            actions: { [scope.capabilityId]: 'allowed' },
            surface: 'request-card',
            approvalId: req.params.id,
          },
          writerForPosture(authority.posture, res)
        );
        alwaysWrite = { agentId: agent.id, changes };
      } catch (err) {
        if (err instanceof PermissionError) {
          return res.status(409).json({ error: err.message, code: err.code });
        }
        logger.error('[Approvals] Always allow could not be recorded; nothing was granted', {
          approvalId: req.params.id,
          err: err instanceof Error ? err.message : String(err),
        });
        return res.status(500).json({
          error: 'DorkOS could not save Always allow, so it allowed nothing. Try again.',
          code: 'ALWAYS_ALLOW_NOT_RECORDED',
        });
      }
    }

    const failure = approvals.grant(req.params.id);
    if (failure) {
      // Another answer won the card while the setting was being saved: the yes
      // did not happen, so neither may the setting it came with.
      if (alwaysWrite && options.permissions) {
        const undone = await undoAlwaysAllow(
          options.permissions,
          alwaysWrite,
          req.params.id,
          writerForPosture(authority.posture, res)
        );
        if (!undone) {
          return res.status(500).json({
            error:
              'Someone else answered this request first, and DorkOS could not take back the ' +
              "Always allow it had just saved. Check the agent's Permissions page.",
            code: 'ALWAYS_ALLOW_NOT_UNDONE',
          });
        }
      }
      const mapped = decisionFailureResponse(failure);
      return res.status(mapped.status).json(mapped.body);
    }
    auditAnswer(req.params.id, scope, answer, authority, res);
    return res.json({ ok: true, approvalId: req.params.id, outcome: 'granted', answer });
  });

  // POST /:id/deny -- refuse the requested action
  router.post('/:id/deny', (req, res) => {
    // Guarded exactly like grant. Denying is not the safe direction to leave open:
    // an agent that can deny can bury the card a person would have answered.
    const authority = personOrRefuse(req, res);
    if (!authority) return;

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

    const scope = approvals.answerScope(req.params.id);
    const failure = approvals.deny(req.params.id, parsed.data.reason);
    if (failure) {
      const mapped = decisionFailureResponse(failure);
      return res.status(mapped.status).json(mapped.body);
    }
    if (scope) auditAnswer(req.params.id, scope, 'deny', authority, res);
    return res.json({ ok: true, approvalId: req.params.id, outcome: 'denied' });
  });

  return router;
}
