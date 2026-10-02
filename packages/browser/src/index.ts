/**
 * Private fixture-only browser engine and contracts. Installation and production
 * activation remain outside this package. The server chooses authority and roots.
 * @module browser
 */
export { BrowserValidationError, type BrowserValidationCode } from './errors.js';
export { createBrowserEngine, type BrowserLifecycleEngine } from './engine.js';
export { BrowserLifecycleError } from './lifecycle/errors.js';
export { type BrowserCapture } from './tabs/capture.js';
export {
  parseProfileId,
  parseBrowserId,
  parseTabId,
  type ProfileId,
  type BrowserId,
  type TabId,
  type RequestId,
} from './ids.js';
export { advanceCounter } from './counters.js';
export {
  parseBrowserCommand,
  parseBrowserResult,
  type BrowserBinding,
  type BrowserInputStep,
  type BrowserCommand,
  type BrowserResult,
} from './contracts.js';
export { parseRuntimeDescriptor, type BrowserRuntimeDescriptor } from './runtime-descriptor.js';
export {
  validateEngineConfiguration,
  type EngineConfiguration,
  type FixtureNetworkPolicy,
  type EngineClock,
  type ProcessIdentity,
  type ProcessObservation,
  type ProcessTreeObservation,
  type ProcessObserver,
  type BrokerLeaseBinding,
  type EnginePolicy,
} from './configuration.js';
