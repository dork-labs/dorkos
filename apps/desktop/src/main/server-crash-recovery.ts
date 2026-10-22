import { app, BrowserWindow } from 'electron';
import log from 'electron-log';
import { formatServerOutput } from './server-output';
import { isQuitting } from './quit-guard';
import { frontTabUrl } from './tab-session';
import { noteDocumentReplaced } from './renderer-health/document-watermark';
import { setServerRestarting, showServerStopped } from './server-stopped';

/**
 * What the desktop shell does about a server it did not expect to lose: start
 * it again on its own, wait a little longer between each try, and stop after
 * {@link MAX_RESTART_TRIES} with a quiet "DorkOS stopped" page (DOR-3229).
 *
 * It used to ask first, in a dialog, and give up after one failed restart a
 * person had to click through. After a crash at night that left the app down
 * until somebody reopened it. Now nothing waits on a click until every try has
 * failed, and the log carries each try's real error.
 *
 * Split from `server-process.ts` because supervising a process and deciding
 * how to recover it are different jobs.
 */

/**
 * How many restarts may fail in a row before DorkOS stops trying.
 *
 * Some failures cannot be retried out of — a `dorkos` CLI server already
 * holding the data directory refuses every restart for the same reason — so
 * the tries are capped, and what comes after is a page that says so.
 */
export const MAX_RESTART_TRIES = 4;

/**
 * The waits between tries and before the restarting bar. The first try waits
 * 1 s and each wait doubles, up to 8 s; the bar appears after 2 s. A `let`
 * only so tests can shorten them ({@link setRestartTimingForTests}).
 */
let timing = { firstDelayMs: 1_000, maxDelayMs: 8_000, noticeDelayMs: 2_000 };

/**
 * How long a server must stay up before it counts as having actually worked.
 *
 * Spawning successfully is not the same thing as staying up. A server that
 * boots and dies seconds later — the renderer re-issues the request that
 * killed it, an OOM, a faulting native module — would otherwise reset the
 * count on every cycle and loop forever, which is the exact behaviour the cap
 * exists to stop. A minute of service is a working server.
 */
const MIN_HEALTHY_UPTIME_MS = 60_000;

/** Restarts tried since the last server that stayed up. */
let triesSinceHealthy = 0;

/**
 * The wait before one try: 1 s, 2 s, 4 s, then 8 s.
 *
 * @param tryIndex - Which try this is, from 0.
 */
export function restartDelayMs(tryIndex: number): number {
  return Math.min(timing.firstDelayMs * 2 ** tryIndex, timing.maxDelayMs);
}

/** Options for {@link recoverFromCrash}. */
export interface CrashRecoveryOptions {
  /** The dead child's exit code, or `null` if it was killed by a signal. */
  code: number | null;
  /** The child's last stderr lines — its own account of why it died. */
  output: string[];
  /** How long the dead server had been serving, in ms. */
  uptimeMs: number;
  /** Start a replacement server; resolves with the port it listens on. */
  restart: () => Promise<number>;
}

/**
 * Bring the server back after it stopped on its own.
 *
 * Restarts at once-doubling intervals until one comes up, and gives up after
 * {@link MAX_RESTART_TRIES} tries without a server that stayed up a minute.
 * The count carries across crashes, so a server that keeps dying right after
 * it starts runs the count out too.
 *
 * @param options - See {@link CrashRecoveryOptions}.
 */
export async function recoverFromCrash(options: CrashRecoveryOptions): Promise<void> {
  const { code, output, uptimeMs, restart } = options;
  // The server's own words go to the log whole; that is where a person, or a
  // bug report, looks for why.
  const reported = formatServerOutput(output);
  log.error(
    `[server] The server stopped after ${Math.round(uptimeMs / 1000)}s ` +
      `(exit code ${code ?? 'none, stopped by a signal'}).${reported ? `\n${reported}` : ''}`
  );
  if (uptimeMs >= MIN_HEALTHY_UPTIME_MS) triesSinceHealthy = 0;
  await restartWithBackoff(restart);
}

/**
 * Try restarts until one works or the tries run out, with the restarting bar
 * shown after two seconds.
 *
 * @param restart - Starts a replacement server.
 */
async function restartWithBackoff(restart: () => Promise<number>): Promise<void> {
  const notice = setTimeout(() => setServerRestarting(true), timing.noticeDelayMs);
  try {
    while (triesSinceHealthy < MAX_RESTART_TRIES) {
      await new Promise((done) => setTimeout(done, restartDelayMs(triesSinceHealthy)));
      if (isQuitting()) return;
      triesSinceHealthy += 1;
      try {
        pointWindowsAtServer(await restart());
        return;
      } catch (err) {
        // The error carries the child's own words (server-process attaches
        // them), so the real reason is in the log, not only its warnings.
        log.error(`[server] Restart ${triesSinceHealthy} of ${MAX_RESTART_TRIES} failed.`, err);
      }
    }
  } finally {
    clearTimeout(notice);
    setServerRestarting(false);
  }
  if (isQuitting()) return;
  showServerStopped(triesSinceHealthy, () => {
    // "Restart DorkOS" is a person asking again, so the tries start over.
    triesSinceHealthy = 0;
    return restartWithBackoff(restart);
  });
}

/**
 * Reset the try count between tests.
 *
 * @internal Exported for testing only.
 */
export function resetCrashRecoveryForTests(): void {
  triesSinceHealthy = 0;
}

/**
 * Shorten the waits, so a test runs every try without real seconds passing.
 *
 * @internal Exported for testing only.
 * @param next - The waits to use instead.
 */
export function setRestartTimingForTests(next: typeof timing): void {
  timing = next;
}

/**
 * Point every cockpit window at the freshly restarted server.
 *
 * Unconditional, and not an optimisation to skip when the port came back the
 * same (which it usually does now — see `server-port.ts`): the window is
 * holding a connection to a process that no longer exists, so it has to be sent
 * back to the address whatever that address turned out to be.
 *
 * All of them, not just the tracked one: a second window opened with
 * `window.open` is a full cockpit on the same origin, and leaving it pointed at
 * a dead server would strand it with no way to recover but closing it.
 *
 * Shared with the updater's stalled-restart recovery (`auto-updater.ts`), which
 * brings the same server back up for a different reason and leaves the same
 * windows pointed at a port that is gone.
 *
 * @param port - The port the replacement server is listening on.
 */
export function pointWindowsAtServer(port: number): void {
  // Every window below loses the document it is showing, and the renderer
  // supervisor is waiting on a heartbeat from one of them. Without this stamp,
  // the discarded page's heartbeat still arrives and clears the supervisor's
  // failure count for a load that never came up (DOR-2034). Stamped once,
  // before the first navigation, so a later iteration's clock reading can never
  // postdate a window this loop already navigated.
  noteDocumentReplaced();
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    // A packaged build loads the renderer *from* the server, so it has to move
    // to the new origin. In dev the renderer comes from electron-vite and only
    // needs a reload, which re-reads the port over IPC — navigating it to the
    // server would strand it away from the dev server.
    if (app.isPackaged) {
      // Back onto the tab that was in front, not the app's root: the location
      // sync would otherwise rewrite that tab to `/`, and keep it that way.
      void win.loadURL(frontTabUrl(win, `http://localhost:${port}`));
    } else {
      win.reload();
    }
  }
}
