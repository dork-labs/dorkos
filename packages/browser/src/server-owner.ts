/** Backend-only original engine birth/retirement composition; never a public browser tool. */
export {
  constructOwnedBrowserEngine,
  type PrivateBrowserBirthOwner,
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
