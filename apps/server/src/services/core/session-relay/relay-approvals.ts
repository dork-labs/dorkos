/**
 * Approving or denying a tool call from the web, over the session relay (spec
 * `everything-is-a-space` B4b): `interaction.challenge` issues a statement for
 * the owner's passkey to sign, and `interaction.respond` carries the signed
 * proof back. Nothing is approved or denied until the proof passes every check
 * in `approval-proof.ts`, and then only once: never "always allow".
 *
 * Refused before any proof, whatever it would say:
 *
 * - no approvals passkey is pinned here, or its file cannot be read;
 * - the card is not one the web may answer (`relay-approvable.ts`, Security
 *   Must 4): anything but a short list of one-shot tools, a file tool aimed at
 *   a settings folder, or a card whose input is a placeholder;
 * - a denial that carries a reason: the reason is unsigned words that would
 *   reach the agent, so a reason is added at the computer;
 * - the card would not fit in a statement the approve page can show whole.
 *
 * The audit log gets the decision, the input's hash and the passkey's label,
 * never the input itself.
 *
 * The request server checks the chat is one the relay serves before calling
 * in here.
 *
 * @module services/core/session-relay/relay-approvals
 */
import type { ToolDecisionOptions } from '@dorkos/shared/agent-runtime';
import type { RelayError, RelayRequest } from '@dorkos/shared/session-relay';
import {
  issueApprovalChallenge,
  takeApprovalChallenge,
  type ApprovalChallengeBook,
  type ApprovalPinFacts,
  type PendingApprovalCard,
} from './approval-challenges.js';
import type { ApprovalKeys } from './approval-key-store.js';
import { verifyApprovalProof, type ApprovalProofFailure } from './approval-proof.js';
import { recordRelayAudit, type RelayAuditDeps } from './relay-audit.js';
import {
  RELAY_APPROVAL_AT_COMPUTER,
  RELAY_APPROVAL_EXPIRED,
  RELAY_APPROVAL_NOT_PENDING,
  RELAY_APPROVAL_NO_PASSKEY,
  RELAY_APPROVAL_PROOF_FAILED,
  RELAY_APPROVAL_TOO_LARGE,
  RELAY_DENY_REASON_AT_COMPUTER,
  RELAY_TOO_MANY_APPROVALS,
} from './relay-errors.js';

/** Everything an approval from the web reads and calls. */
export interface RelayApprovalDeps extends RelayAuditDeps {
  /** The pinned approvals passkeys, or `null` when there are none (or none readable). */
  approvalKeys: () => ApprovalKeys | null;
  /** What the relay pin says about this computer and its hub, or `null` when unlinked. */
  approvalPin: () => ApprovalPinFacts | null;
  /** The tool approval a chat is waiting on, or `null` when it is not waiting on that call. */
  pendingApproval: (sessionId: string, toolCallId: string) => PendingApprovalCard | null;
  /**
   * Whether the web may answer this card at all (Security Must 4), judged
   * with the chat's folder; see `relayApprovableCard`.
   */
  approvableCard: (card: PendingApprovalCard, cwd: string | null) => boolean;
  /** Answer the tool call, once. Never passed `alwaysAllow`. */
  approveTool: (
    sessionId: string,
    toolCallId: string,
    approved: boolean,
    options: ToolDecisionOptions
  ) => Promise<boolean>;
  /**
   * Record the sign counter a passing proof carried, as a compare-and-set:
   * true only while the key is still pinned with the counter the proof was
   * checked against. See `bumpSignCount` in `approval-key-store.ts`.
   */
  bumpSignCount: (credentialId: string, expected: number, signCount: number) => Promise<boolean>;
  /** The current time; injectable for tests. */
  now?: () => Date;
}

type ChallengeRequest = Extract<RelayRequest, { op: 'interaction.challenge' }>;
type RespondRequest = Extract<RelayRequest, { op: 'interaction.respond' }>;
type ApprovalAnswer = Exclude<RespondRequest['answer'], { kind: 'answer' }>;

/** How a failed proof is answered: the web side learns only "expired", "gone" or "no". */
function refusalFor(failure: ApprovalProofFailure): RelayError {
  if (failure === 'no-challenge' || failure === 'expired') return RELAY_APPROVAL_EXPIRED;
  if (failure === 'not-pending') return RELAY_APPROVAL_NOT_PENDING;
  return RELAY_APPROVAL_PROOF_FAILED;
}

/**
 * Issue a challenge for one decision on one pending tool approval.
 *
 * @param deps - See {@link RelayApprovalDeps}.
 * @param book - The connection's live challenges.
 * @param cwd - The chat's folder, which a file tool's target resolves against.
 * @param request - The `interaction.challenge` request.
 * @param answer - Answers with the result body.
 * @param refuse - Answers with a refusal.
 */
