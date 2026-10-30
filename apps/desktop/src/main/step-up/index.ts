/**
 * The Mac app's "Confirm it's you" window (DOR-3234, Security's Must 3).
 *
 * The app's page names one held action over {@link STEP_UP_CONFIRM_CHANNEL};
 * the shell opens a small window of its own for it and answers with how it
 * ended. The window:
 *
 * - **Loads a local file**, never a page of the server, so no code in the
 *   app's page can script it, frame it or open its own copy.
 * - **Runs no page script.** Its own preload fills it in and sends what is
 *   typed straight to the shell; nothing is exposed to the page itself.
 * - **Is sandboxed**, with context isolation, no node, no navigation and no
 *   new windows.
 * - **Shows the server's words.** The shell reads them from the server
 *   (`./step-up-confirmation.ts`), never from the page that asked.
 *
 * Only the app's own page may ask, and each window answers only its own
 * preload.
 *
 * @module main/step-up
 */
import { join } from 'node:path';

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import log from 'electron-log';

import {
  STEP_UP_CONFIRM_CHANNEL,
  STEP_UP_PAGE_FILE,
  STEP_UP_PRELOAD_FILE,
  STEP_UP_WINDOW_CLOSE_CHANNEL,
  STEP_UP_WINDOW_SUBMIT_CHANNEL,
  STEP_UP_WINDOW_VIEW_CHANNEL,
  type StepUpWindowOutcome,
  type StepUpWindowSubmit,
} from '../../shared/step-up-page';
import { isHeldActionId, StepUpConfirmation } from './step-up-confirmation';

/** What the window needs from the rest of the shell. */
export interface StepUpWindowDeps {
  /** Whether an IPC call came from a page of the app itself. */
  isOwnSender: (event: IpcMainInvokeEvent) => boolean;
  /** The server's port, or `null` before it is up. */
  port: () => number | null;
  /** Fetch through the app window's session. */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** The window's person proof, or `null`. */
  personProof: () => string | null;
}

/** The open windows, by the contents of each, so a preload only reaches its own. */
const open = new Map<number, StepUpConfirmation>();

function confirmationOf(sender: WebContents): StepUpConfirmation | undefined {
  return open.get(sender.id);
}

function isSubmit(value: unknown): value is StepUpWindowSubmit {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  const text = (key: string) =>
    typeof body[key] === 'string' && (body[key] as string).length <= 1024;
  if (body.kind === 'password') return text('password');
  if (body.kind === 'change') return text('currentPassword') && text('newPassword');
  return false;
}

/** Open the window for one held action, and resolve with how it ended. */
function confirmInWindow(
  parent: BrowserWindow | null,
  confirmation: StepUpConfirmation
): Promise<StepUpWindowOutcome> {
  const window = new BrowserWindow({
    width: 420,
    height: 340,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Confirm it’s you',
    ...(parent ? { parent, modal: true } : {}),
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload', STEP_UP_PRELOAD_FILE),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  const { webContents } = window;
  open.set(webContents.id, confirmation);
  webContents.on('will-navigate', (event) => event.preventDefault());
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.once('ready-to-show', () => window.show());
  void window.loadFile(join(__dirname, STEP_UP_PAGE_FILE));
  return new Promise((resolve) => {
    window.once('closed', () => {
      open.delete(webContents.id);
      void confirmation.finish().then(resolve);
    });
  });
}

/**
 * Register the window's IPC handlers. Called once at startup.
 *
 * @param deps - See {@link StepUpWindowDeps}.
 */
export function registerStepUpWindow(deps: StepUpWindowDeps): void {
  ipcMain.handle(
    STEP_UP_CONFIRM_CHANNEL,
    async (event, heldActionId: unknown): Promise<StepUpWindowOutcome> => {
      const port = deps.port();
      if (!deps.isOwnSender(event) || !isHeldActionId(heldActionId) || port === null) {
        return { kind: 'not-confirmed' };
      }
      const confirmation = new StepUpConfirmation(heldActionId, {
        origin: `http://localhost:${port}`,
        fetch: deps.fetch,
        personProof: deps.personProof,
      });
      log.info('[StepUp] Confirming a held action in the shell’s own window');
      return confirmInWindow(BrowserWindow.fromWebContents(event.sender), confirmation);
    }
  );

  ipcMain.handle(STEP_UP_WINDOW_VIEW_CHANNEL, async (event) => {
    const confirmation = confirmationOf(event.sender);
    return confirmation ? confirmation.view() : { ended: 'Nothing to confirm.', askAgain: false };
  });

  ipcMain.handle(STEP_UP_WINDOW_SUBMIT_CHANNEL, async (event, submit: unknown) => {
    const confirmation = confirmationOf(event.sender);
    if (!confirmation || !isSubmit(submit))
      return { kind: 'ended', message: 'Nothing to confirm.' };
    const answer = await confirmation.submit(submit);
    if (answer.kind === 'confirmed') BrowserWindow.fromWebContents(event.sender)?.close();
    return answer;
  });

  ipcMain.handle(STEP_UP_WINDOW_CLOSE_CHANNEL, (event) => {
    if (confirmationOf(event.sender)) BrowserWindow.fromWebContents(event.sender)?.close();
  });
}
