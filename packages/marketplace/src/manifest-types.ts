/**
 * Pure TypeScript types derived from the marketplace manifest schema.
 * Re-exported for consumers that want types without importing the Zod runtime.
 *
 * @module @dorkos/marketplace/manifest-types
 */
export type {
  MarketplacePackageManifest,
  PluginPackageManifest,
  AgentPackageManifest,
  SkillPackPackageManifest,
  AdapterPackageManifest,
} from './manifest-schema.js';
