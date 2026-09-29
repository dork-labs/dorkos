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
import { toRecordError, type ActiveServerExtension } from './extension-manager-types.js';
import {
  EXTENSION_NOT_APPROVED_CODE,
  describeExtensionLoadRefusal,
  mayRunExtensionCode,
} from './extension-load-policy.js';
import { configManager } from '../core/config-manager.js';
import { getExtensionInbox } from './inbox/extension-inbox.js';
import { logger } from '../../lib/logger.js';

const require = createRequire(import.meta.url);

/**
 * Everything the running instance of an extension was built from, as one
 * comparable string: the directory it was read from, the manifest fields that
 * decide what gets mounted, and — for an extension with a server entry — the
 * content hash of its compiled server bundle.
 *
 * This is what makes {@link ExtensionServerLifecycle.initialize} idempotent. The
 * client asks the server to initialize every server-side extension on every page
 * load and every tab, and before this each of those tore the extension down and
 * re-evaluated its module (DOR-1336).
 *
 * The server bundle's hash is the one that matters, not `record.sourceHash` —
 * that field is the CLIENT bundle's hash, which answers a different question and
 * would have missed an edited `server.ts`.
 *
 * The bundle hash covers everything `server.ts` imports, because it is the
 * hash of the bundled output (`ExtensionCompiler.compileServer`, DOR-2491): an
 * edit to a helper module changes the bundle and so restarts the extension,
 * while an edit that leaves the output identical does not.
 *
 * @param record - The extension's discovery record.
 * @param serverSourceHash - Content hash of the compiled server bundle, or
 *   `null` for a proxy-only extension (there is no server source to hash).
 */
function buildSourceKey(record: ExtensionRecord, serverSourceHash: string | null): string {
  return JSON.stringify({
    path: path.resolve(record.path),
    runPath: record.runPath ?? null,
    version: record.manifest.version,
    serverEntryPath: record.serverEntryPath ?? null,
    dataProxy: record.manifest.dataProxy ?? null,
    serverSourceHash,
  });
}

/**
 * How long an extension's server `register()` may take to finish.
 *
 * Every re-scan runs one at a time (`ExtensionManager`), and starting a server
 * half is part of one. A `register()` that never settles would hold the queue
 * forever: installs would hang, and a copy that should have been stopped
 * would keep running. So DorkOS stops waiting, marks the extension as one
 * that couldn't start, releases everything it set up, and moves on.
 */
export const REGISTER_TIMEOUT_MS = 15_000;

/** Why a server half did not start in time, as its card shows it. */
const REGISTER_TIMEOUT_ERROR = 'server_start_timeout';

/**
 * Manages the lifecycle of server-side extensions: compile, load, route, and teardown.
 *
 * Each active extension gets an Express Router mounted at `/api/ext/{id}/*`.
 * Proxy-only extensions (no server.ts) get auto-generated proxy routes.
 * Extensions with server.ts get custom routes + optional proxy alongside.
 */
export class ExtensionServerLifecycle {
  private serverExtensions = new Map<string, ActiveServerExtension>();

  /**
   * Build the lifecycle for one DorkOS data directory.
   *
   * @param dorkHome - DorkOS's data directory.
   * @param compiler - The shared extension compiler.
   * @param registerTimeoutMs - How long an extension's `register()` may take
   *   before DorkOS stops waiting ({@link REGISTER_TIMEOUT_MS}).
   */
  constructor(
    private readonly dorkHome: string,
    private readonly compiler: ExtensionCompiler,
    private readonly registerTimeoutMs: number = REGISTER_TIMEOUT_MS
  ) {}

