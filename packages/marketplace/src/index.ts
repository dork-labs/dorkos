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

// Schemas
export {
  MarketplacePackageManifestSchema,
  type MarketplacePackageManifest,
  type PluginPackageManifest,
  type AgentPackageManifest,
  type SkillPackPackageManifest,
  type AdapterPackageManifest,
} from './manifest-schema.js';

export {
  MarketplaceJsonSchema,
  MarketplaceJsonEntrySchema,
  type MarketplaceJson,
  type MarketplaceJsonEntry,
} from './marketplace-json-schema.js';

// Parser (browser-safe — no fs)
export { parseMarketplaceJson, type ParseMarketplaceResult } from './marketplace-json-parser.js';

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
