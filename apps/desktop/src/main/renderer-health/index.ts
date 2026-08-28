import { app, ipcMain } from 'electron';
import type { BrowserWindow, WebContents } from 'electron';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import log from 'electron-log';
import {
  clearCacheWithinDeadline,
  clearGpuAndCodeCaches,
  clearLocalStorage,
} from '../cache-hygiene';
import { saveDiagnosticReportInteractive } from '../diagnostics';
import { loadRenderer, type CreateWindowOptions } from '../window-manager';
import { confirmInterruptingAgents } from '../quit-guard';
import { FALLBACK_PAGE_FILE } from '../../shared/fallback-page';

/**
 * The window that can never stay black.
 *
 * The shell has always supervised its server child with a full state machine
 * and done nothing at all for the renderer: v0.63.0 shipped a bundle that threw
 * before React mounted, and every install came up as a permanently black
 * rectangle that nothing retried, nothing logged and nothing recovered
 * (DOR-1448). This module is the other half — everything about renderer
 * liveness in one place, the same doctrine `server-process.ts` follows.
 *
 * **Health is a heartbeat, not the absence of an event.** A renderer showing
 * anything a person can read says so (`reportAlive` on the preload bridge,
 * fired from both of the boot sentinel's exits in `apps/client/index.html`:
 * the mounted app, and the panel it paints when the bundle failed). Silence
 * past a deadline is a failure, and so are `did-fail-load`,
 * `render-process-gone` and `unresponsive`.
 *
 * **Recovery escalates on a counter that survives a restart**, because the
 * failure this exists for survives one: reload, clear the HTTP cache and
 * reload, clear the GPU caches and relaunch without hardware acceleration,
 * and finally stop trying and load a page that tells the person what happened
 * and offers them the three things that might still help. The counter goes
 * back to zero the moment a renderer reports alive.
 *
 * Scoped to the **primary** window. A second window (`window.open` at our own
 * origin) gets crash logging and no ladder: recovering the primary window is
 * what matters, and two supervisors clearing one shared cache is worse than
 * one.
 *
 * @module main/renderer-health
 */

/** Where the consecutive-failure count lives, inside the app's userData dir. */
const HEALTH_FILE_NAME = 'renderer-health.json';

/**
 * How long a renderer has to report alive before the ladder counts a failure.
 *
 * **What a heartbeat means:** somebody is looking at something they can read,
 * not "React mounted". The boot sentinel in `apps/client/index.html` reports on
 * both of its exits — the mounted app, and the panel it paints when the bundle
 * failed — because a panel that names the error and offers Try again is not the
 * failure this module exists for. The failure is a black rectangle, and only a
 * black rectangle is silence.
 *
 * The two deadlines are the same length, which settles the two cases
 * differently and on purpose. A bundle that **throws** paints the sentinel's
 * panel about three seconds in, well inside this window, so the ladder never
 * touches it. A page where **nothing happens at all** leaves the sentinel
 * waiting on its own ten seconds, so this expires first and a reload is
 * attempted — which is the right answer to "nothing happened", and still ends
 * on a page that explains itself if it does not help.
 */
export const HEARTBEAT_DEADLINE_MS = 10_000;

/**
 * Ceiling on re-arming the deadline against a page that is still loading.
 *
 * **A slow load is not a failed load, and reloading one makes it worse** —
 * that lesson is written into the boot sentinel and it applies twice over
 * here, because a reload restarts the download from zero and the ladder would
 * do it again ten seconds later, forever. So a deadline that expires while
 * Chromium says the page is still fetching re-arms instead of counting, and
 * this bounds that patience: a fetch that hangs rather than fails would
 * otherwise wait for good.
 */
export const LOADING_CEILING_MS = 60_000;

/** Rung 1: reload. */
const RUNG_RELOAD = 1;
/** Rung 2: clear the HTTP cache, then reload. */
const RUNG_CLEAR_CACHE = 2;
/** Rung 3: clear the GPU/code caches and relaunch with hardware acceleration off. */
const RUNG_RELAUNCH = 3;

