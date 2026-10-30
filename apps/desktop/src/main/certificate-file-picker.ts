/**
 * "Choose…" for company certificates in Settings → Server → Network: the
 * Mac's own file dialog, so a person picks the bundle instead of typing its
 * path (DOR-3361 follow-up).
 *
 * It only answers with the path a person picked in a dialog this window
 * opened. It grants nothing: the renderer then saves that path through
 * `PATCH /api/config`, whose `network.extraCaCertsPath` is operator-only, so an
 * agent cannot use this to change what the app trusts. The certificates load
 * on the next restart (`src/extra-ca-certs.ts`).
 *
 * @module main/certificate-file-picker
 */
import { BrowserWindow, dialog, ipcMain } from 'electron';
import log from 'electron-log';
import { isCockpitSender } from './window-manager';

/** IPC channel "Choose…" arrives on (mirrored in `preload/index.ts`). */
const CHOOSE_CERTIFICATE_FILE_CHANNEL = 'company-certificates:choose-file';

/**
 * What the picker answers with: the chosen file's absolute path, `null` when
 * the person cancelled, or why there is no dialog.
 *
 * A result rather than a thrown error, as `capture/` explains: Electron wraps a
 * thrown error in words a person must never see. Mirrored in the client as
 * `DesktopFilePickResult` (`apps/client/src/vite-env.d.ts`).
 */
export type CertificateFilePickResult =
  { ok: true; path: string | null } | { ok: false; message: string };

/** Options for {@link setupCertificateFilePicker}. */
export interface CertificateFilePickerOptions {
  /** Live accessor for the app's own origin; read fresh, as the port moves on a restart. */
  getRendererUrl: () => string | undefined;
}

/**
 * Register the channel the preload bridge exposes as `chooseCertificateFile`.
 * Call once, before the window is created, alongside the other IPC setup.
 *
 * @param options - See {@link CertificateFilePickerOptions}.
 */
export function setupCertificateFilePicker(options: CertificateFilePickerOptions): void {
  ipcMain.handle(
    CHOOSE_CERTIFICATE_FILE_CHANNEL,
    async (event): Promise<CertificateFilePickResult> => {
      try {
        if (!isCockpitSender(event, options.getRendererUrl)) {
          return { ok: false, message: 'DorkOS only takes this from its own window.' };
        }
        const owner = BrowserWindow.fromWebContents(event.sender);
        const picked = await (owner
          ? dialog.showOpenDialog(owner, DIALOG_OPTIONS)
          : dialog.showOpenDialog(DIALOG_OPTIONS));
        return { ok: true, path: picked.canceled ? null : (picked.filePaths[0] ?? null) };
      } catch (err) {
        log.error('[certificates] The file dialog failed.', err);
        return { ok: false, message: 'Couldn’t open the file dialog. Try again.' };
      }
    }
  );
}

/** One file, certificate types first; "All files" too, since bundles use many names. */
const DIALOG_OPTIONS: Electron.OpenDialogOptions = {
  title: 'Choose company certificates',
  buttonLabel: 'Choose',
  properties: ['openFile'],
  filters: [
    { name: 'Certificates', extensions: ['pem', 'crt', 'cer'] },
    { name: 'All files', extensions: ['*'] },
  ],
};
