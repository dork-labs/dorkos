/** Individual hook review history and person-only re-asks. */
import type { Hono, Context } from 'hono';
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
      return c.json(
        {
          error: 'This request cannot be asked again. Sync its folder.',
          code: 'HOOK_REASK_UNAVAILABLE',
        },
        409
      );
    const request = scanHookRequests(original.projectPath, dorkHome).find(
      (candidate) => candidate.packageName === original.packageName
    );
    if (!request)
      return c.json(
        {
          error: 'This package no longer has hooks in this folder.',
          code: 'HOOK_REASK_UNAVAILABLE',
        },
        409
      );
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
      return c.json(
        { error: 'This request has already been asked again.', code: 'HOOK_REASK_UNAVAILABLE' },
        409
      );
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
