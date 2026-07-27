import { app, dialog } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import log from 'electron-log';

/**
 * The one-time "we're still here" notice.
 *
 * Closing the window keeps DorkOS running so agents carry on. That is the
 * feature — but a person who thinks they quit an app and didn't has found a
 * bug, not a feature. So the first time they close the last window, say so
 * plainly: where the app went, and how to leave properly if that is what they
 * meant. Once, ever.
 */

/** Index of the leftmost (default) button in a `buttons` array. */
const PRIMARY_BUTTON = 0;

const NOTICE_FILE = join(app.getPath('userData'), 'shell-notices.json');

/** What has already been said, so it is never said twice. */
interface ShellNotices {
  /** Whether the "DorkOS is still running" notice has been shown. */
  backgroundRunning?: boolean;
}

/** Read the notice ledger. A missing or unreadable file means nothing has been shown yet. */
function readNotices(): ShellNotices {
  try {
    return JSON.parse(readFileSync(NOTICE_FILE, 'utf-8')) as ShellNotices;
  } catch {
    return {};
  }
}

/**
 * Record that a notice has been shown.
 *
 * A write failure is swallowed deliberately: the worst case is the notice
 * appearing a second time, which is a far better outcome than an unhandled
 * throw out of a window-close handler.
 *
 * @param notices - The ledger to write.
 */
function writeNotices(notices: ShellNotices): void {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(NOTICE_FILE, JSON.stringify(notices));
  } catch (err) {
    log.warn('[shell] Could not record that the background notice was shown.', err);
  }
}

/** Where to look for the app once its window is gone, in this platform's words. */
function whereToFindIt(): string {
  return process.platform === 'darwin'
    ? 'Click the DorkOS icon in the menu bar to open it again, or to quit.'
    : 'Click the DorkOS icon in the notification area, next to the clock, to open it again, or to quit.';
}

/**
 * Tell the person, once ever, that DorkOS is still running.
 *
 * Offers to quit as well, because someone who closed the window meaning to quit
 * should not have to go hunting for the way out. Resolves once they have
 * answered; quitting goes through `app.quit()` like every other exit, so the
 * "agents are still working" confirmation still applies.
 */
export async function announceBackgroundRunning(): Promise<void> {
  const notices = readNotices();
  if (notices.backgroundRunning) return;

  // Written before the dialog resolves: a person who quits from this very
  // dialog has still been told, and should not be told again next time.
  writeNotices({ ...notices, backgroundRunning: true });

  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: 'DorkOS is still running',
    message: 'DorkOS is still running, so your agents keep working.',
    detail: whereToFindIt(),
    buttons: ['Got It', 'Quit DorkOS'],
    defaultId: PRIMARY_BUTTON,
    cancelId: PRIMARY_BUTTON,
  });

  if (response !== PRIMARY_BUTTON) app.quit();
}

/** @internal Exported for testing only — the file the ledger is kept in. */
export const NOTICE_FILE_PATH = NOTICE_FILE;
