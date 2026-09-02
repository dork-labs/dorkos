/**
 * Plaintext per-extension settings store.
 *
 * Settings are stored in `{dorkHome}/extension-settings/{extensionId}.json`.
 * Unlike secrets, settings are not encrypted — they hold non-sensitive
 * configuration values (refresh intervals, display toggles, filter selections).
 *
 * @module shared/extension-settings
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withFileLock } from './atomic-write.js';
import { assertValidExtensionId } from './extension-id.js';

/**
 * Plaintext per-extension settings store using JSON files.
 *
 * Each extension gets its own JSON file under `{dorkHome}/extension-settings/`.
 * Writes use the atomic temp-file-then-rename pattern for safety.
 */
export class ExtensionSettingsStore {
  private readonly filePath: string;

  /**
   * Bind a store to one extension's settings file.
   *
   * @param dorkHome - Resolved data directory.
   * @param extensionId - The extension whose settings this store reads and writes.
   * @throws {InvalidExtensionIdError} If the id could name a file outside `dorkHome`.
   */
  constructor(dorkHome: string, extensionId: string) {
    assertValidExtensionId(extensionId);
    const dir = join(dorkHome, 'extension-settings');
    this.filePath = join(dir, `${extensionId}.json`);
  }

  /** Get a setting value by key. Returns null if not set. */
  async get<T extends string | number | boolean = string | number | boolean>(
    key: string
  ): Promise<T | null> {
    const data = await this.loadAll();
    return (data[key] as T) ?? null;
  }

  /** Set a setting value. Writes through to disk immediately. */
  async set(key: string, value: string | number | boolean): Promise<void> {
    await this.mutate((data) => {
      data[key] = value;
    });
  }

  /** Delete a setting value. Writes through to disk immediately. */
  async delete(key: string): Promise<void> {
    await this.mutate((data) => {
      delete data[key];
    });
  }

  /** Get all stored settings as a key-value record. */
  async getAll(): Promise<Record<string, string | number | boolean>> {
    return this.loadAll();
  }

  private async loadAll(): Promise<Record<string, string | number | boolean>> {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      return JSON.parse(raw) as Record<string, string | number | boolean>;
    } catch {
      return {};
    }
  }

  /**
   * Apply `change` to the settings file as one serialised read-modify-write, so
   * two callers setting different keys cannot each save their own view and drop
   * the other's setting.
   *
   * @param change - Mutates the freshly-read settings map in place.
   */
  private async mutate(
    change: (data: Record<string, string | number | boolean>) => void
  ): Promise<void> {
    await withFileLock(this.filePath, async (write) => {
      const data = await this.loadAll();
      change(data);
      await write(JSON.stringify(data, null, 2));
    });
  }
}
