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
//
// The one thing here that NEEDS a browser has one: focus survival across the
// hide-and-restore, in
// `apps/e2e/tests/dev-playground/feedback-capture-focus.spec.ts`. jsdom has no
// focus semantics to break, and breaking them is exactly what the first
// implementation of the hide did.
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

describe('captureAppShot — what the picture covers', () => {
  // jsdom limit worth naming: every element here measures 0x0 and there is no
  // layout to scroll, so the NUMBERS in a region cannot be exercised. What is
  // this module's own decision — and is what these check — is WHICH box each
  // path reports: the window for the shell, the captured element for the DOM
  // re-draw. Get that wrong and a crop lands on the wrong part of the picture,
  // silently, at every scale.
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

  it('reports the re-drawn element’s own box, which is NOT the window', async () => {
    // The DOM path frames `#root`. On a page taller than the window that box
    // runs past the bottom of the viewport and, once scrolled, starts above it
    // at a negative `top` — so assuming the viewport here would put every crop
    // off by the scroll offset.
    const root = document.getElementById('root');
    if (!root) throw new Error('the test page must have an app root');
    root.getBoundingClientRect = () =>
      ({ left: 0, top: -320, width: 1024, height: 4000 }) as DOMRect;
    snapdomState.toPng.mockResolvedValue(pngImage('data:image/png;base64,DOM'));
    const { captureAppShot } = await loadModule();

    const shot = await captureAppShot();

    expect(shot.region).toEqual({ left: 0, top: -320, width: 1024, height: 4000 });
  });

  it('measures the re-drawn box BEFORE the render, not after it', async () => {
    // snapdom walks and re-serializes the whole tree, which is long enough for a
    // scroll to move the box. A rect taken afterwards describes where the
    // element ended up, not what was photographed.
    const root = document.getElementById('root');
    if (!root) throw new Error('the test page must have an app root');
    let scrolled = false;
    root.getBoundingClientRect = () =>
      (scrolled
        ? { left: 0, top: -900, width: 1024, height: 4000 }
        : { left: 0, top: 0, width: 1024, height: 4000 }) as DOMRect;
    snapdomState.toPng.mockImplementation(() => {
      scrolled = true;
      return Promise.resolve(pngImage('data:image/png;base64,DOM'));
    });
    const { captureAppShot } = await loadModule();

    const shot = await captureAppShot();

    expect(shot.region.top).toBe(0);
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

    // Read at the moment of capture, not after: the shell photographs the
    // window as it stands, so a dialog hidden a tick too late is a dialog in
    // the screenshot.
    //
    // `opacity`, and this is the assertion that pins it. `visibility: hidden`
    // paints nothing just as well and was the first implementation, but it blurs
    // `activeElement` to the body permanently — the caret goes, and React's
    // `onPaste` on the portaled dialog stops being reached at all. jsdom cannot
    // see that (see the browser regression spec named in the header), so the
    // property name is what is defended here.
    expect(opacityAtCapture).toEqual(['', '0', '0']);
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

    // Exactly two, not "at least": nothing else on this path asks for a frame,
    // so the number is knowable — and a third would mean a frame is being waited
    // for somewhere nobody wrote down.
    expect(frames.mock.calls.length).toBe(2);
    frames.mockRestore();
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

  it('puts everything back even when the capture fails', async () => {
    const { overlay } = buildPage();
    withDesktopBridge(async () => ({ ok: false, message: 'no frame' }));
    const { captureAppView } = await loadModule();

    await expect(captureAppView()).rejects.toThrow();

    // Otherwise a failed capture leaves the dialog the person is still looking
    // at invisible, with their half-written report inside it.
    expect(overlay.style.opacity).toBe('');
  });
});

describe('captureAppView — one capture at a time', () => {
  /**
   * A desktop bridge that queues each ask, so the test can answer them one at a
   * time.
   *
   * `settle` waits for the ask it is answering to have HAPPENED. The ask is two
   * animation frames into a capture, so answering straight after the call would
   * hand a result to a promise that does not exist yet — and answering the
   * second ask before it arrives would silently re-answer the first.
   */
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

  it('shares that one capture with the callers who only wanted the picture', async () => {
    // `captureAppView` wraps `captureAppShot` to drop the region, so it hands
    // back a NEW promise each call and promise identity says nothing about it.
    // What has to hold is the property the identity was only ever a proxy for:
    // one run, one photograph, however many callers asked.
    const bridge = countedBridge();
    const { captureAppShot, captureAppView } = await loadModule();

    const shot = captureAppShot();
    const view = captureAppView();

    await bridge.settle(1, { ok: true, dataUrl: 'data:image/png;base64,SHELL' });
    await expect(view).resolves.toBe('data:image/png;base64,SHELL');
    await expect(shot).resolves.toMatchObject({ dataUrl: 'data:image/png;base64,SHELL' });
    expect(bridge.calls).toBe(1);
  });

  it('does not let a second capture pin the app invisible', async () => {
    // The damage a second overlapping run does, and why the guard is structural
    // rather than a disabled button: run two, and the second reads the FIRST
    // one's already-faded values as "how this was found" — then restores the app
    // to invisible, permanently, behind a modal nobody can now see to close.
    const { overlay } = buildPage();
    const bridge = countedBridge();
    const { captureAppView } = await loadModule();

    const first = captureAppView();
    void captureAppView();
    await bridge.settle(1, { ok: true, dataUrl: 'data:image/png;base64,SHELL' });
    await first;

    expect(overlay.style.opacity).toBe('');
  });

  it('starts a fresh capture once the last one has settled', async () => {
    const bridge = countedBridge();
    const { captureAppShot } = await loadModule();

    const first = captureAppShot();
    await bridge.settle(1, { ok: true, dataUrl: 'data:image/png;base64,SHELL' });
    await first;
    const second = captureAppShot();

    // A held slot would make the button dead for the rest of the session.
    expect(second).not.toBe(first);
    await bridge.settle(2, { ok: true, dataUrl: 'data:image/png;base64,AGAIN' });
    await expect(second).resolves.toMatchObject({ dataUrl: 'data:image/png;base64,AGAIN' });
    expect(bridge.calls).toBe(2);
  });

  it('releases the slot after a failure too', async () => {
    withDesktopBridge(async () => ({ ok: false, message: 'no frame' }));
    const { captureAppView } = await loadModule();

    await expect(captureAppView()).rejects.toThrow();

    // One refusal must not cost the person every later attempt.
    await expect(captureAppView()).rejects.toThrow();
  });
});

describe('captureAppView — the time bound', () => {
  it('gives up, restores the app, and says so', async () => {
    // The state nothing can report from: while the picture is being taken the
    // dialog is invisible, so a capture that never settles is an app that never
    // comes back. rAF is faked explicitly — the wait for a paint is on this path
    // and a real one would never fire on a fake clock.
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

  it('does not give up on a capture that finishes in time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'Date'] });
    try {
      let settle: (result: DesktopCaptureResult) => void = () => {};
      withDesktopBridge(
        () =>
          new Promise<DesktopCaptureResult>((resolve) => {
            settle = resolve;
          })
      );
      const { captureAppView, APP_CAPTURE_TIMEOUT_MS } = await loadModule();

      const capture = captureAppView();
      await vi.advanceTimersByTimeAsync(APP_CAPTURE_TIMEOUT_MS - 1);
      settle({ ok: true, dataUrl: 'data:image/png;base64,JUSTINTIME' });

      await expect(capture).resolves.toBe('data:image/png;base64,JUSTINTIME');
      // Nothing here claims the timer was CLEARED. It is — but the cleared
      // timer's only job was to reject a promise the race has already discarded,
      // so advancing the clock past it proves nothing either way (measured: that
      // assertion passed with `clearTimeout` removed), and a check that cannot
      // fail is worse than none.
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
