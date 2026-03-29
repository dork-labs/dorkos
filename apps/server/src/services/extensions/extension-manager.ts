/**
 * Orchestrates the extension lifecycle by combining discovery, compilation,
 * server lifecycle, and enable/disable persistence via ConfigManager.
 *
 * Acts as the facade for the extension system — routes, middleware, and other
 * services interact with extensions exclusively through this class. Internal
 * work is delegated to focused collaborators:
 *
 * - {@link ExtensionDiscovery} — filesystem scanning + manifest parsing
 * - {@link ExtensionCompiler} — esbuild compilation (client + server)
 * - {@link ExtensionServerLifecycle} — server-side init/shutdown/routing
 * - {@link scaffoldExtension} — new extension scaffolding
 * - {@link testClientExtension} / {@link testServerCompilation} — headless testing
 *
 * @module services/extensions/extension-manager
 */
import type { Router } from 'express';
import type { ExtensionRecord, ExtensionRecordPublic } from '@dorkos/extension-api';
import { ExtensionDiscovery } from './extension-discovery.js';
import { ExtensionCompiler } from './extension-compiler.js';
import { ExtensionServerLifecycle } from './extension-server-lifecycle.js';
import { testClientExtension, testServerCompilation } from './extension-test-harness.js';
import { scaffoldExtension, buildCreateResult } from './extension-scaffolder.js';
import { configManager } from '../core/config-manager.js';
import type { ExtensionTemplate } from './extension-templates.js';
import {
  toPublic,
  type CreateExtensionResult,
  type ReloadExtensionResult,
  type TestExtensionResult,
} from './extension-manager-types.js';
import { logger } from '../../lib/logger.js';

export type { CreateExtensionResult, ReloadExtensionResult, TestExtensionResult };

/** Apply a compile result to an extension record (DRY: used by enable, reload, compileEnabled). */
function applyCompileResult(
  record: ExtensionRecord,
  result: Awaited<ReturnType<ExtensionCompiler['compile']>>
): boolean {
  if ('error' in result) {
    record.status = 'compile_error';
    record.error = {
      code: result.error.code,
      message: result.error.message,
      details: result.error.errors.map((e) => e.text).join('\n'),
    };
    record.sourceHash = result.sourceHash;
    record.bundleReady = false;
    return false;
  }
  record.status = 'compiled';
  record.sourceHash = result.sourceHash;
  record.bundleReady = true;
  record.error = undefined;
  return true;
}

/**
 * Facade for the extension system.
 */
export class ExtensionManager {
  private dorkHome: string;
  private discovery: ExtensionDiscovery;
  private compiler: ExtensionCompiler;
  private serverLifecycle: ExtensionServerLifecycle;
  private extensions: Map<string, ExtensionRecord> = new Map();
  private currentCwd: string | null = null;

  constructor(dorkHome: string) {
    this.dorkHome = dorkHome;
    this.discovery = new ExtensionDiscovery(dorkHome);
    this.compiler = new ExtensionCompiler(dorkHome);
    this.serverLifecycle = new ExtensionServerLifecycle(dorkHome, this.compiler);
  }

  /**
   * Initialize the extension system: clean stale cache, discover, compile, and start servers.
   *
   * @param cwd - Current working directory (null if none active)
   */
  async initialize(cwd: string | null): Promise<void> {
    this.currentCwd = cwd;
    await this.compiler.cleanStaleCache();
    await this.reload();

    for (const record of this.extensions.values()) {
      if (this.needsServer(record)) {
        const result = await this.serverLifecycle.initialize(record.id, record);
        if (!result.ok) {
          logger.warn(`[Extensions] Server init skipped for ${record.id}: ${result.error}`);
        }
      }
    }
  }

  /** Re-scan filesystem and recompile changed extensions. */
  async reload(): Promise<ExtensionRecordPublic[]> {
    const enabledIds = configManager.get('extensions').enabled;
    const records = await this.discovery.discover(this.currentCwd, enabledIds);

    this.extensions.clear();
    for (const rec of records) {
      this.extensions.set(rec.id, rec);
    }

    await this.compileEnabled();
    return this.listPublic();
  }

  /** Reload a single extension: recompile and update its record. */
  async reloadExtension(id: string): Promise<ReloadExtensionResult> {
    const record = this.extensions.get(id);
    if (!record) throw new Error(`Extension '${id}' not found`);

    const compileResult = await this.compiler.compile(record);
    const ok = applyCompileResult(record, compileResult);

    if (!ok && 'error' in compileResult) {
      return {
        id,
        status: 'compile_error',
        bundleReady: false,
        sourceHash: compileResult.sourceHash,
        error: {
          code: compileResult.error.code,
          message: compileResult.error.message,
          errors: compileResult.error.errors,
        },
      };
    }

    if (record.hasServerEntry || record.hasDataProxy) {
      await this.serverLifecycle.shutdown(id);
      const serverResult = await this.serverLifecycle.initialize(id, record);
      if (!serverResult.ok) {
        logger.warn(`[Extensions] Server reload failed for ${id}: ${serverResult.error}`);
      }
    }

    return { id, status: 'compiled', bundleReady: true, sourceHash: record.sourceHash };
  }

