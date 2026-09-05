import { dialog, ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { rm } from 'node:fs/promises';
import log from 'electron-log';
import { liveInstanceLockHolder } from '@dorkos/shared/instance-lock';
import type { InstanceLockInfo } from '@dorkos/shared/instance-lock';
import { resolveDataDirectory } from '../dork-home';
import { pointWindowsAtServer } from '../server-crash-recovery';
import { RestartFailedError, restartServer } from '../server-process';
import { isOwnOrigin } from '../window-manager';

/**
 * "Restart Server" and "Reset All Data", done by the supervisor that owns the
 * server rather than by the server itself (DOR-542).
 *
 * Settings → Advanced offers both, and in the desktop app both were dead. They
 * go out over `POST /api/admin/restart` and `POST /api/admin/reset`, which end
 * the server process and count on something restarting it — true for the CLI,
 * which re-execs itself, and false here: inside an Electron `UtilityProcess`
 * `process.argv[0]` is the app executable, not Node, so the server exited and
 * nothing came back. DOR-532 stopped the app bricking itself by making those
 * routes answer 409 whenever `DORKOS_MANAGED_BY` is set, which was the urgent
 * half and left two buttons that could only fail.
 *
 * This is the other half. The renderer asks the main process instead, the main
 * process asks the supervisor (`../server-process.ts`) — which restarts its own
 * child by definition — and the windows are pointed at whatever port the
 * replacement got. Reset deletes the data directory in the one moment nothing
 * holds it: after the old child has gone and before the new one is spawned.
 *
 * @module main/admin
 */

/** IPC channel "Restart Server" arrives on (mirrored in `preload/index.ts`). */
const RESTART_SERVER_CHANNEL = 'admin:restart-server';

/** IPC channel "Reset All Data" arrives on (mirrored in `preload/index.ts`). */
const RESET_ALL_DATA_CHANNEL = 'admin:reset-all-data';

/**
 * What an admin action answers with.
 *
 * A result rather than a thrown error, because Electron wraps anything a
 * `handle` callback throws: the renderer would receive
 * `Error invoking remote method 'admin:reset-all-data': Error: …` and put THAT
 * in front of a person. The whole point of this change is that neither button
 * can show someone a machine's internal account of a failure again — the last
 * one was a raw 409 JSON body — so the message travels as data.
 *
 * Mirrored in the client as `DesktopAdminResult` (`apps/client/src/vite-env.d.ts`).
 */
export type AdminActionResult = { ok: true } | { ok: false; message: string };

/** Options for {@link setupAdminActions}. */
export interface AdminActionsOptions {
  /**
   * Live accessor for the app's own origin, shared with the windows themselves
   * so "is this our cockpit?" has one answer. Read fresh on every call: a
   * restart is precisely when the origin can move.
   */
  getRendererUrl: () => string | undefined;
}

/** The reason an error gives, in whatever words it has. */
function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * What to say when another DorkOS grabbed the data directory in the moment ours
 * let go of it.
 *
 * @param holder - The instance holding the lock.
 */
function otherInstanceMessage(holder: InstanceLockInfo): string {
  return (
    `Another copy of DorkOS is using this folder right now — process ${holder.pid}, ` +
    `on port ${holder.port}. Nothing was deleted. Quit that copy, then try again.`
  );
}

/**
 * Delete the data directory, unless somebody else took it while we were not
 * looking.
 *
 * Run between the supervisor's stop and its start, which is the only window in
 * which our own server is not holding the lock — so a claim that is still live
 * here belongs to someone else, and deleting the directory out from under them
 * would corrupt a store they have open (DOR-532's whole premise). Checked here
 * rather than before the stop for the same reason: before the stop, the claim we
 * would find is our own.
 *
 * **The check is advisory, and two gaps are worth knowing about.**
 *
 * 1. *It is a read, not a claim.* Nothing stops a foreign instance from taking
 *    the directory between this check and the `rm` below. The airtight version
 *    would be to claim `instance.lock` ourselves with `wx` — but the claim
 *    records a `pid` **and a `port`**, and the shell is not a server and has no
 *    port. Writing an invented one would put a lie into the exact file an
 *    operator reads to decide which process to stop, which is a worse failure
 *    than the race it closes. The race needs a second DorkOS to be launched
 *    inside a window of milliseconds, having found the directory free, which in
 *    turn requires our own server to already be down.
 * 2. *`stopServer` can resolve on its five-second grace timeout*, having killed
 *    a child that has not finished dying and therefore never released its claim.
 *    The lock then names our OWN child: if that pid is still alive this refuses
 *    the reset and blames the person's own DorkOS, and if it has just gone the
 *    delete can land while the process is still unwinding. Both need a server
 *    that ignored a shutdown message for five seconds.
 *
 * @param dorkHome - The data directory to delete.
 * @throws If another live instance holds it — nothing is deleted then — or if
 *   the deletion itself fails, in which case the directory may be PARTLY gone.
 *   The supervisor starts the server again either way.
 */
async function wipeDataDirectory(dorkHome: string): Promise<void> {
  const holder = liveInstanceLockHolder(dorkHome);
  if (holder) throw new Error(otherInstanceMessage(holder));
  log.info(`[admin] Deleting the data directory at ${dorkHome}.`);
  try {
    await rm(dorkHome, { recursive: true, force: true });
  } catch (err) {
    // `force` swallows "it was not there", and nothing else. A file the OS will
    // not let go of (a permissions fault, a folder open elsewhere on Windows)
    // stops the walk partway through, so this cannot claim nothing happened —
    // and a bare `EPERM: operation not permitted, unlink '…'` under "DorkOS did
    // not reset" would be wrong twice over.
    throw new Error(
      `DorkOS started deleting the folder at ${dorkHome} and could not finish, so some of ` +
        `your data may be gone and some may still be there. ${reasonOf(err)}`,
      { cause: err }
    );
  }
}

/**
 * What to tell a person about a restart that did not happen.
 *
 * Only a failed START gets the framing sentence, because its message is the
 * server's own account of why it did not come up and reads as a fragment on its
 * own. Everything else the supervisor refuses with is already a finished
 * sentence addressed to the person — prefixing those produced "DorkOS couldn't
 * restart its server. DorkOS is already restarting its server."
 *
 * @param err - Whatever the supervisor threw.
 */
function restartFailureMessage(err: unknown): string {
  return err instanceof RestartFailedError
    ? `DorkOS couldn't restart its server. ${err.message}`
    : reasonOf(err);
}

/** Restart the server and put every cockpit window back on it. */
async function runRestart(): Promise<AdminActionResult> {
  try {
    const { port } = await restartServer();
    pointWindowsAtServer(port);
    return { ok: true };
  } catch (err) {
    log.error('[admin] Restarting the server failed.', err);
    // The window was not reloaded — there is nothing to reload it onto — so the
    // renderer is still there to show this, and the button that sent it still
    // works. Unlike the HTTP route, this path does not need a live server.
    return { ok: false, message: restartFailureMessage(err) };
  }
}

/** Delete everything DorkOS has stored, then bring the server back on the empty directory. */
async function runReset(): Promise<AdminActionResult> {
  const dorkHome = resolveDataDirectory();
  try {
    const { port, interrupted } = await restartServer(() => wipeDataDirectory(dorkHome));
    pointWindowsAtServer(port);
    if (!interrupted) return { ok: true };

    log.error('[admin] The data directory was not deleted.', interrupted);
    // The server came back and the windows have just been sent to it, so a
    // message handed to the renderer is about to be reloaded away. Say it
    // somewhere that outlives the page.
    dialog.showErrorBox('DorkOS did not reset', interrupted.message);
    return { ok: false, message: interrupted.message };
  } catch (err) {
    log.error('[admin] Resetting failed and left no server running.', err);
    // Two independent failures, and the person needs both answers. Whether
    // their data is gone is the question they actually asked; whether a server
    // came back is what they are now looking at. Reporting only the second is
    // how "was my data deleted?" goes unanswered.
    const interrupted = err instanceof RestartFailedError ? err.interrupted : null;
    const deletion = interrupted ? interrupted.message : 'Your data was deleted.';
    return { ok: false, message: `${deletion} ${restartFailureMessage(err)}` };
  }
}

/**
 * Whether an invoke came from a page of ours.
 *
 * Not a claim that the sender is trustworthy — the cockpit runs marketplace
 * extension code as ordinary modules, and in a browser that code can already
 * `fetch` the very endpoints these channels replace. It is the narrower promise
 * that these two channels reach no FURTHER than that: a document that is not the
 * cockpit (a devtools context, a page the shell was steered onto) cannot restart
 * the server or delete the data directory. Same predicate the link guards and the
 * permission policy use, through the same live accessor, so there is one answer
 * to "is this our own page?" and it survives the port moving.
 *
 * @param event - The invoke to judge.
 * @param getRendererUrl - Live accessor for the app's own origin.
 */
function isCockpitSender(event: IpcMainInvokeEvent, getRendererUrl: () => string | undefined) {
  return isOwnOrigin(event.sender.getURL(), getRendererUrl());
}

/**
 * Register the admin channels the preload bridge exposes.
 *
 * Call once, before the window is created, alongside the other IPC setup in
 * `index.ts`.
 *
 * @param options - See {@link AdminActionsOptions}.
 */
export function setupAdminActions(options: AdminActionsOptions): void {
  const refused: AdminActionResult = {
    ok: false,
    message: 'DorkOS only takes this from its own window.',
  };

  ipcMain.handle(RESTART_SERVER_CHANNEL, async (event): Promise<AdminActionResult> => {
    if (!isCockpitSender(event, options.getRendererUrl)) return refused;
    return runRestart();
  });

  ipcMain.handle(RESET_ALL_DATA_CHANNEL, async (event): Promise<AdminActionResult> => {
    if (!isCockpitSender(event, options.getRendererUrl)) return refused;
    return runReset();
  });
}
