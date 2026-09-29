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
import path from 'path';
import type { Router } from 'express';
import type { ExtensionRecord, ExtensionRecordPublic } from '@dorkos/extension-api';
import type { ExtensionApprovedSource } from '@dorkos/shared/config-schema';
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
  toRecordError,
  type CreateExtensionResult,
  type ReloadExtensionResult,
  type TestExtensionResult,
} from './extension-manager-types.js';
import {
  EXTENSION_NOT_APPROVED_CODE,
  approvedSourceOf,
  isApprovedCopy,
  mayRunExtensionCode,
} from './extension-load-policy.js';

import { logger } from '../../lib/logger.js';

/**
 * Why {@link ExtensionManager.dismissApproval} refused, when it did.
 *
 * - `not_found` — no extension has that id.
 * - `core` — it ships with DorkOS, so there is nothing to decline.
 * - `stale` — the copy on disk is no longer the one the person was shown.
 */
export type DismissApprovalRefusal = 'not_found' | 'core' | 'stale';

/**
 * The copy a person was shown when they answered: its path and version, and
 * the plugin that carried it when the caller knows it (`null` for a direct
 * install; absent means "not compared").
 */
export interface ExpectedCopy {
  /** Absent when the caller does not know it (the Settings card); then not compared. */
  path?: string;
  version: string;
  plugin?: string | null;
}

/**
 * Whether the record on disk is still exactly the copy a person was shown
 * (DOR-2517). An answer to an out-of-date row must never land on a copy that
 * took that one's place — another plugin, a project folder reusing the id, or
 * a newer version.
 *
 * @param record - The extension record now.
 * @param expected - The copy the person's row showed.
 */
export function isExpectedCopy(record: ExtensionRecord, expected: ExpectedCopy): boolean {
  if (expected.path !== undefined && path.resolve(expected.path) !== path.resolve(record.path)) {
    return false;
  }
  if (expected.version !== record.manifest.version) return false;
  if (expected.plugin !== undefined && expected.plugin !== (record.sourcePlugin ?? null)) {
    return false;
  }
  return true;
}

export type { CreateExtensionResult, ReloadExtensionResult, TestExtensionResult };

/**
 * Whether two working directories are the same one, comparing normalized
 * absolute paths so a trailing slash or a `.` segment does not read as a move.
 * Purely lexical — nothing here touches the filesystem — because this decides
 * whether to re-scan, and a directory that does not exist yet still deserves the
 * cheap answer.
 *
 * @param a - One working directory, or `null` for none.
 * @param b - The other working directory, or `null` for none.
 */
function isSameCwd(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return path.resolve(a) === path.resolve(b);
}

