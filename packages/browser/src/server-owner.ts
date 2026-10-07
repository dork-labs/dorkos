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
export type { OwnedNavigationAuthorization } from './navigation/owned-work.js';
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
