/**
 * Extension entity — an installed extension as the rest of the app sees it:
 * whether it is waiting for a person to turn it on, what turning it on lets it
 * do, and the two answers a person can give (DOR-2517).
 *
 * A foundational slice. `attention` consumes it to count extensions waiting in
 * the Activity inbox's "Needs You"; `features/inbox` and `features/extensions`
 * draw from it so the inbox row and the Settings card ask the same question in
 * the same words.
 *
 * @module entities/extension
 */
export { extensionConsentCopy } from './lib/consent-copy';
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
export {
  useExtensionApprovalActions,
  type ExtensionApprovalActions,
  type ApproveExtensionInput,
  type DismissExtensionInput,
  type ExtensionAnswerInput,
} from './model/use-extension-approval-actions';