/** Apply a compile result to an extension record (DRY: used by enable, reload, compileEnabled). */
function applyCompileResult(
  record: ExtensionRecord,
  result: Awaited<ReturnType<ExtensionCompiler['compile']>>
): boolean {
  if ('error' in result) {
    record.status = 'compile_error';
    record.error = toRecordError(result.error);
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
  /** DorkOS's data directory, which every extension root is read relative to. */
  readonly dorkHome: string;
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
  /**
   * Who hears that the set of extensions waiting for a person may have changed
   * (DOR-2517). The Activity inbox's live source subscribes; see
   * `extension-approval-queue.ts`.
   */
  private changeListeners = new Set<() => void>();

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
    this.bindUnsourcedApprovals(records);

    await this.compileEnabled();
    this.emitChanged();
    return this.listPublic();
  }

  /**
   * Hear about every change that can move an extension into or out of the set
   * waiting for a person: a re-scan, a working-directory change, enabling or
   * disabling, approving, withdrawing an approval, or a "Not now" (DOR-2517).
   *
   * Says only that something MAY have changed. The listener reads the records
   * and diffs them itself, so a missed or doubled call cannot leave it wrong.
   *
   * @param listener - Called after each such change. Must not throw; a throw is
   *   logged and swallowed so it cannot fail the change that produced it.
   * @returns A function that removes the listener.
   */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /** Every discovered extension record, in discovery order. */
  listRecords(): ExtensionRecord[] {
    return Array.from(this.extensions.values());
  }

  /** Tell every {@link onChange} listener, isolating each one's failure. */
  private emitChanged(): void {
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch (err) {
        logger.warn('[Extensions] A change listener threw', err);
      }
    }
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
    const approvals = configManager.get('extensions');
    return Array.from(this.extensions.values()).map((record) => toPublic(record, approvals));
  }

  /**
   * Bind each approval given before approvals recorded their copy to the one copy
   * it could have been about: the extension installed directly under
   * `{dorkHome}/extensions/<id>` (DOR-2383).
   *
   * Before that change, discovery never read a plugin's extensions and dropped a
   * project copy of an approved id, so the direct install was the only copy an
   * id-only approval ever let run. Binding it on first sight keeps it running with
   * nothing to click. An approved id this pass finds only inside a plugin, or only
   * in a project, stays unbound and so counts as not approved: that copy is asked
   * about on its own. The config migration cannot do this, because it runs before
   * anything has looked at the disk.
   *
   * @param records - The records this discovery pass produced.
   */
  private bindUnsourcedApprovals(records: readonly ExtensionRecord[]): void {
    const before = configManager.get('extensions');
    const sources = before.approvedSources ?? {};
    const additions: Record<string, ExtensionApprovedSource> = {};
    for (const record of records) {
      if (!before.approvedToRun.includes(record.id) || sources[record.id]) continue;
      if (record.origin === 'core' || record.sourcePlugin) continue;
      const directInstall = path.join(path.resolve(this.dorkHome), 'extensions', record.id);
      if (path.resolve(record.path) !== directInstall) continue;
      additions[record.id] = approvedSourceOf(record);
    }
    if (Object.keys(additions).length === 0) return;
    configManager.set('extensions', {
      ...before,
      approvedSources: { ...sources, ...additions },
    });
    logConfigWrite(
      'recording which copy an earlier extension approval was for',
      'extensions',
      before,
      configManager.get('extensions')
    );
  }

  /** Get a single extension by ID. */
  get(id: string): ExtensionRecord | undefined {
    return this.extensions.get(id);
  }

  /** Enable an extension: add to config, trigger compilation. */
  async enable(
    id: string
  ): Promise<{ extension: ExtensionRecordPublic; reloadRequired: boolean } | null> {
    // An id this manager has not seen may have just arrived on disk: the
    // marketplace plugin install enables each extension it carries right after
    // moving the plugin into place, before anything re-scanned (DOR-2383).
    if (!this.extensions.has(id)) await this.reload();
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

    this.emitChanged();
    return {
      extension: toPublic(record, configManager.get('extensions')),
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

    this.emitChanged();
    return {
      extension: toPublic(record, configManager.get('extensions')),
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

    // The approval is for THIS copy (DOR-2383): record its directory and carrying
    // plugin beside the id, replacing whatever copy an earlier approval named.
    const extensions = configManager.get('extensions');
    const source = approvedSourceOf(record);
    const dismissed = extensions.dismissedApprovals ?? {};
    if (!isApprovedCopy(record, extensions) || dismissed[id]) {
      // A "Not now" for this id is answered by the approval, so it goes too
      // (DOR-2517): a later withdrawal plus reinstall asks again rather than
      // staying silenced by a decline the person has since reversed.
      const next = {
        ...extensions,
        approvedToRun: extensions.approvedToRun.includes(id)
          ? extensions.approvedToRun
          : [...extensions.approvedToRun, id],
        approvedSources: { ...(extensions.approvedSources ?? {}), [id]: source },
      };
      if (dismissed[id]) {
        const remainingDismissals = { ...dismissed };
        delete remainingDismissals[id];
        next.dismissedApprovals = remainingDismissals;
      }
      configManager.set('extensions', next);
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

    this.emitChanged();
    return toPublic(record, configManager.get('extensions'));
  }

  /**
   * Record that a person said "Not now" to this extension in the Activity
   * inbox (DOR-2517).
   *
   * **Never destructive.** It uninstalls, disables and revokes nothing — the
   * extension stays exactly as it was, and Settings → Extensions can still turn
   * it on. It only stops the inbox asking about this copy at this version.
   *
   * Refuses when the copy on disk is not the one the person was shown: an
   * answer to an out-of-date row must not silence something they never saw.
   * Only the caller-facing route may call this, after the same person bar that
   * guards approving (`routes/extensions-approval.ts`).
   *
   * @param id - Extension id.
   * @param expected - The path and version the person's row showed.
   * @returns `{ ok: true }`, or why it refused.
   */
  dismissApproval(
    id: string,
    expected: ExpectedCopy
  ): { ok: true } | { ok: false; reason: DismissApprovalRefusal } {
    const record = this.extensions.get(id);
    if (!record) return { ok: false, reason: 'not_found' };
    if (record.origin === 'core') return { ok: false, reason: 'core' };
    if (!isExpectedCopy(record, expected)) return { ok: false, reason: 'stale' };

    this.recordDismissal(record, 'declining an extension for now');
    this.emitChanged();
    return { ok: true };
  }

  /**
   * Record that the person put this exact copy off, so the Activity inbox does
   * not ask about it again until its path, plugin or version changes. Shared
   * by "Not now" and by "Stop it", which is the same answer given later.
   *
   * @param record - The copy.
   * @param subsystem - What the config log names as the writer.
   */
  private recordDismissal(record: ExtensionRecord, subsystem: string): void {
    const id = record.id;
    const before = configManager.get('extensions');
    configManager.set('extensions', {
      ...before,
      dismissedApprovals: {
        ...(before.dismissedApprovals ?? {}),
        [id]: {
          path: path.resolve(record.path),
          ...(record.sourcePlugin ? { plugin: record.sourcePlugin } : {}),
          version: record.manifest.version,
          dismissedAt: new Date().toISOString(),
        },
      },
    });
    logConfigWrite(subsystem, 'extensions', before, configManager.get('extensions'));
  }

  /**
   * Withdraw a person's approval for this extension to run code in the server, and
   * stop it immediately.
   *
   * Withdrawing is not the same as disabling: the extension stays on, but none of
   * its code runs until a person turns it on again.
   *
   * "Stop it" is also an answer to the Activity inbox's question (DOR-2517), so it
   * records a "Not now" for this exact copy first: the ask does not come straight
   * back to the bell, and returns only when the copy's source or version changes.
   * Written before the approval is dropped, so no change listener ever sees the
   * copy unapproved and not yet put off.
   *
   * @param id - Extension id to revoke.
   * @returns The updated public record, or `null` when no such extension exists.
   */
  async revokeRunApproval(id: string): Promise<ExtensionRecordPublic | null> {
    const record = this.extensions.get(id);
    if (!record) return null;

    if (record.origin === 'user') this.recordDismissal(record, 'stopping an extension');
    await this.forgetRunApproval(id);

    return toPublic(record, configManager.get('extensions'));
  }

  /**
   * Drop a stored run approval and stop the extension, for an id whose code is
   * being REPLACED or removed rather than judged (DOR-516).
   *
   * The marketplace uninstall flow calls this for every extension a removed
   * package bundled, and, on an update, for every extension the new version no
   * longer carries (DOR-2383: an update from the same package keeps the rest).
   * Without it, `marketplace_install` — tier `act`, always allowed — could put
   * any code at all behind an approval a person gave to something else.
   *
   * Unlike {@link revokeRunApproval} this needs no discovery record: by the time
   * an uninstall runs, the extension's files may already be staged away, and the
   * approval has to be forgotten regardless.
   *
   * @param id - Extension id whose approval is no longer about the code on disk.
   * @param installRoot - The package being removed, when an uninstall asks. An
   *   approval recorded for a copy outside it is about another package that
   *   carries the same id (DOR-2383), so it is kept, and that copy keeps running.
   */
  async forgetRunApproval(id: string, installRoot?: string): Promise<void> {
    // A "Not now" (or "Stop it") recorded for a copy inside the package being
    // removed goes with it (DOR-2517): a reinstall is a new decision, even at
    // the same version and path. One recorded for a copy elsewhere is about
    // another package and stays. `revokeRunApproval` passes no install root,
    // so the dismissal it just recorded is never undone here.
    const dismissal = configManager.get('extensions').dismissedApprovals?.[id];
    if (installRoot && dismissal && isPathWithin(dismissal.path, installRoot)) {
      const before = configManager.get('extensions');
      const remaining = { ...(before.dismissedApprovals ?? {}) };
      delete remaining[id];
      configManager.set('extensions', { ...before, dismissedApprovals: remaining });
      logConfigWrite(
        'forgetting a "Not now" for an extension being removed',
        'extensions',
        before,
        configManager.get('extensions')
      );
    }

    const extensions = configManager.get('extensions');
    const sources = extensions.approvedSources ?? {};
    const recorded = sources[id];
    if (installRoot && recorded && !isPathWithin(recorded.path, installRoot)) {
      logger.info(
        `[Extensions] Kept the run approval for ${id}: it is for the copy at ${recorded.path}, ` +
          `not the one being removed from ${installRoot}`
      );
      return;
    }
    if (extensions.approvedToRun.includes(id) || sources[id]) {
      const remainingSources = { ...sources };
      delete remainingSources[id];
      configManager.set('extensions', {
        ...extensions,
        approvedToRun: extensions.approvedToRun.filter((eid) => eid !== id),
        approvedSources: remainingSources,
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
    this.emitChanged();
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
    if (!mayRunExtensionCode(record, configManager.get('extensions'))) {
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

  /**
   * Update the CWD and return the diff of extension IDs (added/removed).
   *
   * A cwd that is already the current one changes nothing, so it re-scans
   * nothing: the cockpit announces its working directory once per page load
   * (`POST /api/extensions/cwd-changed`), and that is almost always the
   * directory the server booted with. That second discovery pass existed to
   * answer a question nobody asked, and re-printed the first pass's warnings
   * doing it (DOR-1336).
   *
   * The trade, stated plainly: opening a page no longer re-scans the extensions
   * directories, so an extension folder dropped in by hand while the server runs
   * shows up when something asks for a scan — the Reload button
   * (`POST /api/extensions/reload`), the `reload_extensions` tool, or an actual
   * change of working directory — rather than on the next page load.
   *
   * @param newCwd - The working directory now in effect, or `null` for none.
   */
  async updateCwd(newCwd: string | null): Promise<{ added: string[]; removed: string[] }> {
    if (isSameCwd(newCwd, this.currentCwd)) {
      return { added: [], removed: [] };
    }

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

/**
 * Whether `target` is `root` or lies inside it, compared lexically.
 *
 * @param target - Path to test.
 * @param root - Directory that may contain it.
 */
function isPathWithin(target: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
