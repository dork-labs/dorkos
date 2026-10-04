/**
 * The extension seams the dev link watcher drives (DOR-2696, spec
 * `marketplace-dev-link` §6): the same calls `reload_extensions` makes, gated
 * on the extension being turned on and approved to run, so a reload never
 * builds or runs anything a person has not approved for this dev link.
 *
 * @module services/marketplace/dev-links/dev-link-extensions
 */
import path from 'node:path';
import type { ExtensionsConfig } from '../../extensions/extension-enable-resolution.js';
import { isEnabled } from '../../extensions/extension-enable-resolution.js';
import { mayRunExtensionCode } from '../../extensions/extension-load-policy.js';
import type { ExtensionManager } from '../../extensions/extension-manager.js';

/** What a rebuild of one extension came to. */
export type DevLinkExtensionReload =
  | { outcome: 'reloaded' }
  /** Turned off, or not approved to run: nothing was built or run. */
  | { outcome: 'skipped' }
  | { outcome: 'failed'; error: string };

/** The extension seams the watcher drives. */
export interface DevLinkExtensions {
  /**
   * The extensions DorkOS has a record for that come from this linked folder:
   * each id with its folder name under `.dork/extensions`.
   *
   * @param folder - The linked folder's real path.
   */
  carriedBy(folder: string): Array<{ id: string; dir: string }>;
  /** Re-scan every extension, and wait for the scan to finish. */
  refresh(): Promise<void>;
  /**
   * Rebuild one extension, only when it is turned on and approved to run.
   *
   * @param id - The extension id.
   */
  reload(id: string): Promise<DevLinkExtensionReload>;
}

/** What {@link devLinkExtensionsOf} needs from the extension manager. */
export type DevLinkExtensionManager = Pick<
  ExtensionManager,
  'listRecords' | 'reloadExtension' | 'requestRefresh' | 'whenIdle'
>;

/**
 * The extension seams over the real {@link ExtensionManager}: the same calls
 * `reload_extensions` makes, gated on the extension being on and approved.
 *
 * @param manager - The extension manager.
 * @param opts.config - Reads `config.extensions` (on/off lists and approvals).
 * @param opts.announce - Tells clients an extension rebuilt
 *   (`broadcastExtensionReloaded`), so they load the new bundle.
 */
export function devLinkExtensionsOf(
  manager: DevLinkExtensionManager,
  opts: { config: () => ExtensionsConfig; announce: (ids: string[]) => void }
): DevLinkExtensions {
  return {
    carriedBy: (folder) =>
      manager
        .listRecords()
        .filter((record) => record.devLink?.path === folder)
        .map((record) => ({ id: record.id, dir: path.basename(record.path) })),
    refresh: async () => {
      manager.requestRefresh();
      await manager.whenIdle();
    },
    reload: async (id) => {
      const record = manager.listRecords().find((candidate) => candidate.id === id);
      const config = opts.config();
      // A dev-linked copy is never a core extension, so no core table is needed
      // to answer whether it is on.
      if (
        !record ||
        record.origin === 'core' ||
        !isEnabled(id, config, new Map()) ||
        !mayRunExtensionCode(record, config)
      ) {
        return { outcome: 'skipped' };
      }
      const result = await manager.reloadExtension(id);
      if (result.status !== 'compiled') {
        return { outcome: 'failed', error: result.error?.message ?? 'it did not compile' };
      }
      opts.announce([id]);
      return { outcome: 'reloaded' };
    },
  };
}

/**
 * One line for an error of any shape.
 *
 * @param err - Whatever was thrown.
 */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