/** What each rung does, in ladder order. The last entry covers every rung past it. */
const LADDER_DESCRIPTIONS = [
  'Reloading the window.',
  'Clearing the web cache and reloading.',
  'Clearing the GPU caches and relaunching without hardware acceleration.',
  'Giving up on healing it; showing the recovery page.',
];

/**
 * Chromium's `did-fail-load` code for a navigation something else replaced.
 *
 * Not a failure: the commonest source is the app navigating itself, and
 * treating it as one would reload the window every time a person clicked a
 * link.
 */
const ERR_ABORTED = -3;

/** The utility process Chromium runs the network stack in. */
const NETWORK_SERVICE = 'network.mojom.NetworkService';

/**
 * Set to `1` to make the supervisor ignore every heartbeat.
 *
 * The fault injection the ladder's own verification needs: with heartbeats
 * ignored, a perfectly healthy renderer walks the whole ladder to the fallback
 * page. It lives on this side rather than in the preload so the shipped bridge
 * carries no test-only branch — and so the injection covers a renderer that
 * goes quiet for **any** reason, not just one that chose to.
 */
const SUPPRESS_HEARTBEAT_ENV = 'DORKOS_DESKTOP_SUPPRESS_HEARTBEAT';

/** IPC channel the renderer reports a successful mount on. */
const ALIVE_CHANNEL = 'renderer:alive';

/** IPC channel the fallback page's "Try Again" arrives on. */
const TRY_AGAIN_CHANNEL = 'renderer:try-again';

/** IPC channel the fallback page's "Reset and Relaunch" arrives on. */
const RESET_CHANNEL = 'renderer:reset-and-relaunch';

/** IPC channel the fallback page's "Save Diagnostic Report" arrives on. */
const DIAGNOSTICS_CHANNEL = 'renderer:save-diagnostics';

/** What `renderer-health.json` holds between launches. */
export interface RendererHealth {
  /** Renderer failures since the last time one reported alive. */
  consecutiveFailures: number;
  /** When the last failure was counted, or `null` if there has not been one. */
  lastFailureAt: string | null;
  /** When this file was last written — the freshness the packaged smoke reads. */
  updatedAt: string;
  /** Whether the next launch should start with hardware acceleration off. */
  disableHardwareAcceleration: boolean;
}

/** A renderer health record with nothing wrong yet. */
function healthyRecord(): RendererHealth {
  return {
    consecutiveFailures: 0,
    lastFailureAt: null,
    updatedAt: new Date().toISOString(),
    disableHardwareAcceleration: false,
  };
}

/** Absolute path of the health file. */
function healthFilePath(): string {
  return join(app.getPath('userData'), HEALTH_FILE_NAME);
}

/**
 * What the previous launch (or the previous failure) left behind.
 *
 * Every unreadable state — no file, a truncated write, a hand-edited value of
 * the wrong type — reads as "nothing wrong yet". This is a counter that
 * decides whether to relaunch someone's app; when it cannot be trusted, the
 * gentlest rung is the only honest place to start.
 */
export function readRendererHealth(): RendererHealth {
  try {
    const parsed = JSON.parse(readFileSync(healthFilePath(), 'utf-8')) as Partial<RendererHealth>;
    const failures = parsed.consecutiveFailures;
    return {
      consecutiveFailures: typeof failures === 'number' && failures >= 0 ? Math.floor(failures) : 0,
      lastFailureAt: typeof parsed.lastFailureAt === 'string' ? parsed.lastFailureAt : null,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      disableHardwareAcceleration: parsed.disableHardwareAcceleration === true,
    };
  } catch {
    return healthyRecord();
  }
}

/**
 * Persist a health record, stamping `updatedAt`.
 *
 * Failures are logged and swallowed: a userData directory that cannot be
 * written is a real problem, and it is not a reason to abandon the reload that
 * was about to happen.
 *
 * @param health - The record to write, without its timestamp.
 */
function writeRendererHealth(health: Omit<RendererHealth, 'updatedAt'>): void {
  try {
    const userDataPath = app.getPath('userData');
    mkdirSync(userDataPath, { recursive: true });
    writeFileSync(
      join(userDataPath, HEALTH_FILE_NAME),
      JSON.stringify({ ...health, updatedAt: new Date().toISOString() } satisfies RendererHealth)
    );
  } catch (err) {
    log.warn('[renderer] Could not record renderer health.', err);
  }
}

