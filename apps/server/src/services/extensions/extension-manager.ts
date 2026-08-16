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
import { isEnabled, setEnabled, type CoreExtensionInfo } from './extension-enable-resolution.js';
import { ExtensionDiscovery } from './extension-discovery.js';
import { ExtensionCompiler } from './extension-compiler.js';
import { ExtensionServerLifecycle } from './extension-server-lifecycle.js';
import { testClientExtension, testServerCompilation } from './extension-test-harness.js';
import { scaffoldExtension, buildCreateResult } from './extension-scaffolder.js';
import { configManager } from '../core/config-manager.js';
import { logConfigWrite } from '../core/operator/config-write.js';
import type { ExtensionTemplate } from './extension-templates.js';
import {
  toPublic,
  type CreateExtensionResult,
  type ReloadExtensionResult,
  type TestExtensionResult,
} from './extension-manager-types.js';
import { EXTENSION_NOT_APPROVED_CODE, mayRunExtensionCode } from './extension-load-policy.js';
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
  /**
   * Tier metadata for bundled core extensions, keyed by id (from
   * {@link ensureCoreExtensions} at startup). Drives origin tagging and
   * tier-aware enable resolution during {@link reload} (phase 3).
   */
  private coreExtensions: Map<string, CoreExtensionInfo>;

  constructor(dorkHome: string, coreExtensions: CoreExtensionInfo[] = []) {
    this.dorkHome = dorkHome;
    this.coreExtensions = new Map(coreExtensions.map((info) => [info.id, info]));
    this.discovery = new ExtensionDiscovery(dorkHome);
    this.compiler = new ExtensionCompiler(dorkHome);
    this.serverLifecycle = new ExtensionServerLifecycle(dorkHome, this.compiler);
  }

  /**
   * Expose the internal {@link ExtensionCompiler} so the marketplace install
   * pipeline can share the same instance (and therefore the same esbuild
   * cache) as the extension system rather than constructing a parallel one.
   */
  getCompiler(): ExtensionCompiler {
    return this.compiler;
  }

  /**
   * Initialize the extension system: clean stale cache, discover, compile, and start servers.
   *
   * One extension's server init is isolated from the rest by the `try` below:
   * this loop runs every enabled server-side extension in one boot pass, so an
   * unexpected throw from one (as opposed to the ordinary `{ ok: false }`
   * result {@link ExtensionServerLifecycle.initialize} returns for an expected
   * failure) must not abort the loop and leave every extension AFTER it
   * unstarted too. The failure is still logged at `error` with the extension's
   * id, so it stays visible rather than silently skipped.
   *
   * @param cwd - Current working directory (null if none active)
   */
  async initialize(cwd: string | null): Promise<void> {
    this.currentCwd = cwd;
    await this.compiler.cleanStaleCache();
    await this.reload();

    for (const record of this.extensions.values()) {
      if (this.needsServer(record)) {
        try {
          const result = await this.serverLifecycle.initialize(record.id, record);
          if (!result.ok) {
            logger.warn(`[Extensions] Server init skipped for ${record.id}: ${result.error}`);
          }
        } catch (err) {
          logger.error(
            `[Extensions] Server init threw an unexpected error for ${record.id} — skipping it and continuing with the rest`,
            err
          );
        }
      }
    }
  }

  /** Re-scan filesystem and recompile changed extensions. */
  async reload(): Promise<ExtensionRecordPublic[]> {
    const config = configManager.get('extensions');
    const records = await this.discovery.discover(this.currentCwd, config, this.coreExtensions);

    this.extensions.clear();
    for (const rec of records) {
      this.extensions.set(rec.id, rec);
    }

    await this.compileEnabled();
    return this.listPublic();
  }

  /**
   * Reload a single extension: recompile and update its record.
   *
   * Refuses an extension the user has turned OFF. Without that check this method
   * silently turned a disabled extension back on: {@link applyCompileResult} writes
   * `status = 'compiled'` over whatever the status was, and `'compiled'` is one of
   * the statuses {@link ExtensionServerLifecycle.initialize} accepts — so
   * `reload_extensions --id <a-disabled-extension>` mounted its routes and ran its
   * `server.ts`, with the cockpit still showing the toggle as off.
   *
   * The question is asked of {@link isEnabled} against stored config, NOT of
   * `record.status`, precisely because the status field is what the bug corrupts.
   * Config is the user's decision; status is a derived cache of it.
   *
   * A compile error does not trip this. `compile_error` leaves config untouched, so
   * `isEnabled` still says yes and the next reload after a fix goes straight
   * through — the edit-fix-reload loop keeps working.
   */
  async reloadExtension(id: string): Promise<ReloadExtensionResult> {
    const record = this.extensions.get(id);
    if (!record) throw new Error(`Extension '${id}' not found`);

    if (!isEnabled(id, configManager.get('extensions'), this.coreExtensions)) {
      throw new Error(
        `Extension '${id}' is turned off, so DorkOS did not reload it. Nothing about it ran. ` +
          `Turn it on in Settings > Extensions in DorkOS first, then reload.`
      );
    }

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
    const { approvedToRun } = configManager.get('extensions');
    return Array.from(this.extensions.values()).map((record) => toPublic(record, approvedToRun));
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
      // Route through the deviation-list resolver so the correct list is
      // mutated (default-on core → `disabled`; everything else → `enabled`).
      const before = configManager.get('extensions');
      const next = setEnabled(id, true, before, this.coreExtensions);
      configManager.set('extensions', next);
      logConfigWrite(
        'the extensions manager',
        'extensions',
        before,
        configManager.get('extensions')
      );

      if (record.hasServerEntry || record.hasDataProxy) {
        const serverResult = await this.serverLifecycle.initialize(id, record);
        if (!serverResult.ok) {
          logger.warn(`[Extensions] Server init failed for ${id}: ${serverResult.error}`);
        }
      }
    }

    return {
      extension: toPublic(record, configManager.get('extensions').approvedToRun),
      reloadRequired: true,
    };
  }

  /** Disable an extension: remove from config. */
  async disable(
    id: string
  ): Promise<{ extension: ExtensionRecordPublic; reloadRequired: boolean } | null> {
    const record = this.extensions.get(id);
    if (!record) return null;

    // Core extensions may be locked on (`canDisable: false`) — refuse to disable
    // them. Defense in depth behind the settings UI, which hides the toggle.
    if (record.origin === 'core' && this.coreExtensions.get(id)?.canDisable === false) {
      return null;
    }

    await this.serverLifecycle.shutdown(id);

    // Route through the deviation-list resolver so the correct list is mutated.
    const before = configManager.get('extensions');
    const next = setEnabled(id, false, before, this.coreExtensions);
    configManager.set('extensions', next);
    logConfigWrite('the extensions manager', 'extensions', before, configManager.get('extensions'));

    record.status = 'disabled';
    record.bundleReady = false;
    record.error = undefined;

    return {
      extension: toPublic(record, configManager.get('extensions').approvedToRun),
      reloadRequired: true,
    };
  }

  /**
   * Record that a person approved this extension to run code inside the DorkOS
   * server process, then start it (DOR-516).
   *
   * Only the caller-facing surfaces may call this, and only after they have
   * established that a PERSON asked: the routes in `routes/extensions.ts` apply the
   * same bar `PATCH /api/config` applies to any `operator-only` setting. There is
   * deliberately no MCP tool for it — see `extension-load-policy.ts`.
   *
   * Starting the extension here is what makes one click enough. Approval alone
   * would leave a full-stack extension compiled but unmounted until the next
   * restart, which reads as the approval not having worked.
   *
   * @param id - Extension id to approve.
   * @returns The updated public record, or `null` when no such extension exists.
   */
  async approveToRun(id: string): Promise<ExtensionRecordPublic | null> {
    const record = this.extensions.get(id);
    if (!record) return null;

    const extensions = configManager.get('extensions');
    if (!extensions.approvedToRun.includes(id)) {
      configManager.set('extensions', {
        ...extensions,
        approvedToRun: [...extensions.approvedToRun, id],
      });
      logConfigWrite(
        'approving an extension to run',
        'extensions',
        extensions,
        configManager.get('extensions')
      );
    }

    if (this.needsServer(record)) {
      const result = await this.serverLifecycle.initialize(id, record);
      if (!result.ok) {
        logger.warn(`[Extensions] Server init after approval failed for ${id}: ${result.error}`);
      }
    }

    return toPublic(record, configManager.get('extensions').approvedToRun);
  }

  /**
   * Withdraw a person's approval for this extension to run code in the server, and
   * stop it immediately.
   *
   * Withdrawing is not the same as disabling: the extension stays on and its client
   * bundle still loads in the browser, but DorkOS stops executing its code in-process.
   *
   * @param id - Extension id to revoke.
   * @returns The updated public record, or `null` when no such extension exists.
   */
  async revokeRunApproval(id: string): Promise<ExtensionRecordPublic | null> {
    const record = this.extensions.get(id);
    if (!record) return null;

    await this.forgetRunApproval(id);

    return toPublic(record, configManager.get('extensions').approvedToRun);
  }

  /**
   * Drop a stored run approval and stop the extension, for an id whose code is
   * being REPLACED or removed rather than judged (DOR-516).
   *
   * The marketplace uninstall flow calls this for every extension a package
   * bundled, which is also what makes an update re-ask: an update is an uninstall
   * followed by a fresh install (`MarketplaceInstaller.update`), so `foo` v2
   * arriving under the name of an approved `foo` v1 is different code and gets a
   * different decision. Without it, `marketplace_install` — tier `act`, always
   * allowed — could put any code at all behind an approval a person gave to
   * something else.
   *
   * Unlike {@link revokeRunApproval} this needs no discovery record: by the time
   * an uninstall runs, the extension's files may already be staged away, and the
   * approval has to be forgotten regardless.
   *
   * @param id - Extension id whose approval is no longer about the code on disk.
   */
  async forgetRunApproval(id: string): Promise<void> {
    const extensions = configManager.get('extensions');
    if (extensions.approvedToRun.includes(id)) {
      configManager.set('extensions', {
        ...extensions,
        approvedToRun: extensions.approvedToRun.filter((eid) => eid !== id),
      });
      logConfigWrite(
        'withdrawing an extension run approval',
        'extensions',
        extensions,
        configManager.get('extensions')
      );
      logger.info(`[Extensions] Forgot the run approval for ${id} — its code is being replaced`);
    }

    await this.serverLifecycle.shutdown(id);
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

  /**
   * Read a compiled bundle for serving to the client.
   *
   * ## The client half of the load approval (DOR-516)
   *
   * An extension a person has not approved has no bundle here, exactly as if it
   * had never compiled. The approval gate is at this one method rather than in the
   * client loader because this is the choke point: `GET /api/extensions/:id/bundle`
   * is the only way a bundle reaches a browser, and anything that fetches that URL
   * directly has to come through here too.
   *
   * Running in the browser is not a lesser kind of running. The bundle is
   * same-origin JavaScript on the cockpit page, so it inherits the person's session
   * on every request it makes — including `POST /api/extensions/<id>/approve`,
   * which would let an agent's own client code approve the agent's server code. It
   * is also on the very screen a person opens to decide. Serving it before the
   * decision was the whole gap.
   *
   * @param id - Extension id.
   * @returns The compiled bundle, or `null` when there is nothing this caller may
   *   be given — not compiled, or not approved to run.
   */
  async readBundle(id: string): Promise<string | null> {
    const record = this.extensions.get(id);
    if (!record || !['compiled', 'active'].includes(record.status) || !record.sourceHash) {
      return null;
    }
    if (!mayRunExtensionCode(id, record.origin, configManager.get('extensions').approvedToRun)) {
      logger.warn(
        `[Extensions] Bundle withheld for ${id}: waiting for a person to approve it ` +
          `(${EXTENSION_NOT_APPROVED_CODE})`
      );
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

  /**
   * Compile all enabled extensions, updating their records with results.
   *
   * Same isolation as {@link initialize}'s server-side loop, and for the
   * same reason: an unexpected throw from `compiler.compile()` for one
   * extension must not abort compilation for every extension after it in
   * this pass. `compiler.compile()` itself now degrades most known
   * failures (an unreadable entry file, a cache directory it can't
   * create) to an `{ error }` result rather than throwing — this `try` is
   * the remaining backstop for anything that doesn't.
   */
  private async compileEnabled(): Promise<void> {
    const enabled = Array.from(this.extensions.values()).filter((r) => r.status === 'enabled');
    for (const record of enabled) {
      try {
        const result = await this.compiler.compile(record);
        applyCompileResult(record, result);
      } catch (err) {
        logger.error(
          `[Extensions] Compile threw an unexpected error for ${record.id} — skipping it and continuing with the rest`,
          err
        );
        record.status = 'compile_error';
        record.error = {
          code: 'compilation_failed',
          message: err instanceof Error ? err.message : String(err),
        };
        record.bundleReady = false;
      }
    }
  }
}