  /**
   * Initialize a server-side extension: compile, load, and register routes.
   *
   * ## The one place server-side extension code starts running
   *
   * Every route, tool, and internal flow that can make DorkOS execute an
   * extension's `server.ts` arrives here — startup (`ExtensionManager.initialize`),
   * `enable` (reached by `POST /api/extensions/:id/enable`, a marketplace install
   * via `install-plugin.ts`, and a Shape apply via `apply-shape.ts`),
   * `initializeServer` (`POST /api/extensions/:id/init-server`), and
   * `reloadExtension` (the `reload_extensions --id` tool). That is why the approval
   * gate below sits HERE rather than on each caller: the surfaces outnumber the
   * brief for this work by more than two to one, and a check on the tool would have
   * left every route walking around it — the DOR-467 shape. A new caller inherits
   * the gate by construction instead of having to remember it.
   *
   * ## Idempotent: asking twice is not asking for a restart
   *
   * An extension that is already running, built from the same source
   * ({@link buildSourceKey}), is left alone. The client POSTs
   * `/api/extensions/:id/init-server` for every server-side extension on every
   * page load and every tab, so the unconditional shutdown this used to start
   * with restarted the marketplace extension seconds after boot and again on
   * every tab — cancelling its scheduled work and re-evaluating its module for
   * no reason (DOR-1336).
   *
   * A caller that means "restart this, unchanged or not" calls {@link shutdown}
   * first, which is exactly what {@link ExtensionManager.reloadExtension} — the
   * `reload_extensions --id` tool — already does.
   *
   * Compilation now happens BEFORE the teardown, since its hash is what decides
   * whether to tear anything down. A compile failure therefore leaves the
   * running instance serving its old code rather than killing it, which is the
   * better of the two: a typo saved into an extension's `server.ts` no longer
   * takes the working version down with it. The record's `serverError` records
   * that, so "the old version is still serving" is something the cockpit shows
   * rather than something it hides — while `status` stays as it was, leaving the
   * extension's own client bundle loadable.
   *
   * @param id - Extension identifier
   * @param record - The extension's discovery record
   * @returns Result with ok flag and optional error message
   */
  async initialize(id: string, record: ExtensionRecord): Promise<{ ok: boolean; error?: string }> {
    const active = this.serverExtensions.get(id);
    const hasServerCapability = record.hasServerEntry || record.hasDataProxy;
    if (!hasServerCapability || !['enabled', 'compiled', 'active'].includes(record.status)) {
      return { ok: false, error: 'Extension has no server entry or is not enabled' };
    }

    // A person approves an extension once before its code may run in this process
    // (DOR-516). Checked before compiling and before any mount, and it covers the
    // `dataProxy`-only branch below as well as the `require()` of a server entry:
    // a proxy hands extension-authored config the server's outbound reach and its
    // stored secrets, which is the same consent question one step quieter.
    if (!mayRunExtensionCode(record, configManager.get('extensions'))) {
      logger.warn(
        `[Extensions] Server init refused for ${id}: waiting for a person to approve it ` +
          `(${EXTENSION_NOT_APPROVED_CODE})`
      );
      return { ok: false, error: describeExtensionLoadRefusal(id) };
    }

    // Proxy-only (dataProxy without server.ts) — no compilation needed
    if (record.hasDataProxy && !record.hasServerEntry) {
      const sourceKey = buildSourceKey(record, null);
      if (active?.sourceKey === sourceKey) {
        logger.debug(`[Extensions] Proxy router for ${id} is already running, unchanged`);
        return { ok: true };
      }

      await this.shutdown(id);
      const proxyRouter = createProxyRouter(id, record.manifest.dataProxy!, this.dorkHome);
      this.serverExtensions.set(id, {
        extensionId: id,
        router: proxyRouter,
        cleanup: null,
        scheduledCleanups: [],
        sourceKey,
      });
      logger.info(`[Extensions] Proxy router mounted for ${id}`);
      return { ok: true };
    }

    // Compile server bundle
    const compiled = await this.compiler.compileServer(record);
    if ('error' in compiled) {
      // The compile now happens before the teardown, so a broken `server.ts`
      // leaves the previous version answering requests. Say so on the record —
      // an extension quietly serving code that no longer matches its source must
      // not read as healthy in the cockpit (DOR-1336 review). Nothing is marked
      // when there was nothing running: that failure is the caller's to report,
      // and the client bundle it may still have is not in question.
      //
      // `serverError`, NOT `status`/`error`: `status` is one field for the whole
      // extension and it is what `ExtensionManager.readBundle` and the client
      // loader gate the CLIENT bundle on, so writing `compile_error` here would
      // pull a working UI off the screen in every new tab over a server-side
      // failure (DOR-1336 review round 2).
      if (active) {
        record.serverError = toRecordError(compiled.error);
        logger.warn(
          `[Extensions] ${id} failed to compile, so the version already running keeps serving ` +
            `until this is fixed: ${compiled.error.message}`
        );
      }
      return { ok: false, error: compiled.error.message };
    }

    const sourceKey = buildSourceKey(record, compiled.sourceHash);
    if (active?.sourceKey === sourceKey) {
      logger.debug(`[Extensions] Server for ${id} is already running, unchanged`);
      return { ok: true };
    }

    // Shut down the stale instance before its replacement takes over
    await this.shutdown(id);

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

    let registered: (() => void) | undefined;
    try {
      const mod = require(tempFile);
      const registerFn = mod.default ?? mod;
      if (typeof registerFn !== 'function') {
        return { ok: false, error: 'Server entry does not export a register function' };
      }

      const router = Router();
      const { ctx, getScheduledCleanups, releaseListeners, dispose } = createDataProviderContext({
        extensionId: id,
        // A copy that runs by origin runs from its verified snapshot, so what
        // it reaches relative to itself at runtime is the snapshot's too.
        extensionDir: record.runPath ?? record.path,
        dorkHome: this.dorkHome,
        extensionName: record.manifest.name,
      });
      // A register() that throws after adding an account listener or advisor
      // must not leave it behind: this instance never becomes active.
      registered = releaseListeners;

      const outcome = await settleWithin(
        Promise.resolve(registerFn(router, ctx)),
        this.registerTimeoutMs
      );
      if (outcome.timedOut) {
        // It may still finish later. Whatever it hands back then is cleaned up
        // and never mounted: this instance is not active.
        void outcome.late.then(
          (late) => {
            if (typeof late === 'function') (late as () => void)();
          },
          () => undefined
        );
        // Cancel what it scheduled, release what it registered, and make
        // anything it still tries later a no-op: a retry then starts a fresh
        // instance, and nothing of this one keeps running beside it.
        dispose();
        registered = undefined;
        const seconds = Math.round(this.registerTimeoutMs / 1000);
        const message =
          `${record.manifest.name} couldn't start: its server side didn't finish starting within ` +
          `${seconds} seconds, so DorkOS stopped waiting and left it off. Reload it to try again.`;
        record.serverError = { code: REGISTER_TIMEOUT_ERROR, message };
        logger.warn(`[Extensions] Server init timed out for ${id} after ${seconds}s`);
        return { ok: false, error: message };
      }
      const result = outcome.value;
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
        releaseListeners,
        sourceKey,
      });
      registered = undefined;

