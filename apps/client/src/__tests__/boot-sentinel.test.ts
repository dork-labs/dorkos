// @vitest-environment jsdom
/**
 * The inline boot sentinel in `index.html` (DOR-1451). v0.63.0 shipped a bundle that threw at
 * module scope.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// The shipped document itself, read as text.
import indexHtml from '../../index.html?raw';

/** How long a *finished* document may take to call `done()` before the surface paints. */
const BOOT_DEADLINE_MS = 10_000;
/** The backstop for a document that never finishes loading at all. */
const BOOT_CEILING_MS = 60_000;
/** How long after an uncaught error the sentinel waits before deciding it was fatal. */
const ERROR_GRACE_MS = 3_000;
/** The headline the failure surface leads with. */
const HEADLINE = 'DorkOS couldn’t finish starting';

/**
 * The sentinel's source, lifted out of the document that ships it.
 *
 * @returns The JavaScript between the marked `<script>` tags.
 */
function readSentinelSource(): string {
  const match = /<script data-boot-sentinel>([\s\S]*?)<\/script>/.exec(indexHtml);
  if (!match) {
    throw new Error(
      'apps/client/index.html has no <script data-boot-sentinel> — the sentinel is gone, ' +
        'or its marker attribute was renamed and this test can no longer find it.'
    );
  }
  return match[1];
}

/**
 * The document's real `<body>` markup, so the sentinel is exercised against the
 * DOM it actually ships with rather than a hand-built stand-in.
 *
 * @returns Everything between the `<body>` tags of `index.html`.
 */
function readBodyMarkup(): string {
  const match = /<body>([\s\S]*?)<\/body>/.exec(indexHtml);
  if (!match) throw new Error('apps/client/index.html has no <body> to test against.');
  return match[1];
}

const SENTINEL_SOURCE = readSentinelSource();
const BODY_MARKUP = readBodyMarkup();

/** Evaluate the sentinel against the current jsdom window, exactly as the page would. */
function installSentinel(): void {
  new Function(SENTINEL_SOURCE)();
}

/** Pin `document.readyState`, which jsdom otherwise fixes for the whole run. */
function setReadyState(value: DocumentReadyState): void {
  Object.defineProperty(document, 'readyState', { configurable: true, get: () => value });
}

/** Whatever the sentinel has painted into `#root`, as text. */
function rootText(): string {
  return document.getElementById('root')?.textContent?.trim() ?? '';
}

/** True once the failure surface is on screen, wherever it was mounted. */
function surfacePainted(): boolean {
  return document.body.textContent?.includes(HEADLINE) ?? false;
}

/** The failure surface's buttons, by their visible label. */
function button(label: string): HTMLButtonElement | undefined {
  const buttons = Array.from(document.querySelectorAll('button'));
  return buttons.find((node) => node.textContent === label);
}

/** The text inside the collapsed "Technical details" block. */
function technicalDetails(): string {
  return document.querySelector('pre')?.textContent ?? '';
}

/** Report an uncaught error to the window the way a dying bundle does. */
function dispatchError(init: ErrorEventInit): void {
  const suppress = (event: Event): void => event.preventDefault();
  window.addEventListener('error', suppress);
  try {
    window.dispatchEvent(new ErrorEvent('error', { ...init, cancelable: true }));
  } finally {
    window.removeEventListener('error', suppress);
  }
}

/** Report an uncaught error to the window the way a dying bundle does. */
function throwUncaught(message: string): void {
  dispatchError({
    message,
    filename: 'http://localhost/assets/index-abc123.js',
    lineno: 42,
    colno: 7,
    error: new ReferenceError(message),
  });
}

