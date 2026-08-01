/**
 * Re-export manifest I/O from @dorkos/shared.
 *
 * This preserves all existing Mesh imports while the canonical
 * implementation now lives in the shared package.
 *
 * @module mesh/manifest
 */
export {
  readManifest,
  probeManifest,
  writeManifest,
  removeManifest,
  MANIFEST_DIR,
  MANIFEST_FILE,
} from '@dorkos/shared/manifest';
