/** Backend-only original engine birth/retirement composition; never a public browser tool. */
export {
  constructOwnedBrowserEngine,
  type PrivateBrowserBirthOwner,
  type PrivateBrowserRetirementReceiver,
  type BrowserLifecycleEngine,
} from './engine.js';
