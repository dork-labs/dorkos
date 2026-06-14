/**
 * Config-load guardrail for hand-editors of `~/.dork/config.json`.
 *
 * In the deviation-list model a default-on core extension records its OFF state
 * in `extensions.disabled`; listing it in `extensions.enabled` is a no-op. This
 * helper warns (once per offending id) so a hand-editor who put a default-on id
 * in the wrong list gets a clear pointer. It never mutates config — the
 * resolution helper already ignores the redundant entry.
 *
 * @module services/core-extensions/warn-redundant-enabled
 */
import type { CoreExtensionInfo } from '../extensions/extension-enable-resolution.js';
import { logger } from '../../lib/logger.js';

/**
 * Warn when a default-on core extension id appears in `extensions.enabled`.
 *
 * @param core - Tier metadata for the staged core extensions.
 * @param enabled - The user's `extensions.enabled` deviation list.
 */
export function warnRedundantEnabledEntries(core: CoreExtensionInfo[], enabled: string[]): void {
  for (const info of core) {
    if (info.defaultEnabled && enabled.includes(info.id)) {
      logger.warn(
        'Extension "%s" is default-on; listing it in extensions.enabled is a no-op. To disable it, add it to extensions.disabled instead.',
        info.id
      );
    }
  }
}
