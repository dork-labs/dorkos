/**
 * Private managed-browser contract foundation. No acquisition, installation or
 * runtime activation occurs here. The server owns authority and chooses every root.
 * @module browser
 */
export { BrowserValidationError, type BrowserValidationCode } from './errors.js';
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