/**
 * Should this launch start with hardware acceleration turned off?
 *
 * Read at the very top of `main/index.ts`: `app.disableHardwareAcceleration()`
 * has no effect once `ready` has fired, so this is one of the few things that
 * cannot wait for the app to come up. The flag is set by rung 3 and cleared by
 * the first renderer that reports alive — one relaunch cycle, not a permanent
 * downgrade.
 */
export function shouldDisableHardwareAcceleration(): boolean {
  return readRendererHealth().disableHardwareAcceleration;
}

/** The window under supervision, plus what it takes to put it back on the app. */
interface Supervised {
  /** The primary window. */
  win: BrowserWindow;
  /** The options it was created with, so the real renderer entry can be resolved again. */
  options: CreateWindowOptions;
}

let supervised: Supervised | null = null;

/** The armed heartbeat deadline, or `null` when nothing is being waited on. */
let deadline: ReturnType<typeof setTimeout> | null = null;

/** How long the current load has been waited on, across re-arms. */
let waitedMs = 0;

/**
 * True from the moment a failure is accepted until a new load re-arms the
 * deadline.
 *
 * One failure usually announces itself several times — a crashed renderer
 * fires `render-process-gone` and then `did-fail-load` for the navigation it
 * took down — and each of those must not cost a rung of its own. It stays set
 * for good on the fallback page: the ladder has stopped, and only the person
 * clicking "Try Again" starts it again.
 */
let recovering = false;

/**
 * The rung currently doing its work, or `null`.
 *
 * Separate from {@link recovering}, which a new load clears. A rung is not
 * instant — two of them clear caches and one of those goes on to relaunch the
 * app — and the reload it issues starts a load, which would otherwise reopen
 * the ladder while the rung that issued it was still running. Two rungs
 * clearing one set of caches at once is the failure mode this prevents.
 */
let ladderInFlight: Promise<void> | null = null;

/**
 * Failures counted in THIS process, whatever the file says.
 *
 * The file is the memory that survives a relaunch; this is the memory that
 * survives an unwritable disk. A userData directory that cannot be written —
 * a full volume, a permissions fault — is a plausible cause of the very
 * failure being recovered from, and reading back 0 every time would pin the
 * ladder on its first rung forever: reload, reload, reload, never escalating
 * and never reaching the page that explains itself. The rung is taken from
 * whichever counter is higher.
 */
let failuresThisSession = 0;

/**
 * Bumped by every heartbeat.
 *
 * A rung is not instant, and the window can come back on its own while one is
 * mid-flight — the cache clear on rung 2 takes as long as it takes, and a
 * renderer that recovered during it is a healthy window that must not then be
 * reloaded out from under the person. Each rung captures this value and stops
 * if it has moved.
 */
let healthGeneration = 0;

/**
 * The last GPU or network-service crash, or `null`.
 *
 * These are logged and remembered but never trigger the ladder on their own:
 * Chromium respawns both, and a GPU process that came back on its own must not
 * cost a healthy window a reload. What they are good for is the *reason* on a
 * heartbeat that never arrives afterwards — "no heartbeat" and "no heartbeat,
 * and the GPU process had just died" are the same event with very different
 * diagnoses.
 */
let lastChildProcessCrash: string | null = null;

/** Whether {@link setupRendererRecovery} has already wired the process-wide handlers. */
let armed = false;

/**
 * The recovery rung currently doing its work, or `null`.
 *
 * @internal Exported for testing only — it is what lets a test wait for a rung
 *   that clears caches and removes directories, rather than guessing at how
 *   many event-loop turns that takes on the machine it happens to run on.
 */
export function pendingRecovery(): Promise<void> | null {
  return ladderInFlight;
}

/**
 * Clear the module's state.
 *
 * @internal Exported for testing only.
 */
export function resetRendererSupervisor(): void {
  if (deadline) clearTimeout(deadline);
  deadline = null;
  supervised = null;
  waitedMs = 0;
  recovering = false;
  ladderInFlight = null;
  failuresThisSession = 0;
  healthGeneration = 0;
  lastChildProcessCrash = null;
  armed = false;
}

