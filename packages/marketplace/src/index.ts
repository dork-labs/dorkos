/**
 * @dorkos/marketplace — Browser-safe barrel export.
 *
 * Re-exports schemas, types, constants, and the marketplace.json parser
 * (which has no Node.js dependencies). Node.js-only modules must be
 * imported via subpath:
 *
 *   import { validatePackage } from '@dorkos/marketplace/package-validator';
 *   import { createPackage } from '@dorkos/marketplace/scaffolder';
 *   import { scanPackageDirectory } from '@dorkos/marketplace/package-scanner';
 *
 * @module @dorkos/marketplace
 */

// Package manifest schemas
export {
  MarketplacePackageManifestSchema,
  type MarketplacePackageManifest,
  type PluginPackageManifest,
  type AgentPackageManifest,
  type SkillPackPackageManifest,
  type AdapterPackageManifest,
} from './manifest-schema.js';

// marketplace.json schemas
export {
  MarketplaceJsonSchema,
  MarketplaceJsonEntrySchema,
  PluginSourceSchema,
  AuthorSchema,
  OwnerSchema,
  MetadataSchema,
  RESERVED_MARKETPLACE_NAMES,
} from './marketplace-json-schema.js';
export type {
  MarketplaceJson,
  MarketplaceJsonEntry,
  PluginSource,
  RelativePathSource,
  GithubSource,
  UrlSource,
  GitSubdirSource,
  NpmSource,
  Author,
  Owner,
  Metadata,
} from './marketplace-json-schema.js';

// dorkos.json sidecar schemas
export { DorkosSidecarSchema, DorkosEntrySchema, PricingSchema } from './dorkos-sidecar-schema.js';
export type { DorkosSidecar, DorkosEntry, Pricing } from './dorkos-sidecar-schema.js';

// Merge helper
export { mergeMarketplace } from './merge-marketplace.js';
export type { MergedMarketplaceEntry, MergeMarketplaceResult } from './merge-marketplace.js';

// Source resolver
export { resolvePluginSource, ResolvePluginSourceError } from './source-resolver.js';
export type { ResolvedSourceDescriptor, ResolveContext } from './source-resolver.js';

// CC validator (strict-mode oracle)
export {
  CcMarketplaceJsonSchema,
  CcMarketplaceJsonEntrySchema,
  CcSourceSchema,
  validateAgainstCcSchema,
} from './cc-validator.js';

// Parser (browser-safe — no fs)
export {
  parseMarketplaceJson,
  parseMarketplaceJsonLenient,
  parseDorkosSidecar,
  parseMarketplaceWithSidecar,
  type ParseMarketplaceResult,
  type ParseMarketplaceJsonLenientResult,
  type ParseDorkosSidecarResult,
  type ParseMarketplaceWithSidecarResult,
  type SkippedPlugin,
} from './marketplace-json-parser.js';

// Types & helpers
export { PackageTypeSchema, type PackageType, requiresClaudePlugin } from './package-types.js';

// Constants
export {
  PACKAGE_MANIFEST_FILENAME,
  PACKAGE_MANIFEST_PATH,
  CLAUDE_PLUGIN_MANIFEST_PATH,
  MARKETPLACE_JSON_FILENAME,
  PACKAGE_MANIFEST_VERSION,
} from './constants.js';
