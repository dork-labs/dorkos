/**
 * The one switch live doc editing reads: the `docs.enabled` experiment.
 *
 * Read on every call, so turning it off takes effect at once: new sockets are
 * refused, the doc routes answer 404, and the agent doc tools refuse plainly.
 *
 * @module services/docs/collab/docs-enabled
 */
import { configManager } from '../../core/config-manager.js';

/** Whether the Docs experiment is on. */
export function docsEnabled(): boolean {
  return configManager.get('docs')?.enabled === true;
}
