/**
 * The one switch every Docs feature reads (DOR-2981 to DOR-2984): the
 * `docs.enabled` experiment, off by default. Read on every call, so turning it
 * on or off takes effect at once.
 *
 * @module services/docs/docs-experiment
 */
import { configManager } from '../core/config-manager.js';

/** Whether the Docs experiment is on. */
export function docsEnabled(): boolean {
  return configManager.get('docs')?.enabled === true;
}
