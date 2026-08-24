import { app, Menu, nativeImage, Tray } from 'electron';
import { join } from 'node:path';
import log from 'electron-log';
import { TRAY_IMAGE_BY_PLATFORM } from '../shared/tray-images';
import { saveDiagnosticReportInteractive } from './diagnostics';
import type { AgentActivityCounts } from './agent-activity';

/**
 * The menu-bar / system-tray presence: the proof that DorkOS is still there.
 *
 * Closing the window no longer quits (see `index.ts`), which only works if
 * there is something to come back to. This is that something — and it is also
 * the only surface that can answer "are my agents doing anything?" while every
 * window is closed.
 *
 * It stays quiet on purpose. No push notifications, no chimes — one sentence
 * that stays a sentence: "N working", "M waiting", or both together. It went
 * from saying only how many agents are running to also saying how many are
 * stuck on you, because a count that hides "waiting on you" behind "working"
 * is not a true count. That is still a fact you can glance at, not a push you
 * are interrupted by — this is a control panel, not a notification farm.
 */

/** Options for {@link setupTray}. */
export interface TrayOptions {
  /** Focus the cockpit window, creating one if it was closed. */
  showWindow: () => void;
  /** Open the cockpit on the Activity view. */
  openActivity: () => void;
}

let tray: Tray | null = null;
let trayOptions: TrayOptions | null = null;
let streamingAgents = 0;
let blockedAgents = 0;

/** Is there a tray icon to get the app back from? */
export function hasTray(): boolean {
  return tray !== null;
}

/**
 * Drop the tray and everything it remembers.
 *
 * @internal Exported for testing only.
 */
export function resetTray(): void {
  tray?.destroy();
  tray = null;
  trayOptions = null;
  streamingAgents = 0;
  blockedAgents = 0;
}

/**
 * Create the tray icon.
 *
 * Silently does nothing on a platform with no tray image, and logs and gives up
 * if the image cannot be read — in both cases {@link hasTray} answers `false`,
 * and the caller keeps the old "closing the last window quits" behaviour rather
 * than leaving a person with an app they cannot reach.
 *
 * @param options - See {@link TrayOptions}.
 */
export function setupTray(options: TrayOptions): void {
  if (tray) return;
  trayOptions = options;

  // The image is resolved next to the compiled main-process bundle (`dist/main`,
  // in dev and packaged alike): `build/` is electron-builder's buildResources
  // and is not packaged, so `electron.vite.config.ts` emits the images there
  // instead, where the `dist/**` allowlist ships them.
  const fileName = TRAY_IMAGE_BY_PLATFORM[process.platform];
  if (!fileName) return;

  // Everything here runs inside the async `ready` handler, whose rejections
  // Electron surfaces nowhere. A tray is a nicety; the server, the activity
  // watch and the updater set up after it are not. Failing to a tray-less app
  // is the same degradation an unreadable image already gets.
  try {
    const image = nativeImage.createFromPath(join(__dirname, fileName));
    if (image.isEmpty()) {
      log.error(`[tray] Could not read the tray icon (${fileName}); running without a tray.`);
      return;
    }
    // The filename suffix already marks it, but a packaged path is not the
    // filename the OS sees — say it outright.
    if (process.platform === 'darwin') image.setTemplateImage(true);

    tray = new Tray(image);
    // macOS opens the menu on any click once a context menu is attached, so a
    // `click` handler there would open the window *and* the menu. Windows keeps
    // the two apart: left-click is "open it", right-click is the menu.
    if (process.platform === 'win32') tray.on('click', () => options.showWindow());

    render();
  } catch (err) {
    log.error('[tray] Could not create the tray; running without one.', err);
    tray = null;
  }
}

/**
 * Reflect how many agents are streaming and how many are blocked on you.
 *
 * @param counts - See {@link AgentActivityCounts}. Both `0` means idle, not unknown.
 */
export function setTrayActivity(counts: AgentActivityCounts): void {
  if (counts.streaming === streamingAgents && counts.blocked === blockedAgents) return;
  streamingAgents = counts.streaming;
  blockedAgents = counts.blocked;
  render();
}

/**
 * The one sentence the tray tells you, everywhere it tells you anything.
 *
 * Each half only appears when it has something to say — "2 working" alone,
 * "1 waiting" alone, or both joined, never a zero sitting beside a real
 * number pretending to mean something.
 */
function describeActivity(streaming: number, blocked: number): string {
  if (streaming === 0 && blocked === 0) return 'No agents working';
  const parts: string[] = [];
  if (streaming > 0) parts.push(streaming === 1 ? '1 working' : `${streaming} working`);
  if (blocked > 0) parts.push(blocked === 1 ? '1 waiting' : `${blocked} waiting`);
  return parts.join(' · ');
}

/** Redraw the tray's tooltip, macOS title/dock badge and menu from the current counts. */
function render(): void {
  // The Dock badge is macOS-only and lives on the app icon, not the tray icon,
  // so it updates even on a platform without a tray image or when the tray
  // failed to load — the one truly glanceable "waiting on you" signal survives
  // both degradations. It carries the blocked count on its own; the Dock badge
  // is a fact, not a call to action, so it clears rather than persisting once
  // nothing is waiting.
  if (process.platform === 'darwin') {
    app.dock?.setBadge(blockedAgents > 0 ? String(blockedAgents) : '');
  }

  if (!tray || !trayOptions) return;
  const summary = describeActivity(streamingAgents, blockedAgents);

  tray.setToolTip(`DorkOS: ${summary}`);
  // macOS is the only platform that shows text beside a tray icon. The icon
  // itself is a "template" image (see tray-images.ts) — macOS strips its
  // colour and recolours it itself for light/dark menu bars, so there is no
  // pixel on it we could tint amber for "waiting on you". The title text is
  // the only mark we control next to the icon, so a leading dot goes there
  // instead of a colour the OS would only discard.
  if (process.platform === 'darwin') {
    const total = streamingAgents + blockedAgents;
    const waitingMark = blockedAgents > 0 ? '● ' : '';
    tray.setTitle(total > 0 ? `${waitingMark}${total}` : '');
  }

  const { showWindow, openActivity } = trayOptions;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      // Not a button — the answer to "is anything happening?", which is the
      // question that made someone look up here in the first place.
      { label: summary, enabled: false },
      { type: 'separator' },
      { label: 'Open DorkOS', click: () => showWindow() },
      { label: 'Activity', click: () => openActivity() },
      { type: 'separator' },
      // The one item here that is not about agents, and it earns the space by
      // the same argument the tray itself does: when the window is blank or
      // will not open, this menu is the only surface still answering. Asking
      // for the report from inside a cockpit you cannot see is no help.
      {
        label: 'Save Diagnostic Report…',
        click: () => void saveDiagnosticReportInteractive(),
      },
      { type: 'separator' },
      // Routed through app.quit() so it meets the same confirmation as every
      // other way out (see quit-guard.ts).
      { label: 'Quit DorkOS', click: () => app.quit() },
    ])
  );
}
