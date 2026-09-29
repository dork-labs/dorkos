/**
 * Watches each runtime's usage ledger folder for files another writer (flow)
 * changes. `fs.watch` takes no glob, so it watches each folder that EXISTS;
 * folders created later are picked up by the next {@link LedgerFolderWatcher.watchExisting}
 * call (the store's 60 s scan). Lock, temp, `.stale-*` and `.corrupt-*` names
 * are ignored, and a burst of events settles into one call per folder.
 *
 * @module services/core/usage/ledger-folder-watcher
 */
import fs from 'node:fs';
import { LEDGER_RUNTIMES, type LedgerRuntime } from '@dorkos/shared/account-usage';
import { logger } from '../../../lib/logger.js';
import { ledgerIdOfFileName } from './ledger-file.js';

/** The folder watch behind the account usage store. */
export class LedgerFolderWatcher {
  private readonly watchers = new Map<LedgerRuntime, fs.FSWatcher>();
  private readonly timers = new Map<LedgerRuntime, NodeJS.Timeout>();
  private closed = false;

  /**
   * Build a watcher; nothing is watched until {@link watchExisting}.
   *
   * @param dirOf - The ledger folder of a runtime.
   * @param debounceMs - How long a folder must be quiet before `onChange` runs.
   * @param onChange - Called once per settled burst of changes in a runtime's folder.
   */
  constructor(
    private readonly dirOf: (runtime: LedgerRuntime) => string,
    private readonly debounceMs: number,
    private readonly onChange: (runtime: LedgerRuntime) => void
  ) {}

  /** Watch every runtime's ledger folder that exists now and is not watched yet. */
  watchExisting(): void {
    if (this.closed) return;
    for (const runtime of LEDGER_RUNTIMES) {
      if (this.watchers.has(runtime)) continue;
      const dir = this.dirOf(runtime);
      if (!fs.existsSync(dir)) continue;
      try {
        const watcher = fs.watch(dir, (_event, filename) => {
          if (filename && ledgerIdOfFileName(filename.toString()) === null) return;
          this.settle(runtime);
        });
        watcher.on('error', () => {
          watcher.close();
          this.watchers.delete(runtime);
        });
        watcher.unref?.();
        this.watchers.set(runtime, watcher);
      } catch (err) {
        logger.debug('[account-usage] could not watch a ledger folder', { dir, err: String(err) });
      }
    }
  }

  /** Stop every watch and pending callback. */
  close(): void {
    this.closed = true;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private settle(runtime: LedgerRuntime): void {
    const existing = this.timers.get(runtime);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(runtime);
      this.onChange(runtime);
    }, this.debounceMs);
    timer.unref?.();
    this.timers.set(runtime, timer);
  }
}
