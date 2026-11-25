/**
 * Look again for a project's own plugins after every OpenCode turn, and restart
 * the shared sidecar when one has appeared (DOR-4412).
 *
 * The guard in `project-plugin-guard.ts` asks before a turn is sent, but a
 * turn can change its folder (a `git clone` or `git pull`), and OpenCode reads a
 * folder's plugins on its own schedule. So once a turn ends, DorkOS asks again
 * about the folders the turn used: its `cwd` and the session's stored folder.
 * When either has plugins now, the one sidecar every OpenCode chat shares is
 * restarted before any further turn in any chat, and the Activity feed says so.
 *
 * **Restart, not dispose.** Disposing a folder's instance cannot undo a plugin
 * that already loaded: what its code set up belongs to the process, not the
 * folder. Only a new process is clean.
 *
 * **No turn starts on the old process.** A turn waits here while a restart
 * runs, and one that was already setting up when it began is stopped before it
 * sends ({@link PluginTurnPass.assertCurrent}). Turns still running on the old
 * process end with it. A restart that fails holds every turn: the next one
 * tries it again and is refused if it fails again.
 *
 * Fails closed like the guard: a folder that cannot be read counts as having
 * plugins. Names only: the Activity line carries the folder, never a file's
 * content.
 *
 * @module services/runtimes/opencode/messaging/project-plugin-recheck
 */
import path from 'node:path';
import type { StreamEvent } from '@dorkos/shared/types';
import type { ActivityService } from '../../../activity/activity-service.js';
import { logger, logError } from '../../../../lib/logger.js';
import {
  assertNoProjectPlugins,
  projectHasPlugins,
  projectPluginRefusal,
} from './project-plugin-guard.js';

/** One Activity line: OpenCode restarted because a folder gained plugins. */
export interface PluginRestartActivityEntry {
  /** The first folder found with plugins. */
  folder: string;
  /** The sentence. */
  summary: string;
  /** Every folder the turn used that has plugins now. */
  folders: string[];
}

type PluginRestartActivityPort = (entry: PluginRestartActivityEntry) => void;

let activityPort: PluginRestartActivityPort | undefined;

/**
 * Hand the recheck the Activity writer.
 *
 * @param next - The writer, or `undefined` to stop writing (tests).
 */
export function setPluginRestartActivity(next: PluginRestartActivityPort | undefined): void {
  activityPort = next;
}

/**
 * Build the writer that records a plugin restart in the Activity feed.
 *
 * @param activityService - The Activity feed writer.
 */
export function createPluginRestartActivityWriter(
  activityService: ActivityService
): PluginRestartActivityPort {
  return (entry) => {
    void activityService.emit({
      actorType: 'system',
      actorLabel: 'DorkOS',
      category: 'system',
      eventType: 'opencode_project_plugins.restarted',
      resourceType: 'folder',
      resourceId: entry.folder,
      summary: entry.summary,
      metadata: { folders: entry.folders },
    });
  };
}

/** What a turn may do, decided when it starts. */
export interface PluginTurnPass {
  /** The chat's refusal when the turn's folder has plugins; `undefined` lets it run. */
  refusal: StreamEvent | undefined;
  /**
   * Ask again once the session's stored folder is known, before anything is
   * sent (Security M2, #3764).
   *
   * @param directory - The session's folder as OpenCode stored it.
   * @throws {ProjectPluginsRefusedError} When it or the turn's folder has plugins.
   */
  assertNoPlugins(directory: string): void;
  /**
   * Throw when the sidecar was restarted after this turn started, so a turn
   * holding the old process's client never sends on it.
   */
  assertCurrent(): void;
}

/** Said when a turn was setting up as OpenCode restarted. */
export const PLUGIN_RESTART_MESSAGE = 'OpenCode restarted. Send your message again.';

/** Said when OpenCode needed a restart and it did not finish. */
export const PLUGIN_RESTART_FAILED_MESSAGE = 'OpenCode couldn’t restart. Try again in a moment.';

/**
 * The post-turn plugin check and the restart it can start, one per runtime.
 */
export class ProjectPluginRecheck {
  private restarting: Promise<void> | undefined;
  private failed = false;
  /** Counts restarts begun; a turn compares the one it started under. */
  private generation = 0;

  /**
   * Build the recheck for one runtime.
   *
   * @param restart - Stops the sidecar so the next use starts a fresh one.
   *   `undefined` means the provider cannot restart, which counts as a failure.
   */
  constructor(private readonly restart: () => Promise<void> | undefined) {}

  /**
   * Wait out any restart, then decide whether a turn in `cwd` may run.
   *
   * @param cwd - The turn's folder.
   * @throws {Error} When a needed restart failed twice.
   */
  async admit(cwd: string): Promise<PluginTurnPass> {
    if (this.failed) this.begin();
    while (this.restarting) await this.restarting;
    if (this.failed) throw new Error(PLUGIN_RESTART_FAILED_MESSAGE);
    const generation = this.generation;
    return {
      refusal: projectPluginRefusal(cwd),
      assertNoPlugins: (directory) => assertNoProjectPlugins(cwd, directory),
      assertCurrent: () => {
        if (this.generation !== generation) throw new Error(PLUGIN_RESTART_MESSAGE);
      },
    };
  }

  /**
   * After a turn, check the folders it used. When one has plugins now, start
   * the restart at once (synchronously, so no other turn can slip in first)
   * and record it. A restart already running covers this turn too: the turn
   * ran on the process it is stopping.
   *
   * @param dirs - The turn's `cwd` and the session's stored folder, when known.
   */
  afterTurn(...dirs: (string | undefined)[]): void {
    const unique = [...new Set(dirs.filter((dir): dir is string => dir !== undefined))];
    const folders = unique.filter((dir) => projectHasPlugins(dir));
    if (folders.length === 0) return;
    const folder = folders[0]!;
    logger.warn('[OpenCode] a folder gained its own plugins during a turn; restarting', {
      folders,
    });
    if (this.restarting) return;
    this.begin();
    activityPort?.({
      folder,
      summary: `OpenCode restarted because ${path.basename(folder)} gained its own plugins.`,
      folders,
    });
  }

  /**
   * Start a restart. `restart()` is called before this returns, so the old
   * process stops being handed out at once.
   */
  private begin(): void {
    if (this.restarting) return;
    this.generation += 1;
    this.failed = false;
    let done: Promise<void> | undefined;
    try {
      done = this.restart();
    } catch (err) {
      done = Promise.reject(err);
    }
    const run: Promise<void> = (done ?? Promise.reject(new Error('this provider cannot restart')))
      .then(
        () => undefined,
        (err: unknown) => {
          this.failed = true;
          logger.error('[OpenCode] restart after a folder gained plugins failed', logError(err));
        }
      )
      .finally(() => {
        if (this.restarting === run) this.restarting = undefined;
      });
    this.restarting = run;
  }
}
