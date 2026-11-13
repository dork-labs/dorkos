/**
 * Settings → This computer → Terminal command (DOR-3105): an opt-in `dorkos` in
 * the person's Terminal, from the Mac app. The main process does the work, since
 * only it knows where this copy of the app lives; the window only asks, through
 * three channels the preload bridge exposes.
 *
 * Only DorkOS's own window may ask ({@link isCockpitSender}). Agents can't write
 * the script either: it is on the server's person-only list.
 *
 * @module main/terminal-command
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { app, ipcMain } from 'electron';
import log from 'electron-log';
import { isCockpitSender } from '../window-manager';
import { findDorkosInLoginShell } from './probe';
import type { ScriptTarget } from './script';
import {
  installTerminalCommand,
  readTerminalCommand,
  removeTerminalCommand,
  type TerminalCommandDeps,
  type TerminalCommandResult,
} from './state';

export type { TerminalCommandResult, TerminalCommandStatus } from './state';

/** IPC channels (mirrored in `preload/index.ts`). */
const STATUS_CHANNEL = 'terminal-command:status';
const INSTALL_CHANNEL = 'terminal-command:install';
const REMOVE_CHANNEL = 'terminal-command:remove';

/**
 * This copy of the app's helper binary and bundled command, or null when it has
 * none: a dev build, or anything but macOS for now (the Windows alpha has no
 * Terminal command yet).
 */
function appTarget(): ScriptTarget | null {
  if (!app.isPackaged || process.platform !== 'darwin') return null;
  // `…/DorkOS.app/Contents/MacOS/DorkOS` → `…/DorkOS.app`.
  const bundle = path.resolve(path.dirname(process.execPath), '..', '..');
  const name = path.basename(bundle, '.app');
  const helper = path.join(
    bundle,
    'Contents',
    'Frameworks',
    `${name} Helper.app`,
    'Contents',
    'MacOS',
    `${name} Helper`
  );
  const command = path.join(
    process.resourcesPath,
    'app.asar.unpacked',
    'dist',
    'cli',
    'dorkos.mjs'
  );
  return existsSync(helper) && existsSync(command) ? { helper, command } : null;
}

function liveDeps(): TerminalCommandDeps {
  // The person's login shell is a host fact, not a DorkOS setting (`shell-path.ts` reads it too).
  // eslint-disable-next-line no-restricted-syntax
  const loginShell = process.env.SHELL;
  return {
    home: app.getPath('home'),
    target: appTarget(),
    loginShell,
    findDorkos: (line) => findDorkosInLoginShell(loginShell, line),
  };
}

/** Options for {@link setupTerminalCommand}. */
export interface TerminalCommandOptions {
  /** Live accessor for the app's own origin; read fresh, as the port moves on a restart. */
  getRendererUrl: () => string | undefined;
}

const NOT_OURS: TerminalCommandResult = {
  ok: false,
  message: 'DorkOS only takes this from its own window.',
};

/**
 * Register the three channels. Call once, before the window is created, beside
 * the other IPC setup. Each answers with a result, never a thrown error, as
 * `certificate-file-picker.ts` explains.
 *
 * @param options - See {@link TerminalCommandOptions}.
 */
export function setupTerminalCommand(options: TerminalCommandOptions): void {
  const guarded =
    (work: (deps: TerminalCommandDeps) => Promise<TerminalCommandResult>) =>
    async (event: Electron.IpcMainInvokeEvent): Promise<TerminalCommandResult> => {
      if (!isCockpitSender(event, options.getRendererUrl)) return NOT_OURS;
      try {
        return await work(liveDeps());
      } catch (err) {
        log.error('[terminal-command] failed', err);
        return { ok: false, message: 'something went wrong. Try again.' };
      }
    };
  ipcMain.handle(
    STATUS_CHANNEL,
    guarded(async (deps) => ({ ok: true, status: await readTerminalCommand(deps) }))
  );
  ipcMain.handle(INSTALL_CHANNEL, guarded(installTerminalCommand));
  ipcMain.handle(REMOVE_CHANNEL, guarded(removeTerminalCommand));
}
