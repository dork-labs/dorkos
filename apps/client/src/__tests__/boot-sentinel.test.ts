/**
 * The inline boot sentinel in `index.html` (DOR-1451).
 *
 * v0.63.0 shipped a bundle that threw at module scope. React never mounted,
 * `#root` stayed empty, and the window was a black rectangle with nothing to
 * read and nothing to click. The sentinel's job is to make that whole class of
 * failure legible: buffer whatever went wrong, and if nothing has mounted by the
 * time its watchdog expires, paint a readable panel into `#root`.
 *
 * **The subject is the HTML, not a module.** The sentinel cannot import anything
 * — it has to run when the bundle is exactly what is broken — so there is no
 * module to test. This reads the shipped `index.html`, lifts the script out of
 * it by its `data-boot-sentinel` marker, and evaluates that source against the
 * document's own `<body>` markup, also taken from that file. A test that
 * re-implemented either half would pass forever while the document shipped
 * something else — in particular, a static skeleton added to `#root` must reach
 * the mounted-already guard here rather than silently switching it off.
 *
 * The deadlines are written out as literals below rather than parsed back out of
 * the source. Parsing them would make this green for any value the file happened
 * to contain, which is the one thing a watchdog test must not be.
 *
 * @module __tests__/boot-sentinel
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// The shipped document itself, read as text. `?raw` rather than `node:fs`
// because this file runs under jsdom, where `import.meta.url` is an http URL and
// cannot be resolved to a path.
import indexHtml from '../../index.html?raw';

/** How long a *finished* document may take to call `done()` before the surface paints. */
const BOOT_DEADLINE_MS = 10_000;
/** The backstop for a document that never finishes loading at all. */
const BOOT_CEILING_MS = 60_000;
/** How long after an uncaught error the sentinel waits before deciding it was fatal. */
const ERROR_GRACE_MS = 3_000;
/** How long a copy-button label stays swapped before returning to rest. */
const COPY_FEEDBACK_MS = 2_000;
/** The headline the failure surface leads with. */
const HEADLINE = "DorkOS couldn't finish starting.";

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

/**
 * Evaluate the sentinel against the current jsdom window, exactly as the page
 * would. `new Function` because the subject under test is HTML source text —
 * there is no module to import.
 */
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