      // Its inbox decisions show again, escalate again, and a deadline that
      // passed while it was down fires now that it can answer (spec
      // `flow-multiproject` §7.1).
      getExtensionInbox()?.markRunning(id, record.manifest.name);

      // A fixed `server.ts` took over, so the failure mark this method wrote
      // above no longer describes anything.
      record.serverError = undefined;

      logger.info(`[Extensions] Server initialized for ${id}`);
      return { ok: true };
    } catch (err) {
      registered?.();
      logger.error(`[Extensions] Server init failed for ${id}:`, err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Shut down a server-side extension: cancel tasks, call cleanup, remove its
   * account listeners and advisor, remove router.
   *
   * @param id - Extension identifier
   */
  async shutdown(id: string): Promise<void> {
    const active = this.serverExtensions.get(id);
    if (!active) return;

    // Nobody can answer its decisions while it is down: hide them and stop
    // their clocks before its handler goes away.
    getExtensionInbox()?.markStopped(id);

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

    // After the extension's own cleanup, so it can still unregister gracefully;
    // whatever it left behind goes now.
    active.releaseListeners?.();

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

/**
 * Wait for `promise`, but no longer than `ms`.
 *
 * @param promise - What to wait for.
 * @param ms - The longest to wait.
 * @returns Its value, or that it did not settle in time (with the promise, so
 *   the caller can clean up whatever it resolves to later).
 */
async function settleWithin<T>(
  promise: Promise<T>,
  ms: number
): Promise<{ timedOut: false; value: T } | { timedOut: true; late: Promise<T> }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
    timer.unref?.();
  });
  try {
    const first = await Promise.race([promise.then((value) => ({ value })), timeout]);
    if (first === 'timeout') return { timedOut: true, late: promise };
    return { timedOut: false, value: first.value };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
