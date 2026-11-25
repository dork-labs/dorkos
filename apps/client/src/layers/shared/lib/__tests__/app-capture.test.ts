// @vitest-environment jsdom
// jsdom limits worth naming, because they bound what this file can claim.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** The snapdom double. */
const snapdomState = { toPng: vi.fn(), importError: null as Error | null };

/** Import the module fresh, so each test gets its own snapdom import attempt. */
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
});

describe('captureAppShot — what the picture covers', () => {
  // jsdom limit worth naming: every element here measures 0x0 and there is no layout to scroll,
  // so the NUMBERS in a region cannot be exercised.
  it('reports the window for the shell, which photographs exactly the window', async () => {
    withDesktopBridge(async () => ({ ok: true, dataUrl: 'data:image/png;base64,SHELL' }));
    const { captureAppShot } = await loadModule();

    const shot = await captureAppShot();

    expect(shot.region).toEqual({
      left: 0,
      top: 0,
      width: window.innerWidth,
      height: window.innerHeight,
    });
  });
});

describe('captureAppView — getting out of the way first', () => {
  it('hides what floats above the app before the picture is taken', async () => {
    const { root, overlay, panel } = buildPage();
    let opacityAtCapture: string[] = [];
    withDesktopBridge(async () => {
      opacityAtCapture = [root, overlay, panel].map((el) => el.style.opacity);
      return { ok: true, dataUrl: 'data:image/png;base64,SHELL' };
    });
    const { captureAppView } = await loadModule();

    await captureAppView();

    // Read at the moment of capture, not after: the shell photographs the window as it stands, so
    // a dialog hidden a tick too late is a dialog in the screenshot.
    expect(opacityAtCapture).toEqual(['', '0', '0']);
  });

  it('puts everything back afterwards, exactly as it was found', async () => {
    const { root, overlay, panel } = buildPage();
    // A floating element its own author had already faded stays faded; blanking
    // the inline value would reveal a closed dialog's leftovers.
    panel.style.opacity = '0.5';
    withDesktopBridge(async () => ({ ok: true, dataUrl: 'data:image/png;base64,SHELL' }));
    const { captureAppView } = await loadModule();

    await captureAppView();

    expect(root.style.opacity).toBe('');
    expect(overlay.style.opacity).toBe('');
    expect(panel.style.opacity).toBe('0.5');
  });
});

describe('captureAppView — one capture at a time', () => {
  /** A desktop bridge that queues each ask, so the test can answer them one at a time. */
  function countedBridge() {
    const asks: Array<(result: DesktopCaptureResult) => void> = [];
    withDesktopBridge(
      () =>
        new Promise<DesktopCaptureResult>((resolve) => {
          asks.push(resolve);
        })
    );
    return {
      get calls(): number {
        return asks.length;
      },
      /**
       * Answer the `nth` ask (1-based).
       *
       * @param nth - Which ask to answer.
       * @param result - What the shell answers with.
       */
      async settle(nth: number, result: DesktopCaptureResult): Promise<void> {
        await vi.waitFor(() => expect(asks.length).toBeGreaterThanOrEqual(nth));
        asks[nth - 1](result);
      },
    };
  }

  it('hands a concurrent caller the capture already running', async () => {
    const bridge = countedBridge();
    const { captureAppShot } = await loadModule();

    const first = captureAppShot();
    const second = captureAppShot();

    expect(second).toBe(first);
    await bridge.settle(1, { ok: true, dataUrl: 'data:image/png;base64,SHELL' });
    await expect(first).resolves.toMatchObject({ dataUrl: 'data:image/png;base64,SHELL' });
    expect(bridge.calls).toBe(1);
  });

  it('does not let a second capture pin the app invisible', async () => {
    // The damage a second overlapping run does, and why the guard is structural rather than a
    // disabled button: run two, and the second reads the FIRST one's already-faded values as "how
    // this was found" — then restores the app to invisible, permanently, behind a modal nobody
    // can now see to close.
    const { overlay } = buildPage();
    const bridge = countedBridge();
    const { captureAppView } = await loadModule();

    const first = captureAppView();
    void captureAppView();
    await bridge.settle(1, { ok: true, dataUrl: 'data:image/png;base64,SHELL' });
    await first;

    expect(overlay.style.opacity).toBe('');
  });
});

describe('captureAppView — the time bound', () => {
  it('gives up, restores the app, and says so', async () => {
    // The state nothing can report from: while the picture is being taken the dialog is
    // invisible, so a capture that never settles is an app that never comes back. rAF is faked
    // explicitly — the wait for a paint is on this path and a real one would never fire on a fake
    // clock.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'Date'] });
    try {
      const { overlay } = buildPage();
      withDesktopBridge(() => new Promise<DesktopCaptureResult>(() => {}));
      const { captureAppView, AppCaptureError, APP_CAPTURE_TIMEOUT_MS } = await loadModule();

      const capture = captureAppView();
      const settled = capture.catch((error: unknown) => error);
      // Two steps: the timer this asserts on is only armed once the paint wait
      // is over, so one advance of exactly the bound stops 32ms short of it.
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(APP_CAPTURE_TIMEOUT_MS);
      const error = await settled;

      expect(error).toBeInstanceOf(AppCaptureError);
      expect((error as InstanceType<typeof AppCaptureError>).reason).toBe('failed');
      expect(overlay.style.opacity).toBe('');
    } finally {
      vi.useRealTimers();
    }
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
});
