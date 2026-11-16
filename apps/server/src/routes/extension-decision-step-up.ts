/** Remote extension grants, re-reading the stored request at confirmation. */
import type { Context } from 'hono';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts, type RequestFacts } from '../http/request-facts.js';
import { isAtThisComputer } from '../services/core/auth/gate-policy.js';
import { refuseStandingYesFromWifi } from '../services/core/auth/sessions/wifi-level.js';
import type { ExtensionInboxService } from '../services/extensions/inbox/extension-inbox.js';
import type { StepUpCommitResult } from '../services/core/auth/step-up/step-up-holds.js';
import { assessPerson, type PersonBarCopy } from './extensions-person-bar.js';
import { holdForStepUp } from './step-up-guard.js';

/** Hold a remote yes or accepted offer; desk answers keep the caller's original path. */
export function holdRemoteExtensionAnswer(
  c: Context<ApiEnv>,
  action: {
    id: string;
    kind: 'decision' | 'offer';
    inbox: ExtensionInboxService;
    copy: PersonBarCopy;
    extensionId?: string;
  },
  run: (facts: RequestFacts) => Promise<StepUpCommitResult>
): Response | undefined {
  const facts = honoRequestFacts(c);
  if (isAtThisComputer(facts)) return undefined;
  if (facts.user?.credential !== 'cookie' || !facts.user.sessionId) {
    return c.json({ error: 'Sign in to DorkOS to decide an approval.', code: 'not-a-person' }, 403);
  }
  const view = action.inbox.stepUpView(action.id, action.kind, action.extensionId);
  if (!view && action.extensionId)
    return c.json({ error: 'There is no such decision.', code: 'not_found' }, 404);
  if (!view)
    return c.json(
      {
        error: 'This request is no longer waiting.',
        code: action.kind === 'offer' ? 'offer_gone' : 'already_resolved',
      },
      409
    );
  return holdForStepUp(c, {
    kind: action.kind === 'offer' ? 'approval.grant-always' : 'approval.grant',
    target: action.id,
    input: { id: action.id, kind: action.kind, hash: view.hash },
    reason: view.reason,
    binding: {
      hash: view.hash,
      currentHash: () => action.inbox.stepUpView(action.id, action.kind, action.extensionId)?.hash,
    },
    commit: async (confirming) => {
      const refused = assessPerson(confirming, action.copy);
      if (refused) return refused;
      const standing = refuseStandingYesFromWifi(confirming, action.kind === 'offer');
      if (standing) return { status: 403, body: standing };
      if (action.inbox.stepUpView(action.id, action.kind, action.extensionId)?.hash !== view.hash) {
        return {
          status: 409,
          body: {
            code: 'different-request',
            error: 'That confirmation was for a different request. Confirm this one.',
          },
        };
      }
      return run(confirming);
    },
  });
}
