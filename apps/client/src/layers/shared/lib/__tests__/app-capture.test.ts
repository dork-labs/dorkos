// @vitest-environment jsdom
//
// jsdom limits worth naming, because they bound what this file can claim.
// Neither capture engine runs here: there is no compositor for
// `capturePage()` and no rasterizer for snapdom, and jsdom reports every
// element as 0x0 besides. So nothing about what a screenshot LOOKS like is
// settled here — that is the PR's manual desktop smoke, and the real browser
// for the DOM path. What IS this module's own decision, and is checked: which
// path is taken, what is asked of each, that the dialog is out of the way
// BEFORE the picture is taken and back afterwards, and that every failure
// arrives as a typed refusal rather than a rejection nobody handled.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The snapdom double. `importError` makes the dynamic import itself fail, which
 * is a different outcome to a capture that ran and failed — a rejected chunk
 * load is what a redeploy does to a tab that stayed open.
 */
const snapdomState = { toPng: vi.fn(), importError: null as Error | null };

/**
 * Import the module fresh, so each test gets its own snapdom import attempt.
 *
 * `vi.doMock` rather than a hoisted `vi.mock`: a hoisted factory is evaluated
 * once and memoized per specifier, so the test that needs the import itself to
 * FAIL would silently get the previous test's working module back (measured —
 * it passed on a stale `toPng`). Registered per test, beside a `resetModules`,
 * each factory really runs.
 */
async function loadModule() {
  vi.doMock('@zumer/snapdom', () => {
    if (snapdomState.importError) throw snapdomState.importError;
    return { snapdom: { toPng: snapdomState.toPng } };
  });
  return import('../app-capture');
}

/** The page background jsdom is given, so the DOM path has a real colour to read. */
const BODY_BACKGROUND = 'rgb(9, 9, 11)';

/**
 * Build a page: the app root, plus the two things that float above it (a
 * dialog's overlay and its panel, portaled to the body as Radix does it).
 *
 * @returns The app root and the two floating elements.
 */
function buildPage(): { root: HTMLElement; overlay: HTMLElement; panel: HTMLElement } {
  document.body.innerHTML = '';
  document.body.style.backgroundColor = BODY_BACKGROUND;
  const root = document.createElement('div');
  root.id = 'root';
  root.textContent = 'the app';
  const overlay = document.createElement('div');
  overlay.dataset.slot = 'dialog-overlay';
  const panel = document.createElement('div');
  panel.dataset.slot = 'dialog-content';
  document.body.append(root, overlay, panel);
  return { root, overlay, panel };
}

/** Install a desktop bridge whose capture behaves as `capture` says. */
function withDesktopBridge(capture: () => Promise<DesktopCaptureResult>): void {
  window.electronAPI = {
    getServerPort: () => 4242,
    captureAppView: capture,
  } as unknown as ElectronAPI;
}

/** An `<img>` the way snapdom hands one back: its `src` is the encoded picture. */
function pngImage(dataUrl: string): HTMLImageElement {
  const image = document.createElement('img');
  image.src = dataUrl;
  return image;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  snapdomState.importError = null;
  buildPage();
});

afterEach(() => {
  delete window.electronAPI;
  document.body.innerHTML = '';
});

describe('captureAppView — which engine takes the picture', () => {
  it('lets the desktop shell photograph its own window when it can', async () => {
    withDesktopBridge(async () => ({ ok: true, dataUrl: 'data:image/png;base64,SHELL' }));
    const { captureAppView } = await loadModule();

    await expect(captureAppView()).resolves.toBe('data:image/png;base64,SHELL');
    // And the DOM re-draw is not merely unused — it was never even loaded,
    // which is the point of importing it dynamically.
    expect(snapdomState.toPng).not.toHaveBeenCalled();
  });

  it('feature-detects the method, not the bridge', async () => {
    // A desktop build older than this exposes an `electronAPI` with no capture
    // on it. Asking "is there a bridge?" would call `undefined` as a function.
    window.electronAPI = { getServerPort: () => 4242 } as unknown as ElectronAPI;
    snapdomState.toPng.mockResolvedValue(pngImage('data:image/png;base64,DOM'));
    const { captureAppView } = await loadModule();

    await expect(captureAppView()).resolves.toBe('data:image/png;base64,DOM');
    expect(snapdomState.toPng).toHaveBeenCalledTimes(1);
  });

  it('re-draws the app root, on the page’s own background', async () => {
    snapdomState.toPng.mockResolvedValue(pngImage('data:image/png;base64,DOM'));
    const { captureAppView } = await loadModule();

    await captureAppView();

    const [element, options] = snapdomState.toPng.mock.calls[0] as [
      HTMLElement,
      { backgroundColor: string },
    ];
    // The app root, not the body: everything floating ABOVE the app is portaled
    // to the body, and a picture of a bug with the dialog over it is no picture.
    expect(element).toBe(document.getElementById('root'));
    // The root has no background of its own — the theme's colour is on the body
    // — so a capture without this comes back with transparent gaps.
    expect(options.backgroundColor).toBe(BODY_BACKGROUND);
  });

  it('falls back to the whole body when there is no app root to find', async () => {
    document.getElementById('root')?.remove();
    snapdomState.toPng.mockResolvedValue(pngImage('data:image/png;base64,DOM'));
    const { captureAppView } = await loadModule();

    await captureAppView();

    expect(snapdomState.toPng.mock.calls[0][0]).toBe(document.body);
  });
});