/**
 * Report an uncaught error to the window the way a dying bundle does.
 *
 * Dispatched cancelable and cancelled: an `error` event nobody cancels keeps its
 * default action, which is "report this as an uncaught exception", and the test
 * harness then fails the run over a failure the test staged on purpose. The
 * suppressor is registered last, so the sentinel's own listener has already seen
 * the event untouched.
 */
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

  // The regression that made this gate exist: measured in Chromium at
  // 400 kbit/s, the bundle was still downloading at the deadline and the bare
  // timeout painted over a healthy boot — after which "Try again" cancelled the
  // in-flight request and started the ~1.16MB download again from zero.
  it('does not paint while the document is still loading', () => {
    setReadyState('interactive');
    installSentinel();

    vi.advanceTimersByTime(BOOT_DEADLINE_MS * 3);

    expect(surfacePainted()).toBe(false);
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

  // done() must disarm the ERROR path too, not just cancel the pending timer:
  // an error arriving after a successful boot belongs to the running app's own
  // reporting, and must never repaint the cockpit as a failure.
  it('ignores an error that arrives after a successful boot', () => {
    installSentinel();
    window.__dorkosBoot?.done();

    throwUncaught('a late failure in the running app');
    vi.advanceTimersByTime(BOOT_CEILING_MS * 3);

    expect(surfacePainted()).toBe(false);
  });

  it('does not paint over an app that mounted without calling done()', () => {
    installSentinel();
    document.getElementById('root')!.innerHTML = '<main>the app</main>';

    vi.advanceTimersByTime(BOOT_CEILING_MS);

    expect(rootText()).toBe('the app');
  });

  // Whitespace is not an app. A static skeleton's indentation text node would
  // otherwise read as "React is up" and disable the watchdog for good.
  it('still paints when #root holds nothing but whitespace', () => {
    installSentinel();
    document.getElementById('root')!.innerHTML = '\n      ';

    vi.advanceTimersByTime(BOOT_DEADLINE_MS);

    expect(rootText()).toContain(HEADLINE);
  });

  it('falls back to the body when #root is missing entirely', () => {
    installSentinel();
    document.getElementById('root')!.remove();

    vi.advanceTimersByTime(BOOT_DEADLINE_MS);

    expect(surfacePainted()).toBe(true);
    expect(button('Try again')).toBeDefined();
  });

  it('gives up early when an uncaught error left #root empty', () => {
    installSentinel();
    throwUncaught('createBootCache is not defined');

    vi.advanceTimersByTime(ERROR_GRACE_MS - 1);
    expect(rootText()).toBe('');

    vi.advanceTimersByTime(1);
    expect(rootText()).toContain(HEADLINE);
  });

  it('lets a mid-boot error pass when React mounts anyway', () => {
    installSentinel();
    throwUncaught('a passing squall');
    document.getElementById('root')!.innerHTML = '<main>the app</main>';

    vi.advanceTimersByTime(ERROR_GRACE_MS);

    expect(rootText()).toBe('the app');
  });

  it('shows the buffered error in the technical details', () => {
    installSentinel();
    throwUncaught('createBootCache is not defined');

    vi.advanceTimersByTime(ERROR_GRACE_MS);

    expect(technicalDetails()).toContain('createBootCache is not defined');
    expect(technicalDetails()).toContain('ReferenceError');
  });

  it('buffers unhandled promise rejections too', () => {
    installSentinel();
    const event = new Event('unhandledrejection') as Event & { reason?: unknown };
    event.reason = new Error('config fetch exploded');
    window.dispatchEvent(event);

    vi.advanceTimersByTime(ERROR_GRACE_MS);

    expect(technicalDetails()).toContain('config fetch exploded');
  });

  it('buffers a bundle that failed to load at all', () => {
    installSentinel();
    const script = document.createElement('script');
    script.src = '/assets/missing-chunk.js';
    document.body.appendChild(script);
    script.dispatchEvent(new Event('error'));

    vi.advanceTimersByTime(ERROR_GRACE_MS);

    expect(technicalDetails()).toContain('missing-chunk.js');
  });

  it('keeps exactly five buffered failures however many arrive', () => {
    installSentinel();
    for (let i = 0; i < 40; i += 1) throwUncaught(`failure number ${i}`);

    vi.advanceTimersByTime(ERROR_GRACE_MS);

    const kept = technicalDetails().match(/failure number \d+/g) ?? [];
    expect(kept).toHaveLength(5);
    expect(kept).toEqual([
      'failure number 0',
      'failure number 1',
      'failure number 2',
      'failure number 3',
      'failure number 4',
    ]);
  });

  // The error text is attacker-adjacent: it can carry anything a thrown value
  // stringified to, and it is painted while the app's own escaping is exactly
  // what failed to load.
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

  // Restoring "whatever the label said a moment ago" would capture "Copied" on
  // the second click and leave the button stuck on it forever.
  it('returns the copy button to rest after repeated clicks', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    installSentinel();

    vi.advanceTimersByTime(BOOT_DEADLINE_MS);
    const copy = button('Copy details')!;

    copy.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(copy.textContent).toBe('Copied');

    // A second click lands while the label is still swapped.
    await vi.advanceTimersByTimeAsync(COPY_FEEDBACK_MS / 2);
    copy.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(copy.textContent).toBe('Copied');

    await vi.advanceTimersByTimeAsync(COPY_FEEDBACK_MS);
    expect(copy.textContent).toBe('Copy details');
  });

  it('survives a browser with no clipboard API', () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    installSentinel();

    vi.advanceTimersByTime(BOOT_DEADLINE_MS);

    expect(() => button('Copy details')!.click()).not.toThrow();
    // The textarea fallback cleans up after itself either way.
    expect(document.querySelector('body > textarea')).toBeNull();
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

  it('follows the theme the page already chose', () => {
    document.documentElement.classList.add('dark');
    installSentinel();

    vi.advanceTimersByTime(BOOT_DEADLINE_MS);

    const surface = document.getElementById('root')!.firstElementChild as HTMLElement;
    expect(surface.style.background).toBe('rgb(10, 10, 10)');
  });
});
