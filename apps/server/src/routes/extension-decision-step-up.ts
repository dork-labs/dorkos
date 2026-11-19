/** Remote extension grants, re-reading the stored request at confirmation. */
import type { Context } from 'hono';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts, type RequestFacts } from '../http/request-facts.js';
import { isAtThisComputer } from '../services/core/auth/gate-policy.js';
import type { ExtensionInboxService } from '../services/extensions/inbox/extension-inbox.js';
import type { StepUpCommitResult } from '../services/core/auth/step-up/step-up-holds.js';
import { assessPerson, type PersonBarCopy } from './extensions-person-bar.js';
import { deskGoesOnWithoutSheet, holdForStepUp } from './step-up-guard.js';
import { extensionSettingsHash } from '../services/extensions/inbox/extension-step-up-view.js';
import { hashApprovalInput } from '../services/core/approvals/approval-input-hash.js';
import {
  grantsPower,
  refuseApprovalYesFromWifi,
} from '../services/core/approvals/model/approval-answer-policy.js';

/**
 * Hold a remote yes, and an accepted offer anywhere: an offer is a lasting
 * "next time, on its own" grant, held at the desk the same as Always allow.
 * A desk yes keeps the caller's original path.
 */
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
  const wifi = refuseApprovalYesFromWifi(facts);
  if (wifi) return c.json(wifi, 403);
  const atDesk = isAtThisComputer(facts);
  if (atDesk && (action.kind !== 'offer' || deskGoesOnWithoutSheet(facts))) return undefined;
  if (!atDesk && (facts.user?.credential !== 'cookie' || !facts.user.sessionId)) {
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
      currentHash: () => {
        const live = action.inbox.stepUpView(action.id, action.kind, action.extensionId);
        return live?.identityHash === view.identityHash ? live.hash : undefined;
      },
    },
    commit: async (confirming) => {
      const refused = assessPerson(confirming, action.copy);
      if (refused) return refused;
      const wifi = refuseApprovalYesFromWifi(confirming);
      if (wifi) return { status: 403, body: wifi };
      if (
        action.inbox.stepUpView(action.id, action.kind, action.extensionId)?.identityHash !==
        view.identityHash
      ) {
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

/** Bind a remote settings write to its complete server-read effect and recheck at commit. */
export async function holdRemoteExtensionSettings(
  c: Context<ApiEnv>,
  action: {
    id: string;
    copy: PersonBarCopy;
    project: string;
    value: unknown;
    read: () => unknown;
    run: (facts: RequestFacts) => Promise<Response>;
  }
): Promise<Response | undefined> {
  const facts = honoRequestFacts(c);
  if (!grantsPower({ kind: 'extension-settings' }) || isAtThisComputer(facts)) return undefined;
  const wifi = refuseApprovalYesFromWifi(facts);
  if (wifi) return c.json(wifi, 403);
  if (facts.user?.credential !== 'cookie' || !facts.user.sessionId)
    return c.json({ error: 'Sign in to DorkOS to decide an approval.', code: 'not-a-person' }, 403);
  const snapshot = action.read();
  const identityHash = hashApprovalInput(snapshot);
  const hash = extensionSettingsHash(action.id, action.project, action.value);
  return holdForStepUp(c, {
    kind: 'extension.settings-change',
    target: action.id,
    input: { snapshot, project: action.project, value: action.value },
    reason: 'Change this mini app’s project settings.',
    notes: [JSON.stringify(action.value)],
    binding: {
      hash,
      currentHash: () => (hashApprovalInput(action.read()) === identityHash ? hash : undefined),
    },
    commit: async (confirming) => {
      const refused = assessPerson(confirming, action.copy);
      if (refused) return refused;
      const wifi = refuseApprovalYesFromWifi(confirming);
      if (wifi) return { status: 403, body: wifi };
      const response = await action.run(confirming);
      return {
        status: response.status,
        body: response.status === 204 ? null : await response.json(),
      };
    },
  });
}

/** Confirm a lasting mini-app grant, re-reading its complete server-owned snapshot. */
export function holdExtensionPowerChange(
  c: Context<ApiEnv>,
  action: {
    id: string;
    effect: string;
    copy: PersonBarCopy;
    reason: string;
    read: () => unknown;
    run: (facts: RequestFacts) => Promise<Response> | Response;
  }
): Response | undefined {
  if (!grantsPower({ kind: action.effect })) return undefined;
  const facts = honoRequestFacts(c);
  const wifi = refuseApprovalYesFromWifi(facts);
  if (wifi) return c.json(wifi, 403);
  if (deskGoesOnWithoutSheet(facts)) return undefined;
  if (!isAtThisComputer(facts) && (facts.user?.credential !== 'cookie' || !facts.user.sessionId))
    return c.json({ error: 'Sign in to DorkOS to decide an approval.', code: 'not-a-person' }, 403);
  const readHash = () => hashApprovalInput({ effect: action.effect, snapshot: action.read() });
  const input = { effect: action.effect, snapshot: action.read() };
  const hash = hashApprovalInput(input);
  return holdForStepUp(c, {
    kind: 'extension.grant',
    target: action.id,
    input,
    reason: action.reason,
    binding: { hash, currentHash: readHash },
    commit: async (facts) => {
      const refused = assessPerson(facts, action.copy);
      if (refused) return refused;
      const wifi = refuseApprovalYesFromWifi(facts);
      if (wifi) return { status: 403, body: wifi };
      const response = await action.run(facts);
      return {
        status: response.status,
        body: response.status === 204 ? null : await response.json(),
      };
    },
  });
}
