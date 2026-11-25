/** Individual hook review history and person-only re-asks. */
import type { Hono, Context } from 'hono';
import { problem } from '@dorkos/http-kit';
import type { ApiEnv } from '../http/api-chain.js';
import type { DecisionAuthorityResult } from '../services/core/approvals/decision-authority.js';
import type { ApprovalService } from '../services/core/approvals/approval-service.js';
import { scanHookRequests } from '../services/harness/project-with-consent.js';
import { hookProjectionBinding } from '../services/harness/hook-approval.js';
import {
  describeHookProjection,
  HOOK_CARD_PRESENTATION,
  summariseHookProjection,
} from '../services/harness/hook-card.js';
import { followReaskedHookRow } from '../services/harness/ask-withheld-hooks.js';
import { projectAgainAfterYes } from '../services/harness/auto-project.js';

/** Register these alongside grant/deny, behind exactly their person check. */
export function registerHookReviewRoutes(
  router: Hono<ApiEnv>,
  approvals: ApprovalService,
  personOrRefuse: (
    c: Context<ApiEnv>
  ) => Response | Extract<DecisionAuthorityResult, { allowed: true }>,
  dorkHome?: string
): void {
  router.get('/declined-hooks', (c) => {
    const authority = personOrRefuse(c);
    if (authority instanceof Response) return authority;
    return c.json({ approvals: approvals.declinedHooks() });
  });
  router.post('/:id/ask-again', (c) => {
    const authority = personOrRefuse(c);
    if (authority instanceof Response) return authority;
    const id = c.req.param('id');
    const original = approvals.declinedHookRequest(id);
    if (!original || !dorkHome)
      return problem(c, 'conflict', {
        detail: 'This request can’t be asked again. Sync its folder.',
      });
    const request = scanHookRequests(original.projectPath, dorkHome).find(
      (candidate) => candidate.packageName === original.packageName
    );
    if (!request)
      return problem(c, 'conflict', {
        detail: 'This package no longer has hooks in this folder.',
      });
    const result = approvals.reaskHook(id, {
      ...hookProjectionBinding(request, true),
      summary: summariseHookProjection(request),
      detail: describeHookProjection(request),
      packageRequest: {
        kind: 'hooks',
        presentation: HOOK_CARD_PRESENTATION,
        request,
        options: { notInstalledByDorkos: true },
      },
      requestedBy: 'DorkOS',
    });
    if (typeof result === 'string')
      return problem(c, 'already_resolved', {
        detail: 'This request has already been asked again.',
      });
    followReaskedHookRow(request, {
      projectPath: request.projectPath,
      approvals,
      dorkHome,
      reproject: () =>
        projectAgainAfterYes(
          { projectPath: request.projectPath, packageName: request.packageName, action: 'install' },
          dorkHome
        ),
    });
    return c.json({ ok: true, approvalId: result.approvalId });
  });
}
