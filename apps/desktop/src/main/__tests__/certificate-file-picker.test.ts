import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Settings' "Choose…" for company certificates (DOR-3361 follow-up): only the
 * app's own window may open the file dialog, and a page that is not ours is
 * refused before any dialog opens. The handler answers with a path and grants
 * nothing; saving it is the operator-only config route's job.
 */

vi.mock('electron', () => import('./electron-mock'));
vi.mock('electron-log', () => import('./electron-log-mock'));

const OWN_ORIGIN = 'http://localhost:4242';
const CHANNEL = 'company-certificates:choose-file';

async function getElectronMock() {
  return (await import('electron')) as unknown as typeof import('./electron-mock');
}

/** The registered handler, called as a page on `url`. */
async function arm(): Promise<
  (url: string) => Promise<import('../certificate-file-picker').CertificateFilePickResult>
> {
  const { ipcMain } = await getElectronMock();
  const { setupCertificateFilePicker } = await import('../certificate-file-picker');
  setupCertificateFilePicker({ getRendererUrl: () => OWN_ORIGIN });
  const call = ipcMain.handle.mock.calls.find(([name]) => name === CHANNEL);
  if (!call) throw new Error(`nothing registered on ${CHANNEL}`);
  const handler = call[1] as (
    event: Electron.IpcMainInvokeEvent
  ) => Promise<import('../certificate-file-picker').CertificateFilePickResult>;
  return (url) =>
    handler({ sender: { getURL: () => url } } as unknown as Electron.IpcMainInvokeEvent);
}

beforeEach(async () => {
  vi.resetModules();
  (await getElectronMock()).resetElectronMock();
});

describe(CHANNEL, () => {
  it('refuses a sender that is not the app’s own window, and never opens the dialog', async () => {
    const { dialog } = await getElectronMock();
    const invoke = await arm();

    const result = await invoke('https://evil.example/page');

    expect(result).toEqual({ ok: false, message: 'DorkOS only takes this from its own window.' });
    expect(dialog.showOpenDialog).not.toHaveBeenCalled();
  });

  it('answers the app’s own window with the file picked', async () => {
    const { dialog } = await getElectronMock();
    dialog.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/Users/kai/company-ca.pem'],
    });
    const invoke = await arm();

    expect(await invoke(`${OWN_ORIGIN}/`)).toEqual({ ok: true, path: '/Users/kai/company-ca.pem' });
    expect(dialog.showOpenDialog).toHaveBeenCalledTimes(1);
  });

  it('answers null when the person cancels', async () => {
    const invoke = await arm();
    expect(await invoke(`${OWN_ORIGIN}/`)).toEqual({ ok: true, path: null });
  });

  it('never rejects: a failing dialog is a plain refusal', async () => {
    const { dialog } = await getElectronMock();
    dialog.showOpenDialog.mockRejectedValueOnce(new Error('boom'));
    const invoke = await arm();
    expect(await invoke(`${OWN_ORIGIN}/`)).toEqual({
      ok: false,
      message: 'Couldn’t open the file dialog. Try again.',
    });
  });
});