export function challengeApproval(
  deps: RelayApprovalDeps,
  book: ApprovalChallengeBook,
  cwd: string | null,
  request: ChallengeRequest,
  answer: (body: unknown) => void,
  refuse: (error: RelayError) => void
): void {
  const { sessionId, toolCallId, decision } = request;
  const refused = (error: RelayError, why: string): void => {
    recordRelayAudit(deps, {
      action: 'relay.interaction.challenge',
      operation: 'execute',
      outcome: 'refused',
      sessionId,
      error: why,
      summary: 'Refused to start an approval from the web',
    });
    refuse(error);
  };
  const keys = deps.approvalKeys();
  const pin = deps.approvalPin();
  if (!keys || !pin) return refused(RELAY_APPROVAL_NO_PASSKEY, 'no-passkey');
  const pending = deps.pendingApproval(sessionId, toolCallId);
  if (!pending) return refused(RELAY_APPROVAL_NOT_PENDING, 'not-pending');
  if (!deps.approvableCard(pending, cwd)) return refused(RELAY_APPROVAL_AT_COMPUTER, 'at-computer');
  const issued = issueApprovalChallenge(book, {
    pin,
    keys,
    sessionId,
    toolCallId,
    decision,
    pending,
    now: deps.now?.(),
  });
  if (!issued.ok) {
    return issued.reason === 'too-many'
      ? refused(RELAY_TOO_MANY_APPROVALS, 'too-many')
      : refused(RELAY_APPROVAL_TOO_LARGE, 'too-large');
  }
  recordRelayAudit(deps, {
    action: 'relay.interaction.challenge',
    operation: 'execute',
    outcome: 'ok',
    sessionId,
    change: [
      { field: 'decision', after: decision },
      { field: 'inputSha256', after: issued.inputSha256 },
    ],
    summary: 'Started an approval from the web',
  });
  answer(issued.body);
}

/**
 * Check a signed approval or denial and, only when it passes, answer the tool
 * call once.
 *
 * @param deps - See {@link RelayApprovalDeps}.
 * @param book - The connection's live challenges.
 * @param cwd - The chat's folder, which a file tool's target resolves against.
 * @param sessionId - The chat.
 * @param decided - The approve or deny answer, with its proof.
 * @param answer - Answers with the result body.
 * @param refuse - Answers with a refusal.
 */
export async function respondApproval(
  deps: RelayApprovalDeps,
  book: ApprovalChallengeBook,
  cwd: string | null,
  sessionId: string,
  decided: ApprovalAnswer,
  answer: (body: unknown) => void,
  refuse: (error: RelayError) => void
): Promise<void> {
  const { toolCallId, proof } = decided;
  const decision = decided.kind;
  // Taken first, so this proof uses the challenge up whatever happens next.
  const issued = takeApprovalChallenge(book, proof.challengeId);
  const refused = (error: RelayError, why: string, label?: string): void => {
    recordRelayAudit(deps, {
      action: 'relay.interaction.approval',
      operation: 'execute',
      outcome: 'refused',
      sessionId,
      error: why,
      change: [
        { field: 'decision', after: decision },
        ...(label !== undefined ? [{ field: 'passkey', after: label }] : []),
      ],
      summary: 'Refused an approval from the web',
    });
    refuse(error);
  };
  // A reason is unsigned words that would reach the agent: never taken from the web.
  if (decided.kind === 'deny' && decided.reason?.trim()) {
    return refused(RELAY_DENY_REASON_AT_COMPUTER, 'deny-reason');
  }
  const keys = deps.approvalKeys();
  if (!keys) return refused(RELAY_APPROVAL_NO_PASSKEY, 'no-passkey');
  const pendingNow = (): PendingApprovalCard | null => deps.pendingApproval(sessionId, toolCallId);
  // No proof makes a card the web may not answer allowed, whenever it is checked.
  const approvable = (): boolean => {
    const card = pendingNow();
    return card === null || deps.approvableCard(card, cwd);
  };
  if (!approvable()) return refused(RELAY_APPROVAL_AT_COMPUTER, 'at-computer');

  const verdict = await verifyApprovalProof({
    issued,
    answer: { sessionId, toolCallId, decision },
    proof,
    keys,
    pendingApproval: pendingNow,
    now: deps.now?.(),
  });
  const label = keys.keys.find((key) => key.credentialId === proof.credentialId)?.label;
  if (!verdict.ok) return refused(refusalFor(verdict.failure), verdict.failure, label);
  if (!approvable()) return refused(RELAY_APPROVAL_AT_COMPUTER, 'at-computer', label);

  // Fail closed: unless the counter is recorded against the key exactly as it was
  // checked (still pinned, not moved by another proof), the tool call is not answered.
  const recorded = await deps.bumpSignCount(
    verdict.key.credentialId,
    verdict.key.signCount,
    verdict.signCount
  );
  if (!recorded) return refused(RELAY_APPROVAL_PROOF_FAILED, 'key-changed', label);
  const owner = deps.owner().name.trim();
  const ok = await deps.approveTool(sessionId, toolCallId, decision === 'approve', {
    ...(owner ? { answeredBy: owner } : {}),
  });
  recordRelayAudit(deps, {
    action: 'relay.interaction.approval',
    operation: 'execute',
    outcome: ok ? 'ok' : 'failed',
    sessionId,
    change: [
      { field: 'decision', after: decision },
      { field: 'inputSha256', after: verdict.inputSha256 },
      { field: 'passkey', after: verdict.key.label },
    ],
    summary: decision === 'approve' ? 'Approved a tool from the web' : 'Denied a tool from the web',
  });
  if (!ok) return refuse(RELAY_APPROVAL_NOT_PENDING);
  answer({ ok: true });
}