describe('captureAppView — getting out of the way first', () => {
  it('hides what floats above the app before the picture is taken', async () => {
    const { root, overlay, panel } = buildPage();
    let visibleAtCapture: string[] = [];
    withDesktopBridge(async () => {
      visibleAtCapture = [root, overlay, panel].map((el) => el.style.visibility);
      return { ok: true, dataUrl: 'data:image/png;base64,SHELL' };
    });
    const { captureAppView } = await loadModule();

    await captureAppView();

    // Read at the moment of capture, not after: the shell photographs the
    // window as it stands, so a dialog hidden a tick too late is a dialog in
    // the screenshot.
    expect(visibleAtCapture).toEqual(['', 'hidden', 'hidden']);
  });

  it('waits for the hiding to be on screen, not merely applied', async () => {
    // A callback registered with `requestAnimationFrame` runs BEFORE the frame
    // it was registered for is painted, so one frame is not enough: the
    // compositor would still be holding the frame the dialog was in. Two is the
    // earliest point the change is known to be on screen, and the only part of
    // that anything here can observe is that two were waited for.
    const frames = vi.spyOn(window, 'requestAnimationFrame');
    withDesktopBridge(async () => ({ ok: true, dataUrl: 'data:image/png;base64,SHELL' }));
    const { captureAppView } = await loadModule();

    await captureAppView();

    expect(frames.mock.calls.length).toBeGreaterThanOrEqual(2);
    frames.mockRestore();
  });

  it('puts everything back afterwards, exactly as it was found', async () => {
    const { root, overlay, panel } = buildPage();
    // A floating element that was ALREADY hidden by its own author stays hidden;
    // blanking the inline value would reveal a closed dialog's leftovers.
    panel.style.visibility = 'hidden';
    withDesktopBridge(async () => ({ ok: true, dataUrl: 'data:image/png;base64,SHELL' }));
    const { captureAppView } = await loadModule();

    await captureAppView();

    expect(root.style.visibility).toBe('');
    expect(overlay.style.visibility).toBe('');
    expect(panel.style.visibility).toBe('hidden');
  });

  it('puts everything back even when the capture fails', async () => {
    const { overlay } = buildPage();
    withDesktopBridge(async () => ({ ok: false, message: 'no frame' }));
    const { captureAppView } = await loadModule();

    await expect(captureAppView()).rejects.toThrow();

    // Otherwise a failed capture leaves the dialog the person is still looking
    // at invisible, with their half-written report inside it.
    expect(overlay.style.visibility).toBe('');
  });
});

describe('captureAppView — refusals', () => {
  it('turns the shell’s refusal into a typed failure', async () => {
    withDesktopBridge(async () => ({ ok: false, message: 'DorkOS couldn’t get a picture.' }));
    const { captureAppView, AppCaptureError } = await loadModule();

    const error = await captureAppView().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AppCaptureError);
    expect((error as InstanceType<typeof AppCaptureError>).reason).toBe('failed');
    // The shell's own words are kept for whoever is reading a console, but the
    // reason is what the surface picks its sentence from.
    expect((error as Error).message).toContain('DorkOS couldn’t get a picture.');
  });

  it('does not let a broken bridge escape as an unhandled rejection', async () => {
    // The preload's contract is that it never rejects. A build where that is
    // somehow untrue must still produce a refusal the dialog can show.
    withDesktopBridge(() => Promise.reject(new Error('bridge is gone')));
    const { captureAppView, AppCaptureError } = await loadModule();

    const error = await captureAppView().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AppCaptureError);
    expect((error as InstanceType<typeof AppCaptureError>).reason).toBe('failed');
  });

  it('says the tool could not be loaded when the library will not load', async () => {
    // What a redeploy does to a tab that stayed open: the content-hashed chunk
    // 404s. Nothing ran, so telling someone the capture failed would be wrong —
    // reloading is what fixes it.
    snapdomState.importError = new Error('Failed to fetch dynamically imported module: /x.js');
    const { captureAppView, AppCaptureError } = await loadModule();

    const error = await captureAppView().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AppCaptureError);
    expect((error as InstanceType<typeof AppCaptureError>).reason).toBe('unsupported');
  });

  it('reports a capture that ran and threw as a failure', async () => {
    snapdomState.toPng.mockRejectedValue(new Error('tainted canvas'));
    const { captureAppView, AppCaptureError } = await loadModule();

    const error = await captureAppView().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AppCaptureError);
    expect((error as InstanceType<typeof AppCaptureError>).reason).toBe('failed');
  });
});