describe('boot sentinel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.documentElement.className = '';
    document.body.innerHTML = BODY_MARKUP;
    // The healthy default for the timeout path: a document that finished
    // loading. Tests about a still-loading document override this.
    setReadyState('complete');
  });

  afterEach(() => {
    // Disarm before the next install so a still-listening sentinel from this
    // test cannot answer the next test's errors.
    window.__dorkosBoot?.done();
    delete window.__dorkosBoot;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('is present in the shipped document and exposes the boot contract', () => {
    expect(SENTINEL_SOURCE).toContain('__dorkosBoot');
    expect(SENTINEL_SOURCE.length).toBeGreaterThan(500);
    // The body markup really is the app's, not an empty match.
    expect(BODY_MARKUP).toContain('id="root"');

    installSentinel();

    expect(typeof window.__dorkosBoot?.done).toBe('function');
  });

  it('paints the failure surface when a finished document never mounts', () => {
    installSentinel();

    vi.advanceTimersByTime(BOOT_DEADLINE_MS - 1);
    expect(rootText()).toBe('');

    vi.advanceTimersByTime(1);
    expect(rootText()).toContain(HEADLINE);
    expect(button('Try again')).toBeDefined();
    expect(button('Copy details')).toBeDefined();
  });

  it('paints once a slow document finishes loading without mounting', () => {
    setReadyState('interactive');
    installSentinel();

    vi.advanceTimersByTime(BOOT_DEADLINE_MS * 2);
    expect(surfacePainted()).toBe(false);

    // The download finally lands, and the bundle turns out to be broken.
    setReadyState('complete');
    vi.advanceTimersByTime(1_000);

    expect(rootText()).toContain(HEADLINE);
  });

  it('gives up at the hard ceiling on a document that never finishes loading', () => {
    setReadyState('interactive');
    installSentinel();

    vi.advanceTimersByTime(BOOT_CEILING_MS - 1);
    expect(surfacePainted()).toBe(false);

    vi.advanceTimersByTime(1);
    expect(rootText()).toContain(HEADLINE);
  });

  it('stays silent for the rest of the session once done() is called', () => {
    installSentinel();

    window.__dorkosBoot?.done();
    vi.advanceTimersByTime(BOOT_CEILING_MS * 3);

    expect(surfacePainted()).toBe(false);
  });

  it('does not paint over an app that mounted without calling done()', () => {
    installSentinel();
    document.getElementById('root')!.innerHTML = '<main>the app</main>';

    vi.advanceTimersByTime(BOOT_CEILING_MS);

    expect(rootText()).toBe('the app');
  });

  it('gives up early when an uncaught error left #root empty', () => {
    installSentinel();
    throwUncaught('createBootCache is not defined');

    vi.advanceTimersByTime(ERROR_GRACE_MS - 1);
    expect(rootText()).toBe('');

    vi.advanceTimersByTime(1);
    expect(rootText()).toContain(HEADLINE);
  });

  // DOR-1771, the other half of "a slow load is not a failed boot".
  it('does not condemn a document that is still loading when an error arrives', () => {
    setReadyState('interactive');
    installSentinel();

    throwUncaught('a picture that did not load');
    vi.advanceTimersByTime(ERROR_GRACE_MS * 4);

    expect(surfacePainted()).toBe(false);
  });

  it('shows the buffered error in the technical details', () => {
    installSentinel();
    throwUncaught('createBootCache is not defined');

    vi.advanceTimersByTime(ERROR_GRACE_MS);

    expect(technicalDetails()).toContain('createBootCache is not defined');
    expect(technicalDetails()).toContain('ReferenceError');
  });

  // The error text is attacker-adjacent: it can carry anything a thrown value stringified to, and
  // it is painted while the app's own escaping is exactly what failed to load.
  it('renders error text as text, never as markup', () => {
    installSentinel();
    dispatchError({ message: '<img src=x onerror="window.__xssFired = true">' });

    vi.advanceTimersByTime(ERROR_GRACE_MS);

    expect(document.querySelector('img')).toBeNull();
    expect(technicalDetails()).toContain('<img src=x onerror="window.__xssFired = true">');
    expect((window as unknown as { __xssFired?: boolean }).__xssFired).toBeUndefined();
  });

  it('reloads the page from Try again', () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { href: 'http://localhost/', reload });
    installSentinel();

    vi.advanceTimersByTime(BOOT_DEADLINE_MS);
    button('Try again')!.click();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('copies the details to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    installSentinel();
    throwUncaught('createBootCache is not defined');

    vi.advanceTimersByTime(ERROR_GRACE_MS);
    const copy = button('Copy details')!;
    copy.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain('createBootCache is not defined');
    expect(copy.textContent).toBe('Copied');
  });

  it('announces itself as a dialog and takes focus', () => {
    installSentinel();

    vi.advanceTimersByTime(BOOT_DEADLINE_MS);

    const panel = document.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(panel).not.toBeNull();
    expect(document.getElementById(panel!.getAttribute('aria-labelledby')!)?.textContent).toBe(
      HEADLINE
    );
    expect(document.activeElement).toBe(panel);
    // Focusing a non-tab-stop container makes Chrome ring the entire panel in
    // blue, over the brand edge. Verified in the browser; pinned here.
    expect(panel!.style.outline).toBe('none');
  });

  /**
   * The desktop shell asks the same question this sentinel does — "did this page ever come up?" —
   * and reloads, cache-clears and finally replaces a window that never answers (the desktop app's
   * `main/renderer-health/`, DOR-1453).
   */
  describe('reporting to the desktop shell', () => {
    /**
     * Put a preload bridge on `window`, the way the desktop app's does. Torn
     * down by the suite's `vi.unstubAllGlobals()`.
     */
    function installBridge(reportAlive: () => void): void {
      vi.stubGlobal('electronAPI', { reportAlive });
    }

    it('reports the window alive when the desktop bridge is there', () => {
      const reportAlive = vi.fn();
      installBridge(reportAlive);
      installSentinel();

      window.__dorkosBoot!.done();

      expect(reportAlive).toHaveBeenCalledTimes(1);
    });

    /** Probe C, the DOR-1448 replay. */
    it('reports alive when it paints its own failure panel — a readable panel is not a black window', () => {
      const reportAlive = vi.fn();
      installBridge(reportAlive);
      installSentinel();

      throwUncaught('ReferenceError: __APP_VERSION__ is not defined');
      vi.advanceTimersByTime(ERROR_GRACE_MS);

      expect(surfacePainted()).toBe(true);
      expect(reportAlive).toHaveBeenCalledTimes(1);
    });
  });
});
