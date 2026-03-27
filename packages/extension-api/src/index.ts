/**
 * Extension API — public contract for DorkOS extensions.
 *
 * Extension authors type against this package. The host provides the implementation.
 *
 * @module @dorkos/extension-api
 */
export { ExtensionManifestSchema } from './manifest-schema.js';
export type { ExtensionManifest } from './manifest-schema.js';
export type { ExtensionAPI, ExtensionPointId, ExtensionReadableState } from './extension-api.js';
export type {
  ExtensionStatus,
  ExtensionRecord,
  ExtensionRecordPublic,
  ExtensionModule,
} from './types.js';
