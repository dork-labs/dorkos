/**
 * Whether the Docs experiment is on (`docs.enabled`, DOR-2993).
 *
 * Read on every call, so switching it in Settings takes effect at the next
 * request with no restart. While it is off every `/api/documents` route answers the
 * `/api` 404.
 *
 * @module server/services/docs/docs-enabled
 */
import { configManager } from '../core/config-manager.js';

/** Whether `docs.enabled` is on now. */
export function docsEnabled(): boolean {
  return configManager.get('docs')?.enabled === true;
}
