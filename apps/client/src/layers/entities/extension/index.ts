/**
 * Extension entity — an installed extension as the rest of the app sees it:
 * whether it is waiting for a person to turn it on, what turning it on lets it
 * do, and the two answers a person can give (DOR-2517).
 *
 * A foundational slice. `attention` consumes it to count extensions waiting in
 * the Activity inbox's "Needs You"; `features/inbox` and `features/extensions`
 * draw from it so the inbox row and the Settings card ask the same question in
 * the same words. It also carries what extensions ask a person about
 * (`ctx.inbox`, spec `flow-multiproject` §7): the open decisions, the answers
 * given from the bell, and the one-time follow-up offers.
 *
 * @module entities/extension
 */
export { EXTENSION_TRUST_COPY, extensionConsentCopy } from './lib/consent-copy';
export {
  AGENT_TOOL_TIER_LABEL,
  agentGiftsFromApproval,
  agentGiftsFromRecord,
  agentGiftsLine,
  type AgentGifts,
  type AgentGiftSkill,
  type AgentGiftTool,
  type AgentToolTier,
} from './lib/agent-gifts';
export { ExtensionAgentGifts, type ExtensionAgentGiftsProps } from './ui/ExtensionAgentGifts';
export {
  approvedSetOf,
  extensionPermissionLines,
  permissionLineText,
  permissionsAddedSince,
  permissionViewFromApproval,
  permissionViewFromRecord,
  runsAnyProgram,
  type ExtensionPermissionAdditions,
  type ExtensionPermissionLine,
  type ExtensionPermissionPart,
  type ExtensionPermissionSet,
  type ExtensionPermissionProgram,
  type ExtensionPermissionTone,
  type ExtensionPermissionView,
} from './lib/permission-lines';
export { useSeenBeforeStaleStore, useAddedSinceSeen } from './model/seen-before-stale-store';
export {
  ACCESS_FACT_LINE_KEYS,
  approvalChangeLine,
  extensionAccessFacts,
  isChangedSinceAllowed,
  type ExtensionAccessFact,
} from './lib/access-facts';
export {
  ExtensionAccessFacts,
  ExtensionPermissionLines,
  type ExtensionAccessFactsProps,
  type ExtensionPermissionLinesProps,
} from './ui/ExtensionPermissionLines';
export {
  parseExtensionApprovalSubject,
  canTurnOnInPlace,
  type ExtensionApprovalSubject,
} from './lib/approval-subject';
export {
  usePendingExtensionApprovals,
  extensionQueryKeys,
  type PendingExtensionApprovalsState,
} from './model/use-pending-extension-approvals';
export { useExtensionList } from './model/use-extension-list';
export { approvalSetsKey, pluginDisplayName, useApprovalSets } from './model/use-approval-sets';
export {
  REVIEW_EXTENSION_SET_ACTION,
  extensionSetFromAction,
  extensionSetSection,
  useExtensionSetPaletteItems,
} from './model/use-approval-set-palette-items';
export { useMoveExtensionOut, useStepUpRisks } from './model/use-step-up-risks';
export { useWithheldExtensions, type WithheldExtension } from './model/use-withheld-extensions';
export {
  WithheldExtensionsNotice,
  type WithheldExtensionsNoticeProps,
} from './ui/WithheldExtensionsNotice';
export { runningCopiesOnly } from './lib/running-copies';
export {
  useTrustOfferStore,
  useTrustOfferFor,
  selectTrustOffer,
  TRUST_OFFER_TTL_MS,
  type TrustOffer,
} from './model/trust-offer-store';
export {
  useTrustedSources,
  useTrustedSourceActions,
  trustedSourcesQueryKey,
} from './model/use-trusted-sources';
export {
  useExtensionApprovalActions,
  type ExtensionApprovalActions,
  type ApproveExtensionInput,
  type DismissExtensionInput,
  type ExtensionAnswerInput,
} from './model/use-extension-approval-actions';
export {
  useExtensionDecisions,
  useExtensionDecisionActions,
  useDecisionOffers,
  markOfferShownInBell,
  takeOffersShownInBell,
  extensionDecisionsKey,
  type ExtensionDecisionsState,
  type ExtensionDecisionActions,
  type DecisionAnswerInput,
} from './model/use-extension-decisions';
export {
  appAccessibleName,
  appState,
  buildAppCatalog,
  matchesAppSearch,
  pinnedApps,
  type AppCatalog,
  type AppCatalogStatus,
  type AppEntry,
  type AppState,
  type KnownApps,
} from './lib/app-catalog';
export {
  PIN_CAP_TOAST,
  useAppCatalog,
  useAppCatalogSnapshot,
  useAppPins,
  usePublishAppCatalog,
  useRetryApps,
  type AppCatalogState,
  type AppPinActions,
} from './model/use-app-catalog';
export {
  useAppActions,
  useAppTrying,
  type AppActions,
  type AppTarget,
} from './model/use-app-actions';