/** Absolute path of the bundled recovery page. */
function fallbackPagePath(): string {
  return resolve(join(__dirname, FALLBACK_PAGE_FILE));
}

/**
 * Is `url` the bundled recovery page?
 *
 * Asked of the live URL every time rather than remembered in a flag, because a
 * flag is a claim about the past and this is a question about now. The window
 * can be navigated away from the recovery page by something that has never
 * heard of this module — `server-crash-recovery.ts` points every window at the
 * restarted server — and a latch left set through that hands the cockpit, and
 * the third-party extension code running in it, the two actions that wipe
 * storage and restart the app.
 *
 * Compared as a resolved path rather than as URL text: `file://` spellings
 * differ in escaping and in how the host part is written, and this is a
 * security boundary. Same approach, for the same reason, as
 * `window-manager.ts`'s `isOwnOrigin`.
 *
 * @param url - The URL to test, usually `webContents.getURL()`.
 */
function isFallbackUrl(url: string): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'file:') return false;
  try {
    return resolve(fileURLToPath(parsed)) === fallbackPagePath();
  } catch {
    return false;
  }
}

/** Is the supervised window showing the recovery page right now? */
function isShowingFallbackPage(): boolean {
  const win = supervised?.win;
  if (!win || win.isDestroyed()) return false;
  return isFallbackUrl(win.webContents.getURL());
}

/** Is `contents` the renderer this module supervises? */
function isSupervisedSender(contents: WebContents): boolean {
  const win = supervised?.win;
  if (!win || win.isDestroyed()) return false;
  return contents.id === win.webContents.id;
}

/** Stop waiting on the current load. */
function clearDeadline(): void {
  if (deadline) clearTimeout(deadline);
  deadline = null;
}

/**
 * Start (or restart) waiting for this load to report alive.
 *
 * Arming is also what re-opens the ladder after a rung: a load in flight is a
 * fresh attempt, and its failure is a new failure rather than an echo of the
 * one being recovered from.
 */
function armDeadline(): void {
  clearDeadline();
  recovering = false;
  deadline = setTimeout(onDeadlineExpired, HEARTBEAT_DEADLINE_MS);
  waitedMs += HEARTBEAT_DEADLINE_MS;
}

/** Begin waiting on a brand-new load. */
function armForNewLoad(): void {
  waitedMs = 0;
  armDeadline();
}

/**
 * The deadline expired: decide whether that is a failure or merely a slow
 * load, and re-arm or escalate accordingly.
 */
function onDeadlineExpired(): void {
  deadline = null;
  const win = supervised?.win;
  if (!win || win.isDestroyed()) return;
  // The recovery page never reports alive, and it is not supposed to: the
  // ladder has already stopped, and the person is looking at something that
  // explains itself. Counting it would reload that page every ten seconds.
  if (isShowingFallbackPage()) return;
  if (win.webContents.isLoading() && waitedMs < LOADING_CEILING_MS) {
    armDeadline();
    return;
  }
  const context = lastChildProcessCrash
    ? ` (last child-process crash: ${lastChildProcessCrash})`
    : '';
  void recoverFrom(`the renderer never reported a first paint within ${waitedMs}ms${context}`);
}

/** Load the app's real entry point, whatever it is on this surface. */
function loadRealRenderer(): void {
  if (!supervised || supervised.win.isDestroyed()) return;
  loadRenderer(supervised.win, supervised.options);
}

/**
 * Give up healing and load the bundled fallback page.
 *
 * Loaded with `loadFile` from beside the compiled main process, so it needs no
 * server, no network and no bundle — the three things that may be exactly what
 * is broken.
 */
async function loadFallbackPage(): Promise<void> {
  if (!supervised || supervised.win.isDestroyed()) return;
  try {
    await supervised.win.loadFile(fallbackPagePath());
    // A recovery surface nobody can see is not a recovery surface. The window
    // is normally already visible by now (window-manager reveals it within
    // four seconds either way); this covers the case where it is not.
    if (!supervised.win.isDestroyed() && !supervised.win.isVisible()) supervised.win.show();
  } catch (err) {
    log.error('[renderer] Could not load the fallback page.', err);
  }
}

