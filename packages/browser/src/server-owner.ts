/** Backend-only original engine birth/retirement composition; never a public browser tool. */
export {
  constructOwnedBrowserEngine,
  type PrivateBrowserBirthOwner,
  type PrivateBrowserResourceOwner,
  type PrivateBrowserUploadOwner,
  type PrivateBrowserUploadDispatcher,
  type PrivateBrowserDownloadOwner,
  type PrivateBrowserDownloadDispatcher,
  type PrivateBrowserInputOwner,
  type PrivateBrowserInputDispatcher,
  type PrivateBrowserCaptureOwner,
  type PrivateBrowserCaptureDispatcher,
  type PrivateBrowserNavigationOwner,
  type PrivateBrowserNavigationDispatcher,
  type PrivateBrowserRetirementReceiver,
  type BrowserLifecycleEngine,
} from './engine.js';
export type { OwnedInputWork, OwnedInputAuthorization } from './input/owned-work.js';
export type { OwnedCaptureAuthorization, OwnedCaptureWork } from './tabs/owned-capture-work.js';
export type { OwnedNavigationAuthorization, OwnedNavigationWork } from './navigation/owned-work.js';
export type { PrivateOwnerNavigationContinuation } from './navigation/owner-continuation.js';
export { isOwnedCaptureCancellation } from './tabs/owned-capture-work.js';
export type {
  PrivateBrowserSemanticOwner,
  PrivateBrowserSemanticDispatcher,
  OwnedSemanticReadAuthorization,
  OwnedSemanticControlAuthorization,
  PrivateSemanticStream,
} from './semantic/owned-read.js';
export type { OwnedUploadLease } from './files/upload-chooser.js';
export type { OwnedDownloadSink, OwnedDownloadArtifact } from './files/response-download.js';
export { isOriginalSemanticReadRefusal } from './semantic/owned-read.js';
export { isOriginalBrowserDiagnosticRefusal } from './engine.js';

export type { AuthorityCustodyRefusalStage } from './lifecycle/live-custody.js';
export type { RetirementCloseRefusalStage } from './lifecycle/records.js';

export { readOriginalNavigationRefusal } from './navigation/refusal.js';

/** Backend-only VM dispatcher reuse of the same original work issuers. */
export {
  createOwnedCaptureIssuer,
  consumeOwnedCaptureWork,
  authorizeOwnedCaptureWork,
  ownedCaptureWorkCurrent,
  settleOwnedCaptureWork,
} from './tabs/owned-capture-work.js';
export {
  createOwnedNavigationIssuer,
  consumeOwnedNavigationWork,
  authorizeOwnedNavigation,
  ownedNavigationCurrent,
} from './navigation/owned-work.js';
export {
  createOwnedInputIssuer,
  consumeOwnedInputWork,
  authorizeOwnedInputWork,
  ownedInputWorkCurrent,
  settleOwnedInputWork,
} from './input/owned-work.js';

export { createDiagnosticsBudget } from './tabs/diagnostics-budget.js';

export {
  hasOwnedUploadCompletion,
  beginOwnedUpload,
  completeOwnedUpload,
} from './input/owned-work.js';
export { parseBrowserBinding, parseBrowserUpload, parseBrowserDownload } from './contracts.js';

export {
  createSemanticInputIssuer,
  consumeSemanticInputWork,
  semanticInputCurrent,
  executeSemanticInputWork,
  settleSemanticInputWork,
} from './input/semantic-work.js';

export { createOriginalSemanticRefusalIssuer } from './semantic/owned-read.js';
