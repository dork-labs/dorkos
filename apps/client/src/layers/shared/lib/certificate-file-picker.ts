/**
 * The desktop app's native file dialog for company certificates
 * (`chooseCertificateFile` in the desktop preload). Absent in a browser, where
 * no page may read a file's path off this computer.
 *
 * @module shared/lib/certificate-file-picker
 */

/** Opens the dialog: the picked path, or `null` when cancelled. Throws when it failed. */
export type CertificateFilePicker = () => Promise<string | null>;

/**
 * The native certificate file picker, or `null` outside the desktop app.
 *
 * @returns A function that opens the dialog, or `null` when there is none.
 */
export function getCertificateFilePicker(): CertificateFilePicker | null {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  const choose = api?.chooseCertificateFile;
  if (typeof choose !== 'function') return null;
  return async () => {
    const result = await choose();
    if (!result.ok) throw new Error(result.message);
    return result.path;
  };
}
