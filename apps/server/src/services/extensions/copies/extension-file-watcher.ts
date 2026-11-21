/** Watch installed copies after discovery; all judgment stays in the manager. */
import chokidar from 'chokidar';
import fs from 'node:fs/promises';
import path from 'node:path';
import { configManager } from '../../core/config-manager.js';
import { isRuntimeStatePath } from '../../marketplace/lib/content-hash.js';
import { logger } from '../../../lib/logger.js';
import { digestRootOf } from '../pin/extension-content-pin.js';
import { pathTrustBaselineIds } from '../pin/path-trust-edits.js';
import type { ExtensionManager } from '../extension-manager.js';

const QUIET_MS = 500;
const MAX_WAIT_MS = 3_000;
const RECONCILE_MS = 60_000;
const WRITE_STABILITY_MS = 50;
const WRITE_POLL_MS = 25;

/** A watch owns one known source folder and reports signals, never authoritative paths. */
export type ExtensionFolderWatch = (
  root: string,
  changed: () => void,
  failed: (err: unknown) => void
) => { close(): Promise<void> };

/** Open a recursive watch without following links or DorkOS runtime state. */
const watchFolder: ExtensionFolderWatch = (root, changed, failed) => {
  const watch = chokidar.watch(root, {
    ignoreInitial: true,
    followSymlinks: false,
    ignored: (file: string) => {
      const relative = path.relative(root, file).split(path.sep).join('/');
      return relative.toLowerCase().split('/').includes('.git') || isRuntimeStatePath(relative);
    },
    awaitWriteFinish: { stabilityThreshold: WRITE_STABILITY_MS, pollInterval: WRITE_POLL_MS },
  });
  watch.on('all', changed);
  // Catch changes made while the initial walk was opening its handles.
  watch.on('ready', changed);
  watch.on('error', failed);
  return { close: () => watch.close() };
};

/** The discovery and scan seams the watcher follows. */
type Source = Pick<
  ExtensionManager,
  'dorkHome' | 'listRecords' | 'onChange' | 'requestRefresh' | 'whenIdle'
>;

/** Options for the installed-copy watcher; timings and handles are injectable for tests. */
export interface ExtensionFileWatcherOptions {
  source: Source;
  /** Ask live approval sources to check presence before a full scan finishes. */
  presenceChanged: () => void;
  watch?: ExtensionFolderWatch;
  quietMs?: number;
  maxWaitMs?: number;
  reconcileMs?: number;
  /** Reads whether an approved author-owned copy already has trusted files. */
  baselineIds?: () => Promise<ReadonlySet<string>>;
  /** Authors are read from protected approvals, never inferred from folder names. */
  authorOf?: (id: string) => string | undefined;
}

/** Coalesce filesystem bursts into serialized refreshes of already discovered copies. */
export class ExtensionFileWatcher {
  private readonly handles = new Map<string, ReturnType<ExtensionFolderWatch>>();
  private readonly retryAt = new Map<string, number>();
  private timer?: ReturnType<typeof setTimeout>;
  private reconcileTimer?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  private syncing: Promise<void> = Promise.resolve();
  private running?: Promise<void>;
  private owed = false;
  private burstAt?: number;
  private stopped = false;

  constructor(private readonly options: ExtensionFileWatcherOptions) {}

  /** Begin after the ordinary startup scan has established each copy's baseline. */
  async start(): Promise<void> {
    if (this.stopped) return;
    if (this.unsubscribe) return this.syncRoots();
    this.unsubscribe = this.options.source.onChange(() => void this.syncRoots());
    await this.syncRoots();
    const interval = this.options.reconcileMs ?? RECONCILE_MS;
    if (interval > 0) {
      this.reconcileTimer = setInterval(() => {
        void this.syncRoots();
        if (this.handles.size > 0 || this.retryAt.size > 0) this.changed();
      }, interval);
      this.reconcileTimer.unref?.();
    }
  }

  /** Stop timers and watches, and wait for a refresh already in progress. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    if (this.timer) clearTimeout(this.timer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    await this.syncing;
    await Promise.all([...this.handles.values()].map((watch) => watch.close()));
    this.handles.clear();
    await this.running;
  }

  private syncRoots(): Promise<void> {
    this.syncing = this.syncing
      .then(async () => {
        if (this.stopped) return;
        const { source } = this.options;
        const baselines = await (this.options.baselineIds?.() ??
          pathTrustBaselineIds(source.dorkHome));
        const authorOf =
          this.options.authorOf ??
          ((id: string) => configManager.get('extensions').approvedSources?.[id]?.authorHome);
        const roots = new Set<string>();
        for (const record of source.listRecords()) {
          if (record.origin !== 'user' || record.devLink) continue;
          const root = path.resolve(digestRootOf(record));
          // A known folder can become unreadable while its files are being repaired.
          // Keep observing it, without admitting a new unverified folder.
          if (!record.currentDigest && !this.handles.has(root) && !this.retryAt.has(root)) continue;
          if (authorOf(record.id) && !baselines.has(record.id)) continue;
          // A source replaced by a link never expands the watch outside its folder.
          if (!(await fs.lstat(root).catch(() => null))?.isDirectory()) continue;
          if ((await fs.realpath(root).catch(() => null)) !== root) continue;
          roots.add(root);
        }
        if (this.stopped) return;
        for (const [root, handle] of this.handles) {
          if (roots.has(root)) continue;
          this.handles.delete(root);
          await handle.close();
        }
        for (const root of this.retryAt.keys()) {
          if (!roots.has(root)) this.retryAt.delete(root);
        }
        for (const root of roots) {
          if (this.handles.has(root) || (this.retryAt.get(root) ?? 0) > Date.now()) continue;
          this.retryAt.delete(root);
          const watch = (this.options.watch ?? watchFolder)(
            root,
            () => this.changed(),
            (err) => {
              logger.warn('[Extensions] Source watch stopped; a later check will retry', {
                err: String(err),
              });
              this.retryAt.set(root, Date.now() + RECONCILE_MS);
              const handle = this.handles.get(root);
              this.handles.delete(root);
              void handle
                ?.close()
                .catch((error) => logger.warn('[Extensions] Closing source watch failed', error));
              this.changed();
            }
          );
          this.handles.set(root, watch);
        }
      })
      .catch((err) => logger.warn('[Extensions] Could not follow source folders', err));
    return this.syncing;
  }

  private changed(): void {
    if (this.stopped) return;
    this.owed = true;
    if (this.running) return;
    const now = Date.now();
    this.burstAt ??= now;
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.min(
      this.options.quietMs ?? QUIET_MS,
      Math.max(0, (this.options.maxWaitMs ?? MAX_WAIT_MS) - (now - this.burstAt))
    );
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.burstAt = undefined;
      this.running = this.refresh().finally(() => {
        this.running = undefined;
        if (this.owed && !this.stopped) this.changed();
      });
    }, delay);
    this.timer.unref?.();
  }

  private async refresh(): Promise<void> {
    this.owed = false;
    try {
      this.options.presenceChanged();
      if (this.stopped) return;
      this.options.source.requestRefresh({ establishBaseline: false });
      await this.options.source.whenIdle();
    } catch (err) {
      logger.warn('[Extensions] Refreshing changed source folders failed', err);
    }
  }
}
