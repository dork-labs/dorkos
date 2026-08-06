/**
 * A caught error whose message matches a rejected dynamic `import()` — the shape
 * a stale viewer chunk takes after the app was rebuilt or redeployed while a tab
 * stayed open. The since-deleted content-hashed chunk 404s, and React caches the
 * rejected module payload, so remounting or invalidating re-throws instantly.
 * Only a full reload fetches the current chunk hashes.
 */
const DYNAMIC_IMPORT_ERROR =
  /dynamically imported module|Loading chunk|Importing a module script failed|ChunkLoadError/i;

/**
 * Whether a caught error looks like a failed dynamic import of a stale chunk.
 *
 * @param error - The caught error to classify.
 * @returns True when the error message matches a rejected dynamic `import()`.
 */
export function isDynamicImportError(error: Error): boolean {
  return DYNAMIC_IMPORT_ERROR.test(error.message);
}
