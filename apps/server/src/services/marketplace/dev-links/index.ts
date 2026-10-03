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
  type DevLinkRequest,
  type DevLinkServiceDeps,
  type DevLinkTarget,
  type DevUnlinkRequest,
  type DevUnlinkResult,
} from './dev-link-service.js';
export { DevLinkError, packageIsDevLinked } from './errors.js';
export {
  activeDevLinks,
  canonicalSlotPath,
  devLinkStateOf,
  devLinksFilePath,
  readDevLinks,
  readSlot,
  updateDevLinks,
  type DevLinksReading,
} from './registry.js';
