/**
 * Server-side extension lifecycle management.
 *
 * Handles compilation, loading, and routing for extensions that declare
 * `serverCapabilities` or `dataProxy` in their manifest. Operates as a
 * collaborator to {@link ExtensionManager} — never called directly by routes.
 *
 * @module services/extensions/extension-server-lifecycle
 */
import fs from 'fs/promises';
import path from 'path';
import { createRequire } from 'node:module';
import { Router } from 'express';
import type { ExtensionRecord } from '@dorkos/extension-api';
import type { ExtensionCompiler } from './extension-compiler.js';
import { createProxyRouter } from './extension-proxy.js';
import { createDataProviderContext } from './extension-server-api-factory.js';
import type { ActiveServerExtension } from './extension-manager-types.js';
import { logger } from '../../lib/logger.js';

const require = createRequire(import.meta.url);

/**
 * Manages the lifecycle of server-side extensions: compile, load, route, and teardown.
 *
 * Each active extension gets an Express Router mounted at `/api/ext/{id}/*`.
 * Proxy-only extensions (no server.ts) get auto-generated proxy routes.
 * Extensions with server.ts get custom routes + optional proxy alongside.
 */
export class ExtensionServerLifecycle {
  private serverExtensions = new Map<string, ActiveServerExtension>();

  constructor(
    private readonly dorkHome: string,
    private readonly compiler: ExtensionCompiler
  ) {}

  /**
   * Initialize a server-side extension: compile, load, and register routes.
   *
   * @param id - Extension identifier
   * @param record - The extension's discovery record
   * @returns Result with ok flag and optional error message
   */
  async initialize(id: string, record: ExtensionRecord): Promise<{ ok: boolean; error?: string }> {
    const hasServerCapability = record.hasServerEntry || record.hasDataProxy;
    if (!hasServerCapability || !['enabled', 'compiled', 'active'].includes(record.status)) {
      return { ok: false, error: 'Extension has no server entry or is not enabled' };
    }

    // Shut down existing instance if reloading
    await this.shutdown(id);

    // Proxy-only (dataProxy without server.ts) — no compilation needed
    if (record.hasDataProxy && !record.hasServerEntry) {
      const proxyRouter = createProxyRouter(id, record.manifest.dataProxy!, this.dorkHome);
      this.serverExtensions.set(id, {
        extensionId: id,
        router: proxyRouter,
        cleanup: null,
        scheduledCleanups: [],
      });
      logger.info(`[Extensions] Proxy router mounted for ${id}`);
      return { ok: true };
    }

    // Compile server bundle
    const compiled = await this.compiler.compileServer(record);
    if ('error' in compiled) {
      return { ok: false, error: compiled.error.message };
    }

    // Write temp file for require()
    const tempDir = path.join(this.dorkHome, 'cache', 'extensions', 'server', '_run');
    await fs.mkdir(tempDir, { recursive: true });
    const tempFile = path.join(tempDir, `${id}.js`);
    await fs.writeFile(tempFile, compiled.code, 'utf-8');

    try {
      delete require.cache[require.resolve(tempFile)];
    } catch {
      // Not in cache yet
    }

    try {
      const mod = require(tempFile);
      const registerFn = mod.default ?? mod;
      if (typeof registerFn !== 'function') {
        return { ok: false, error: 'Server entry does not export a register function' };
      }

      const router = Router();
      const { ctx, getScheduledCleanups } = createDataProviderContext({
        extensionId: id,
        extensionDir: record.path,
        dorkHome: this.dorkHome,
      });

      const result = await registerFn(router, ctx);
      const cleanup = typeof result === 'function' ? result : null;

      // Mount proxy routes alongside custom routes for hybrid extensions
      if (record.hasDataProxy && record.manifest.dataProxy) {
        const proxyRouter = createProxyRouter(id, record.manifest.dataProxy, this.dorkHome);
        router.use(proxyRouter);
      }

      this.serverExtensions.set(id, {
        extensionId: id,
        router,
        cleanup,
        scheduledCleanups: getScheduledCleanups(),
      });

      logger.info(`[Extensions] Server initialized for ${id}`);
      return { ok: true };
    } catch (err) {
      logger.error(`[Extensions] Server init failed for ${id}:`, err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Shut down a server-side extension: cancel tasks, call cleanup, remove router.
   *
   * @param id - Extension identifier
   */
  async shutdown(id: string): Promise<void> {
    const active = this.serverExtensions.get(id);
    if (!active) return;

    for (const cancel of active.scheduledCleanups) {
      try {
        cancel();
      } catch {
        /* swallow cancellation errors */
      }
    }

    if (active.cleanup) {
      try {
        active.cleanup();
      } catch (err) {
        logger.warn(`[Extensions] Cleanup error for ${id}:`, err);
      }
    }

    this.serverExtensions.delete(id);
    logger.info(`[Extensions] Server shutdown for ${id}`);
  }

  /**
   * Get the Express router for a server-side extension.
   *
   * @param id - Extension identifier
   * @returns The extension's router, or null if no server extension is active
   */
  getRouter(id: string): Router | null {
    return this.serverExtensions.get(id)?.router ?? null;
  }
}
