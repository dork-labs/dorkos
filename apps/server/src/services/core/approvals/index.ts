/**
 * The approval primitive — one mechanism for "ask the person first"
 * (spec `agent-trust` §3.3).
 *
 * There is no module-level singleton here: every consumer (the marketplace
 * confirmation provider, the approvals router, and tier enforcement next) takes
 * the service by injection from the one instance `index.ts` builds at boot.
 *
 * The barrel carries what consumers actually import. The service's own result and
 * option types are reachable from `./approval-service.js` and get re-exported
 * here when something outside this directory names them.
 *
 * @module services/core/approvals
 */
export {
  ApprovalService,
  APPROVAL_TTL_MS,
  resolveApprovalTtlMs,
  MIN_APPROVAL_TTL_MS,
  type ApprovalConsumeResult,
  type ApprovalDecisionFailure,
  type ApprovalDecisionOutcome,
  type AwaitDecisionOptions,
  type ApprovalTicket,
} from './approval-service.js';
export {
  ApprovalGrantService,
  type ApprovalGrantInput,
  type ApprovalGrantPosture,
  type ApprovalGrantRow,
} from './approval-grant-service.js';
export {
  readStandingGrantPosture,
  readStandingGrantSettings,
  readStandingGrantVoidFloor,
  type StandingGrantSettings,
} from './standing-grant-settings.js';
export {
  initStandingGrantPosture,
  resetStandingGrantPosture,
  revokeStandingGrantsIfPostureForbids,
  revokeStandingGrantsIfPostureNarrowed,
  type StandingGrantPosture,
} from './standing-grant-posture.js';
export { hashApprovalInput, ApprovalInputNotBindableError } from './approval-input-hash.js';
export {
  quoteSummaryValue,
  readApprovalInputPath,
  redactSecretsInText,
  renderRequesterLabel,
  summaryFields,
  REDACTED_SUMMARY_VALUE,
} from './approval-summary.js';
export {
  resolveDecisionAuthority,
  type DecisionAuthorityRequest,
  type DecisionAuthorityResult,
  type LoginEnabledLookup,
} from './decision-authority.js';
