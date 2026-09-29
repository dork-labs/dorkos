/**
 * Per-project settings only a person writes (spec `flow-multiproject` §7.10).
 *
 * An autonomy dial ("Ask me first | Tell me after | Just do it") must not be
 * something the extension's own server half, an agent it runs, or a commit to
 * the repo can turn up. So core holds it, outside the repo, per extension and
 * project root, at `{dorkHome}/extension-data/<id>/project-settings/
 * <sha256(root)>.json`, holding `{ root, value, updatedAt, updatedBy }`.
 *
 * **Reading is open, writing is not.** The server half reads through
 * `ctx.projectSettings.get` and hears changes through `onChange`; there is no
 * server-side setter at all. The only writers are the person-bar route
 * `PUT /api/extensions/:id/project-settings` (recorded as `extension-page`,
 * because the bar cannot tell a person's click from the extension's own page
 * code) and a person's "Yes" to a follow-up offer's `settingsPatch`
 * (recorded as `person`).
 *
 * @module services/extensions/extension-project-settings
 */
import { createHash } from 'node:crypto';
import fs from 'fs/promises';
import path from 'path';
import { writeFileAtomic } from '@dorkos/shared/atomic-write';
import { PROJECT_SETTINGS_MAX_BYTES } from '@dorkos/shared/extension-decision-schemas';
import { logger } from '../../../lib/logger.js';

/** Who last wrote a project's settings. */
export type ProjectSettingsWriter = 'person' | 'extension-page';

/** One stored settings file. */
export interface StoredProjectSettings {
  /** The project root it is for. */
  root: string;
  /** Any JSON the extension validates on read. */
  value: unknown;
  /** ISO time of the last write. */
  updatedAt: string;
  /** Who wrote it. */
  updatedBy: ProjectSettingsWriter;
}

/** Why a write was refused. */
export class ProjectSettingsError extends Error {
  /**
   * Refuse a write.
   *
   * @param code - `too_large` or `not_json`.
   * @param message - Plain words.
   */
  constructor(
    readonly code: 'too_large' | 'not_json',
    message: string
  ) {
    super(message);
    this.name = 'ProjectSettingsError';
  }
}

type Listener = (extensionId: string, projectRoot: string) => void;

/** Holds every extension's per-project settings. */
export class ExtensionProjectSettingsStore {
  private readonly listeners = new Set<Listener>();

  /**
   * Build the store for one data directory.
   *
   * @param dorkHome - The DorkOS data directory.
   */
  constructor(private readonly dorkHome: string) {}

  /** The file for one extension and project root. */
  private fileFor(extensionId: string, root: string): string {
    const digest = createHash('sha256').update(root).digest('hex');
    return path.join(
      this.dorkHome,
      'extension-data',
      extensionId,
      'project-settings',
      `${digest}.json`
    );
  }

  /**
   * The stored settings for a project, or null when nobody wrote any.
   *
   * @param extensionId - Whose settings.
   * @param root - The project root, canonical.
   */
  async read(extensionId: string, root: string): Promise<StoredProjectSettings | null> {
    try {
      const raw = await fs.readFile(this.fileFor(extensionId, root), 'utf-8');
      const parsed = JSON.parse(raw) as StoredProjectSettings;
      // A hash collision, or a file copied by hand, must not answer for a
      // different project.
      return parsed.root === root ? parsed : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(`[ext:${extensionId}] could not read project settings`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return null;
    }
  }

  /**
   * Replace a project's value. The caller has already checked who is writing
   * and that the project is one this extension may see.
   *
   * @param extensionId - Whose settings.
   * @param root - The project root, canonical.
   * @param value - Any JSON, at most 16 KiB once written.
   * @param updatedBy - Who is writing.
   */
  async write(
    extensionId: string,
    root: string,
    value: unknown,
    updatedBy: ProjectSettingsWriter
  ): Promise<StoredProjectSettings> {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch {
      serialized = undefined;
    }
    if (serialized === undefined) {
      throw new ProjectSettingsError('not_json', 'The value must be JSON.');
    }
    if (Buffer.byteLength(serialized, 'utf8') > PROJECT_SETTINGS_MAX_BYTES) {
      throw new ProjectSettingsError('too_large', 'The value is larger than 16 KiB.');
    }
    const stored: StoredProjectSettings = {
      root,
      value: JSON.parse(serialized) as unknown,
      updatedAt: new Date().toISOString(),
      updatedBy,
    };
    await writeFileAtomic(this.fileFor(extensionId, root), JSON.stringify(stored, null, 2));
    for (const listener of [...this.listeners]) {
      try {
        listener(extensionId, root);
      } catch (err) {
        logger.warn(`[ext:${extensionId}] a project settings listener threw`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return stored;
  }

  /**
   * Shallow-merge `patch` into a project's stored object (an offer's
   * `settingsPatch`, §7.8). A stored value that is not an object is replaced.
   *
   * @param extensionId - Whose settings.
   * @param root - The project root, canonical.
   * @param patch - Keys to set.
   * @param updatedBy - Who is writing.
   */
  async merge(
    extensionId: string,
    root: string,
    patch: Record<string, unknown>,
    updatedBy: ProjectSettingsWriter
  ): Promise<StoredProjectSettings> {
    const current = await this.read(extensionId, root);
    const base =
      current &&
      typeof current.value === 'object' &&
      current.value !== null &&
      !Array.isArray(current.value)
        ? (current.value as Record<string, unknown>)
        : {};
    return this.write(extensionId, root, { ...base, ...patch }, updatedBy);
  }

  /**
   * Hear every write, for any extension.
   *
   * @param listener - Called with the extension id and project root.
   * @returns Unsubscribe.
   */
  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

const stores = new Map<string, ExtensionProjectSettingsStore>();

/**
 * The one store for a data directory, so the route that writes, the inbox
 * that applies an offer's patch, and every extension's `onChange` all share
 * one set of listeners.
 *
 * @param dorkHome - The DorkOS data directory.
 */
export function projectSettingsStore(dorkHome: string): ExtensionProjectSettingsStore {
  let store = stores.get(dorkHome);
  if (!store) {
    store = new ExtensionProjectSettingsStore(dorkHome);
    stores.set(dorkHome, store);
  }
  return store;
}
