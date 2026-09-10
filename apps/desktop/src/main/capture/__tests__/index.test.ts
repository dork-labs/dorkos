import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NativeImage } from 'electron';

/**
 * The shell's "Capture app view" channel (feedback-attachments PR 3).
 *
 * What a real `capturePage()` produces cannot be checked here — there is no
 * compositor under vitest, and the picture itself is a real-Electron fact named
 * in the PR's manual smoke instead. What IS this module's own decision, and is
 * checked: who may ask, that the capture is of the ASKING page, that an empty
 * image is refused rather than encoded into a blank screenshot, and that no
 * failure reaches the renderer as a thrown Electron wrapper.
 */

vi.mock('electron', () => import('../../__tests__/electron-mock'));
vi.mock('electron-log', () => import('../../__tests__/electron-log-mock'));

/** The app's own origin in these tests, and the URL a page of ours is on. */
const OWN_ORIGIN = 'http://localhost:4242';

async function getElectronMock() {
  const electron = await import('electron');
  return electron as unknown as typeof import('../../__tests__/electron-mock');
}

async function getLogMock() {
  const electronLog = await import('electron-log');
  return electronLog as unknown as typeof import('../../__tests__/electron-log-mock');
}

/**
 * A `NativeImage` stand-in: knows whether it has pixels and what it encodes to.
 *
 * @param dataUrl - What `toDataURL()` answers.
 * @param isEmpty - Whether the capture came back with no pixels.
 */
function fakeImage(dataUrl: string, isEmpty = false): NativeImage {
  return {
    isEmpty: () => isEmpty,
    toDataURL: () => dataUrl,
  } as unknown as NativeImage;
}

/** An invoke from a page on `url`, whose own `capturePage` behaves as `capture` says. */
function senderOn(url: string, capture: () => Promise<NativeImage>) {
  return {
    sender: { getURL: () => url, capturePage: capture },
  } as unknown as Electron.IpcMainInvokeEvent;
}

/** The registered handler itself, for a test that builds its own invoke event. */
async function armRawHandler(
  getRendererUrl: () => string | undefined = () => OWN_ORIGIN
): Promise<
  (event: Electron.IpcMainInvokeEvent) => Promise<import('../index').CaptureAppViewResult>
> {
  const { ipcMain } = await getElectronMock();
  const { setupAppViewCapture } = await import('../index');
  setupAppViewCapture({ getRendererUrl });
  const call = ipcMain.handle.mock.calls.find(([name]) => name === 'capture:app-view');
  if (!call) throw new Error('nothing registered on capture:app-view');
  return call[1] as (
    event: Electron.IpcMainInvokeEvent
  ) => Promise<import('../index').CaptureAppViewResult>;
}

/** Register the handler and hand back a way to call it from an ordinary page. */
async function armHandler(
  getRendererUrl: () => string | undefined = () => OWN_ORIGIN
): Promise<
  (
    capture: () => Promise<NativeImage>,
    url?: string
  ) => Promise<import('../index').CaptureAppViewResult>
> {
  const handler = await armRawHandler(getRendererUrl);
  return (capture, url = `${OWN_ORIGIN}/`) => handler(senderOn(url, capture));
}

beforeEach(async () => {
  vi.resetModules();
  const { resetElectronMock } = await getElectronMock();
  resetElectronMock();
  (await getLogMock()).resetLogMock();
});

describe('capture:app-view', () => {
  it('answers with the PNG the page itself produced', async () => {
    const invoke = await armHandler();
    const capture = vi.fn(async () => fakeImage('data:image/png;base64,SHOT'));

    const result = await invoke(capture);

    expect(result).toEqual({ ok: true, dataUrl: 'data:image/png;base64,SHOT' });
    // The picture is of the page that ASKED — not of a window looked up
    // elsewhere, which on a machine running two DorkOS windows would hand one
    // window's bug report the other window's contents.
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('refuses a page that is not ours, and does not photograph it', async () => {
    const invoke = await armHandler();
    const capture = vi.fn(async () => fakeImage('data:image/png;base64,SHOT'));

    const result = await invoke(capture, 'https://evil.example/page');

    expect(result).toEqual({ ok: false, message: 'DorkOS only takes this from its own window.' });
    expect(capture).not.toHaveBeenCalled();
  });

  it('follows the origin as the server moves, rather than a value captured at setup', async () => {
    // The server gets a new port when it restarts after a crash, so a captured
    // origin would start refusing the app's own window at exactly the moment
    // something has already gone wrong.
    let origin: string | undefined = OWN_ORIGIN;
    const invoke = await armHandler(() => origin);
    const capture = async () => fakeImage('data:image/png;base64,SHOT');

    origin = 'http://localhost:4300';

    expect(await invoke(capture, 'http://localhost:4300/')).toEqual({
      ok: true,
      dataUrl: 'data:image/png;base64,SHOT',
    });
    expect(await invoke(capture, `${OWN_ORIGIN}/`)).toEqual({
      ok: false,
      message: 'DorkOS only takes this from its own window.',
    });
  });

  it('refuses an empty capture instead of encoding a blank picture', async () => {
    // A capture that could not read the surface comes back as an image with no
    // pixels and no throw. `toDataURL()` encodes that into a perfectly valid
    // `data:` URL, and the dialog would attach a blank screenshot to a bug
    // report as though it had worked.
    const invoke = await armHandler();

    const result = await invoke(async () => fakeImage('data:image/png;base64,', true));

    expect(result).toEqual({ ok: false, message: 'DorkOS couldn’t get a picture of this window.' });
  });

  it('answers rather than rejects even when the page cannot be identified', async () => {
    // `getURL()` throws on a webContents being torn down, and that is a line
    // that runs BEFORE the capture. The preload promises this call never
    // rejects, and a promise like that has to hold for every line of the
    // handler — a throw here reaches the renderer as
    // `Error invoking remote method 'capture:app-view'`.
    const handler = await armRawHandler();
    const event = {
      sender: {
        getURL: () => {
          throw new Error('Object has been destroyed');
        },
        capturePage: async () => fakeImage('data:image/png;base64,SHOT'),
      },
    } as unknown as Electron.IpcMainInvokeEvent;

    await expect(handler(event)).resolves.toEqual({
      ok: false,
      message: 'DorkOS couldn’t get a picture of this window.',
    });
  });

  it('turns a failed capture into a message rather than a rejection', async () => {
    // Electron wraps whatever a handler throws as `Error invoking remote method
    // 'capture:app-view': …`, and that is what the renderer would have to show.
    const invoke = await armHandler();

    const result = await invoke(async () => {
      throw new Error('no frame available');
    });

    expect(result).toEqual({ ok: false, message: 'DorkOS couldn’t get a picture of this window.' });
    // The reason is not shown to anyone, so it has to be somewhere an operator
    // can read it afterwards.
    expect((await getLogMock()).default.error).toHaveBeenCalled();
  });
});
