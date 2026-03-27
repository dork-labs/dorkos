import type { ExtensionRecord, ExtensionRecordPublic } from '@dorkos/extension-api';
import { ExtensionDiscovery } from './extension-discovery.js';
import { ExtensionCompiler } from './extension-compiler.js';
import { configManager } from '../core/config-manager.js';

/** Strip server-internal fields from ExtensionRecord for client consumption. */
function toPublic(record: ExtensionRecord): ExtensionRecordPublic {
  return {
    id: record.id,
    manifest: record.manifest,
    status: record.status,
    scope: record.scope,
    error: record.error,
    bundleReady: record.bundleReady,
  };
}

/**
 * Orchestrates the extension lifecycle by combining discovery, compilation,
 * and enable/disable persistence via ConfigManager.
 *
 * Acts as the facade for the extension system — routes, middleware, and other
 * services interact with extensions exclusively through this class.
 */
export class ExtensionManager {
  private discovery: ExtensionDiscovery;
  private compiler: ExtensionCompiler;
  private extensions: Map<string, ExtensionRecord> = new Map();
  private currentCwd: string | null = null;

  constructor(dorkHome: string) {
    this.discovery = new ExtensionDiscovery(dorkHome);
    this.compiler = new ExtensionCompiler(dorkHome);
  }

  /**
   * Initialize the extension system: clean stale cache, discover, and compile.
   *
   * @param cwd - Current working directory (null if none active)
   */
  async initialize(cwd: string | null): Promise<void> {
    this.currentCwd = cwd;

    // Clean stale cache entries on startup
    await this.compiler.cleanStaleCache();

    // Discover all extensions and compile enabled ones
    await this.reload();
  }

  /**
   * Re-scan filesystem and recompile changed extensions.
   * Called on startup, after CWD change, or via POST /api/extensions/reload.
   */
  async reload(): Promise<ExtensionRecordPublic[]> {
    const enabledIds = configManager.get('extensions').enabled;
    const records = await this.discovery.discover(this.currentCwd, enabledIds);

    // Clear existing extensions and re-populate
    this.extensions.clear();
    for (const rec of records) {
      this.extensions.set(rec.id, rec);
    }

    // Compile all enabled extensions
    await this.compileEnabled();

    return this.listPublic();
  }

  /**
   * Get all extensions as public records (for API responses).
   */
  listPublic(): ExtensionRecordPublic[] {
    return Array.from(this.extensions.values()).map(toPublic);
  }

  /**
   * Get a single extension by ID.
   */
  get(id: string): ExtensionRecord | undefined {
    return this.extensions.get(id);
  }

  /**
   * Enable an extension: add to config, trigger compilation.
   *
   * @param id - Extension identifier
   * @returns Updated public record and reload flag, or null if not found / not enableable
   */
  async enable(
    id: string
  ): Promise<{ extension: ExtensionRecordPublic; reloadRequired: boolean } | null> {
    const record = this.extensions.get(id);
    if (!record) return null;

    // Reject if incompatible or invalid
    if (record.status === 'incompatible' || record.status === 'invalid') {
      return null;
    }

    // Trigger compilation before persisting to config — only persist on success
    record.status = 'enabled';
    const compileResult = await this.compiler.compile(record);

    if ('error' in compileResult) {
      record.status = 'compile_error';
      record.error = {
        code: compileResult.error.code,
        message: compileResult.error.message,
        details: compileResult.error.errors.map((e) => e.text).join('\n'),
      };
      record.sourceHash = compileResult.sourceHash;
      record.bundleReady = false;
      // Do NOT persist to config — compilation failed
    } else {
      record.status = 'compiled';
      record.sourceHash = compileResult.sourceHash;
      record.bundleReady = true;
      record.error = undefined;

      // Only persist to config on successful compilation
      const config = configManager.get('extensions');
      if (!config.enabled.includes(id)) {
        configManager.set('extensions', {
          enabled: [...config.enabled, id],
        });
      }
    }

    return { extension: toPublic(record), reloadRequired: true };
  }

  /**
   * Disable an extension: remove from config.
   *
   * @param id - Extension identifier
   * @returns Updated public record and reload flag, or null if not found
   */
  async disable(
    id: string
  ): Promise<{ extension: ExtensionRecordPublic; reloadRequired: boolean } | null> {
    const record = this.extensions.get(id);
    if (!record) return null;

    // Remove from enabled list in config
    const config = configManager.get('extensions');
    configManager.set('extensions', {
      enabled: config.enabled.filter((eid: string) => eid !== id),
    });

    record.status = 'disabled';
    record.bundleReady = false;
    record.error = undefined;

    return { extension: toPublic(record), reloadRequired: true };
  }

  /**
   * Read a compiled bundle for serving to the client.
   *
   * @param id - Extension identifier
   * @returns Compiled JS string, or null if not available
   */
  async readBundle(id: string): Promise<string | null> {
    const record = this.extensions.get(id);
    if (!record) return null;
    if (record.status !== 'compiled' && record.status !== 'active') return null;
    if (!record.sourceHash) return null;

    return this.compiler.readBundle(id, record.sourceHash);
  }

  /**
   * Report that a client has activated an extension.
   *
   * @param id - Extension identifier
   */
  reportActivated(id: string): void {
    const record = this.extensions.get(id);
    if (record && record.status === 'compiled') {
      record.status = 'active';
    }
  }

  /**
   * Report that activation failed for an extension.
   *
   * @param id - Extension identifier
   * @param error - Error message from the client
   */
  reportActivateError(id: string, error: string): void {
    const record = this.extensions.get(id);
    if (record) {
      record.status = 'activate_error';
      record.error = { code: 'activate_error', message: error };
    }
  }

  /**
   * Update the CWD and return the diff of extension IDs (added/removed).
   *
   * @param newCwd - New working directory (null to clear)
   * @returns Object with arrays of added and removed extension IDs
   */
  async updateCwd(newCwd: string | null): Promise<{ added: string[]; removed: string[] }> {
    const oldIds = new Set(this.extensions.keys());
    this.currentCwd = newCwd;
    await this.reload();
    const newIds = new Set(this.extensions.keys());

    const added = [...newIds].filter((id) => !oldIds.has(id));
    const removed = [...oldIds].filter((id) => !newIds.has(id));

    return { added, removed };
  }

  /** Compile all enabled extensions, updating their records with results. */
  private async compileEnabled(): Promise<void> {
    const enabled = Array.from(this.extensions.values()).filter((r) => r.status === 'enabled');

    for (const record of enabled) {
      const result = await this.compiler.compile(record);
      if ('error' in result) {
        record.status = 'compile_error';
        record.error = {
          code: result.error.code,
          message: result.error.message,
          details: result.error.errors.map((e) => e.text).join('\n'),
        };
        record.sourceHash = result.sourceHash;
        record.bundleReady = false;
      } else {
        record.status = 'compiled';
        record.sourceHash = result.sourceHash;
        record.bundleReady = true;
        record.error = undefined;
      }
    }
  }
}
