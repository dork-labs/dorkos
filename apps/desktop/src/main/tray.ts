import { app, Menu, nativeImage, Tray } from 'electron';
import { join } from 'node:path';
import log from 'electron-log';

/**
 * The menu-bar / system-tray presence: the proof that DorkOS is still there.
 *
 * Closing the window no longer quits (see `index.ts`), which only works if
 * there is something to come back to. This is that something — and it is also
 * the only surface that can answer "are my agents doing anything?" while every
 * window is closed.
 *
 * It stays quiet on purpose. No colour, no badge, no notifications: a count
 * beside the icon on macOS, the same sentence in the tooltip everywhere, and a
 * short menu. This is a control panel, not a notification farm.
 */

/**
 * The tray image for each platform, resolved next to the compiled main-process
 * bundle (`dist/main`, in dev and packaged alike — `electron.vite.config.ts`
 * emits them there so `electron-builder.yml`'s `dist/**` allowlist ships them).
 *
 * macOS gets a **template** image: a black-on-transparent glyph the OS recolours
 * for light and dark menu bars. The `Template` suffix in the filename is what
 * marks it as one — do not rename it.
 *
 * Windows gets the full app mark instead, white on its own dark chip. A
 * template-style monochrome glyph would disappear into one of the two Windows
 * taskbar themes; the chip carries its own contrast, so it reads on both. It is
 * a PNG rather than the `.ico` the installer uses because Electron only decodes
 * `.ico` on Windows — a `.ico` tray asset cannot be verified anywhere else, and
 * the Windows build is not one we can confirm by hand yet.
 *
 * Linux has no entry: there is no Linux build, and a tray there needs a
 * `libappindicator` host we cannot assume. Closing the last window quits
 * instead — see `index.ts`.
 */
const TRAY_IMAGE_BY_PLATFORM: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'trayTemplate.png',
  win32: 'trayIcon.png',
};

/** Options for {@link setupTray}. */
export interface TrayOptions {
  /** Focus the cockpit window, creating one if it was closed. */
  showWindow: () => void;
  /** Open the cockpit on the Activity view. */
  openActivity: () => void;
}

let tray: Tray | null = null;
let trayOptions: TrayOptions | null = null;
let activeAgents = 0;

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
  activeAgents = 0;
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

  const fileName = TRAY_IMAGE_BY_PLATFORM[process.platform];
  if (!fileName) return;

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
}

/**
 * Reflect how many agents are mid-run.
 *
 * @param count - Agents currently working. `0` means idle, not unknown.
 */
export function setTrayActivity(count: number): void {
  if (count === activeAgents) return;
  activeAgents = count;
  render();
}

/** The one sentence the tray tells you, everywhere it tells you anything. */
function describeActivity(count: number): string {
  if (count === 0) return 'No agents working';
  return count === 1 ? '1 agent working' : `${count} agents working`;
}

/** Redraw the tray's tooltip, macOS title and menu from the current count. */
function render(): void {
  if (!tray || !trayOptions) return;
  const summary = describeActivity(activeAgents);

  tray.setToolTip(`DorkOS — ${summary}`);
  // macOS is the only platform that shows text beside a tray icon. A bare count
  // next to the mark is the native idiom for "this is doing something", and it
  // disappears entirely when nothing is.
  if (process.platform === 'darwin') {
    tray.setTitle(activeAgents > 0 ? String(activeAgents) : '');
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
      // Routed through app.quit() so it meets the same confirmation as every
      // other way out (see quit-guard.ts).
      { label: 'Quit DorkOS', click: () => app.quit() },
    ])
  );
}