  /** Compile and activate an extension headlessly to verify it loads. */
  async testExtension(id: string): Promise<TestExtensionResult> {
    const record = this.extensions.get(id);
    if (!record) throw new Error(`Extension '${id}' not found`);
    return testClientExtension(record, this.compiler);
  }

  /** Test server-side compilation without loading. */
  async testServerCompilation(id: string): Promise<string | null> {
    const record = this.extensions.get(id);
    if (!record) return null;
    return testServerCompilation(record, this.compiler);
  }

  /** Scaffold a new extension directory with manifest and starter code. */
  async createExtension(options: {
    name: string;
    description?: string;
    template: ExtensionTemplate;
    scope: 'global' | 'local';
  }): Promise<CreateExtensionResult> {
    const scaffoldResult = await scaffoldExtension({
      ...options,
      dorkHome: this.dorkHome,
      currentCwd: this.currentCwd,
    });

    await this.reload();
    await this.enable(options.name);

    const record = this.extensions.get(options.name);
    return buildCreateResult(scaffoldResult, options, record);
  }

  /** Get all extensions as public records (for API responses). */
  listPublic(): ExtensionRecordPublic[] {
    return Array.from(this.extensions.values()).map(toPublic);
  }

  /** Get a single extension by ID. */
  get(id: string): ExtensionRecord | undefined {
    return this.extensions.get(id);
  }

  /** Enable an extension: add to config, trigger compilation. */
  async enable(
    id: string
  ): Promise<{ extension: ExtensionRecordPublic; reloadRequired: boolean } | null> {
    const record = this.extensions.get(id);
    if (!record) return null;
    if (record.status === 'incompatible' || record.status === 'invalid') return null;

    record.status = 'enabled';
    const compileResult = await this.compiler.compile(record);
    const ok = applyCompileResult(record, compileResult);

    if (ok) {
      const config = configManager.get('extensions');
      if (!config.enabled.includes(id)) {
        configManager.set('extensions', { enabled: [...config.enabled, id] });
      }

      if (record.hasServerEntry || record.hasDataProxy) {
        const serverResult = await this.serverLifecycle.initialize(id, record);
        if (!serverResult.ok) {
          logger.warn(`[Extensions] Server init failed for ${id}: ${serverResult.error}`);
        }
      }
    }

    return { extension: toPublic(record), reloadRequired: true };
  }

  /** Disable an extension: remove from config. */
  async disable(
    id: string
  ): Promise<{ extension: ExtensionRecordPublic; reloadRequired: boolean } | null> {
    const record = this.extensions.get(id);
    if (!record) return null;

    await this.serverLifecycle.shutdown(id);

    const config = configManager.get('extensions');
    configManager.set('extensions', {
      enabled: config.enabled.filter((eid: string) => eid !== id),
    });

    record.status = 'disabled';
    record.bundleReady = false;
    record.error = undefined;

    return { extension: toPublic(record), reloadRequired: true };
  }

  /** Initialize server-side extension code (delegated to server lifecycle). */
  async initializeServer(id: string): Promise<{ ok: boolean; error?: string }> {
    const record = this.extensions.get(id);
    if (!record) return { ok: false, error: 'Extension not found' };
    return this.serverLifecycle.initialize(id, record);
  }

  /** Shut down a server-side extension (delegated to server lifecycle). */
  async shutdownServer(id: string): Promise<void> {
    return this.serverLifecycle.shutdown(id);
  }

  /** Get the Express router for a server-side extension. */
  getServerRouter(id: string): Router | null {
    return this.serverLifecycle.getRouter(id);
  }

  /** Read a compiled bundle for serving to the client. */
  async readBundle(id: string): Promise<string | null> {
    const record = this.extensions.get(id);
    if (!record || !['compiled', 'active'].includes(record.status) || !record.sourceHash) {
      return null;
    }
    return this.compiler.readBundle(id, record.sourceHash);
  }

  /** Report that a client has activated an extension. */
  reportActivated(id: string): void {
    const record = this.extensions.get(id);
    if (record && record.status === 'compiled') {
      record.status = 'active';
    }
  }

  /** Report that activation failed for an extension. */
  reportActivateError(id: string, error: string): void {
    const record = this.extensions.get(id);
    if (record) {
      record.status = 'activate_error';
      record.error = { code: 'activate_error', message: error };
    }
  }

  /** Update the CWD and return the diff of extension IDs (added/removed). */
  async updateCwd(newCwd: string | null): Promise<{ added: string[]; removed: string[] }> {
    const oldIds = new Set(this.extensions.keys());
    this.currentCwd = newCwd;
    await this.reload();
    const newIds = new Set(this.extensions.keys());

    return {
      added: [...newIds].filter((id) => !oldIds.has(id)),
      removed: [...oldIds].filter((id) => !newIds.has(id)),
    };
  }

  /** Whether a compiled extension needs server-side initialization. */
  private needsServer(record: ExtensionRecord): boolean {
    return (
      (record.hasServerEntry || record.hasDataProxy) &&
      ['compiled', 'active'].includes(record.status)
    );
  }

  /** Compile all enabled extensions, updating their records with results. */
  private async compileEnabled(): Promise<void> {
    const enabled = Array.from(this.extensions.values()).filter((r) => r.status === 'enabled');
    for (const record of enabled) {
      const result = await this.compiler.compile(record);
      applyCompileResult(record, result);
    }
  }
}
