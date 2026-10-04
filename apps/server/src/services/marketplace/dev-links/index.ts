/**
 * Dev links (DOR-2696): run a marketplace package from a folder on this computer.
 *
 * @module services/marketplace/dev-links
 */
export {
  DevLinkService,
  type DevLinkApprovals,
  type DevLinkApprovalStore,
  type DevLinkFs,
  type DevLinkListing,
  type DevLinkReloads,
  type DevLinkRequest,
  type DevLinkServiceDeps,
  type DevLinkTarget,
  type DevUnlinkRequest,
  type DevUnlinkResult,
} from './dev-link-service.js';
export {
  classifyDevLinkChanges,
  DevLinkWatcher,
  devLinkExtensionsOf,
  isIgnoredDevLinkPath,
  type DevLinkChange,
  type DevLinkExtensions,
  type DevLinkReloadPlan,
  type DevLinkWatcherDeps,
} from './dev-link-watcher.js';
export { hookDecisionConsentStore, type DevLinkConsentStore } from './consent.js';
export { DevLinkError, packageIsDevLinked } from './errors.js';
export {
  activeDevLinks,
  devLinkInSlot,
  canonicalSlotPath,
  devLinkStateOf,
  devLinksFilePath,
  readDevLinks,
  readSlot,
  updateDevLinks,
  type DevLinksReading,
} from './registry.js';