/**
 * Yield until the stack that raised the failure has unwound.
 *
 * **Not a nicety — measured.** `webContents.reload()` called from inside the
 * `render-process-gone` handler's own stack takes the whole main process down
 * with `SIGTRAP`: Chromium is still tearing the dead renderer down, and the
 * navigation lands in the middle of it. The same reload one turn later
 * recovers the window cleanly, every time. Rung 1 without this would have
 * killed the app on exactly the failure the ladder exists to survive, and no
 * mocked test can see it — it was found by crashing a real renderer under a
 * real Electron.
 */
function afterTheStackUnwinds(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Walk one rung of the recovery ladder.
 *
 * @param rung - The consecutive-failure count this recovery is answering.
 */
async function climbLadder(rung: number, generation: number): Promise<void> {
  await afterTheStackUnwinds();
  const win = supervised?.win;
  if (!win || win.isDestroyed()) return;
  /** Has the window come back, or gone, while this rung was working? */
  const stale = (): boolean => generation !== healthGeneration || win.isDestroyed();
  if (stale()) return;

  if (rung === RUNG_RELOAD) {
    win.webContents.reload();
    return;
  }

  if (rung === RUNG_CLEAR_CACHE) {
    try {
      await clearCacheWithinDeadline();
    } catch (err) {
      log.warn('[renderer] Could not clear the web cache before reloading.', err);
    }
    // A cache clear takes as long as it takes, and the window may have
    // reported alive during it. Reloading a window that just came back is the
    // recovery doing the damage.
    if (stale()) {
      log.info('[renderer] The window came back while the cache was clearing; leaving it alone.');
      return;
    }
    win.webContents.reload();
    return;
  }

  if (rung === RUNG_RELAUNCH) {
    try {
      await clearCacheWithinDeadline();
    } catch (err) {
      log.warn('[renderer] Could not clear the web cache before relaunching.', err);
    }
    const removed = await clearGpuAndCodeCaches();
    log.info(`[renderer] Cleared GPU and code caches (${removed.join(', ') || 'none'}).`);
    if (stale()) {
      log.info('[renderer] The window came back while the caches were clearing; not relaunching.');
      return;
    }
    await relaunchWithoutHardwareAcceleration();
    return;
  }

  await loadFallbackPage();
}

/**
 * Rung 3's ending: ask, then arm, then quit.
 *
 * **The order is the point.** `app.relaunch()` does not restart anything by
 * itself — it arms the *next* exit of this process, whenever that happens. Arm
 * it first and let the person decline the restart, and the arming survives
 * their decline: their next deliberate Cmd+Q, hours later, silently starts
 * DorkOS again. So the question is asked first, through the quit guard's own
 * `confirmInterruptingAgents` — the same ask-before-arm order `auto-updater.ts`
 * follows, and with the restart wording, because a restart is not a quit.
 *
 * Declining is not the end of the ladder. The person said "not now" to a
 * restart; they did not say "stop trying to fix my window". The deadline is
 * re-armed so the next failure still escalates to the page that explains
 * itself.
 */
async function relaunchWithoutHardwareAcceleration(): Promise<void> {
  if (!(await confirmInterruptingAgents('restart'))) {
    log.warn('[renderer] The restart was declined; the recovery page is the next rung.');
    recovering = false;
    armForNewLoad();
    return;
  }
  app.relaunch();
  app.quit();
}

/**
 * Count a renderer failure and act on it.
 *
 * @param reason - What went wrong, in the words the log should carry.
 */
async function recoverFrom(reason: string): Promise<void> {
  if (recovering || ladderInFlight || !supervised || supervised.win.isDestroyed()) return;
  recovering = true;
  clearDeadline();

  const previous = readRendererHealth();
  const generation = healthGeneration;
  // Whichever memory is further along: the file survives a relaunch, the
  // counter survives a disk that cannot be written (see `failuresThisSession`).
  const rung = Math.max(previous.consecutiveFailures, failuresThisSession) + 1;
  failuresThisSession = rung;
  writeRendererHealth({
    consecutiveFailures: rung,
    lastFailureAt: new Date().toISOString(),
    // Rung 3 is where hardware acceleration is given up on; every other rung
    // leaves the flag exactly as it found it. Only a healthy renderer clears
    // it (see `onHeartbeat`), so the downgrade lasts one relaunch cycle and
    // no longer.
    disableHardwareAcceleration: previous.disableHardwareAcceleration || rung === RUNG_RELAUNCH,
  });

  const action = LADDER_DESCRIPTIONS[Math.min(rung, LADDER_DESCRIPTIONS.length) - 1];
  // Warn rather than info, and error on the rung that stops trying: a renderer
  // failure is never routine, and the level is what makes these findable in a
  // log somebody is reading because their window was black.
  const line = `[renderer] Failure ${rung}: ${reason}. ${action}`;
  if (rung > RUNG_RELAUNCH) log.error(line);
  else log.warn(line);

  ladderInFlight = climbLadder(rung, generation).catch((err: unknown) => {
    log.error(`[renderer] Recovery rung ${rung} failed.`, err);
  });
  try {
    await ladderInFlight;
  } finally {
    ladderInFlight = null;
  }
}

/**
 * A renderer reported a real mount. Everything the ladder was holding is
 * released.
 *
 * The write is not incidental: `consecutiveFailures: 0` with a fresh
 * `updatedAt` is exactly what the packaged smoke reads to prove the app it
 * just installed actually renders (see `scripts/smoke-packaged.ts`).
 */
function onHeartbeat(contents: WebContents): void {
  if (!isSupervisedSender(contents)) return;
  if (process.env[SUPPRESS_HEARTBEAT_ENV] === '1') {
    log.warn(`[renderer] Ignoring a heartbeat: ${SUPPRESS_HEARTBEAT_ENV} is set.`);
    return;
  }
  clearDeadline();
  recovering = false;
  healthGeneration += 1;
  failuresThisSession = 0;
  lastChildProcessCrash = null;
  const previous = readRendererHealth();
  writeRendererHealth({
    consecutiveFailures: 0,
    lastFailureAt: previous.lastFailureAt,
    disableHardwareAcceleration: false,
  });
  if (previous.consecutiveFailures > 0) {
    log.info(
      `[renderer] The window came back after ${previous.consecutiveFailures} failure(s); ` +
        'recovery is back at the first rung.'
    );
  }
}

/**
 * Whether a fallback-page action may run.
 *
 * The three actions below wipe storage and restart the app, and the renderer
 * is not a trusted caller: marketplace extensions run as ordinary modules in
 * the cockpit's page. So they answer the recovery page and nothing else —
 * which is both the only surface that offers them and a document no extension
 * runs in.
 *
 * @param contents - The sender of the invoke.
 */
function isFallbackPageSender(contents: WebContents): boolean {
  return isSupervisedSender(contents) && isFallbackUrl(contents.getURL());
}

/** The fallback page's "Try Again": start the ladder over on the real app. */
function onTryAgain(): void {
  const previous = readRendererHealth();
  failuresThisSession = 0;
  writeRendererHealth({
    consecutiveFailures: 0,
    lastFailureAt: previous.lastFailureAt,
    disableHardwareAcceleration: previous.disableHardwareAcceleration,
  });
  log.info('[renderer] Retrying the app from the recovery page.');
  loadRealRenderer();
}

/**
 * The fallback page's "Reset and Relaunch": throw away everything the window
 * remembers, then restart.
 *
 * The counter goes back to zero because this is the person's own big hammer:
 * whatever happens next deserves the full ladder again rather than dropping
 * straight back onto this page.
 */
async function onResetAndRelaunch(): Promise<void> {
  log.warn('[renderer] Resetting the window and relaunching, at the person’s request.');
  for (const [what, clear] of [
    ['the web cache', clearCacheWithinDeadline],
    ['local storage', clearLocalStorage],
  ] as const) {
    try {
      await clear();
    } catch (err) {
      log.warn(`[renderer] Could not clear ${what} during a reset.`, err);
    }
  }
  await clearGpuAndCodeCaches();
  failuresThisSession = 0;
  writeRendererHealth({
    consecutiveFailures: 0,
    lastFailureAt: readRendererHealth().lastFailureAt,
    disableHardwareAcceleration: false,
  });
  app.relaunch();
  app.quit();
}

/**
 * Log a crash in a webContents this module does not supervise.
 *
 * Second windows are full cockpits and they can die too; what they do not get
 * is a recovery ladder. The log line is the difference between "a window
 * vanished" and a bug report nobody can act on.
 *
 * @param contents - The webContents that was created.
 */
function attachCrashLogging(contents: WebContents): void {
  contents.on('render-process-gone', (_event, details) => {
    if (isSupervisedSender(contents)) return;
    log.error(
      `[renderer] A secondary window's renderer went away (${details.reason}, exit ` +
        `${details.exitCode}). It is not supervised; the primary window is unaffected.`
    );
  });
}

/**
 * Wire the process-wide half of renderer supervision: the IPC bridge, the
 * GPU/network-service watch, and crash logging for windows the ladder does not
 * cover.
 *
 * Call once, before `ready` — the renderer can report alive as soon as its
 * first document runs, and a heartbeat with nothing listening is a failure the
 * ladder would go on to "recover" from.
 */
export function setupRendererRecovery(): void {
  if (armed) return;
  armed = true;

  ipcMain.on(ALIVE_CHANNEL, (event) => onHeartbeat(event.sender));

  ipcMain.handle(TRY_AGAIN_CHANNEL, (event) => {
    if (!isFallbackPageSender(event.sender)) return;
    onTryAgain();
  });

  ipcMain.handle(RESET_CHANNEL, async (event) => {
    if (!isFallbackPageSender(event.sender)) return;
    await onResetAndRelaunch();
  });

  ipcMain.handle(DIAGNOSTICS_CHANNEL, async (event) => {
    if (!isFallbackPageSender(event.sender)) return;
    await saveDiagnosticReportInteractive();
  });

  // Neither of these triggers recovery on its own — see `lastChildProcessCrash`.
  app.on('child-process-gone', (_event, details) => {
    const isNetwork = details.serviceName === NETWORK_SERVICE;
    if (details.type !== 'GPU' && !isNetwork) return;
    lastChildProcessCrash = `${isNetwork ? 'network service' : 'GPU process'} (${details.reason})`;
    log.warn(
      `[renderer] Chromium's ${lastChildProcessCrash} died. Watching for a heartbeat; ` +
        'Chromium normally respawns it.'
    );
  });

  app.on('web-contents-created', (_event, contents) => attachCrashLogging(contents));
}

/**
 * Put the primary window under supervision.
 *
 * Call right after creating it, before it has had time to load. Re-attaching
 * (the window was closed and recreated) simply moves supervision to the new
 * window.
 *
 * @param win - The primary window.
 * @param options - The options it was created with, so the ladder can put the
 *   app back on screen from the fallback page.
 */
export function attachRendererSupervisor(win: BrowserWindow, options: CreateWindowOptions): void {
  clearDeadline();
  supervised = { win, options };
  recovering = false;

  const { webContents } = win;

  // Every navigation and every reload — including the window's first load, and
  // including the ones this module issues.
  webContents.on('did-start-loading', () => armForNewLoad());

  webContents.on('did-fail-load', (_event, errorCode, errorDescription, url, isMainFrame) => {
    if (!isMainFrame || errorCode === ERR_ABORTED) return;
    // Our own recovery page failing to load is the end of the line — there is
    // nothing further to try, and laddering on it would reload the file that
    // just refused every ten seconds.
    if (isFallbackUrl(url)) {
      log.error(
        `[renderer] The recovery page itself failed to load (${errorCode} ${errorDescription}).`
      );
      return;
    }
    void recoverFrom(`the page failed to load (${errorCode} ${errorDescription}) at ${url}`);
  });

  webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    void recoverFrom(
      `the renderer process went away (${details.reason}, exit ${details.exitCode})`
    );
  });

  win.on('unresponsive', () => {
    void recoverFrom('the window stopped responding');
  });

  win.on('closed', () => {
    if (supervised?.win === win) {
      clearDeadline();
      supervised = null;
    }
  });

  // Start the clock here rather than waiting for `did-start-loading`. The
  // window is created and pointed at the renderer by one synchronous call in
  // `window-manager.ts`, so its first load has already been issued by the time
  // this runs — and whether that event has fired yet is Electron's business,
  // not a thing to bet the first ten seconds of every launch on.
  armForNewLoad();
}
