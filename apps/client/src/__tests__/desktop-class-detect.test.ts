/**
 * The inline desktop-shell class detector in `index.html` (DOR-562).
 *
 * `index.html`'s bootstrap script stamps class names onto `<html>` before
 * first paint, from `window.electronAPI` exposed by the desktop preload
 * script's contextBridge — paint-safe because the contextBridge runs before
 * this inline script does. Two classes come out of it:
 *
 * - `desktop-darwin`, macOS-only, for chrome that is meaningless against a
 *   native Windows frame (the drag region, the traffic-light inset).
 * - `desktop`, platform-neutral, for chrome that applies on every desktop
 *   platform — today that's the non-selectable-text default that makes the
 *   app read like an app rather than a document (`.desktop body` in
 *   `index.css`). Before this, that rule was scoped to `.desktop-darwin`
 *   only, so every label, header, and sidebar row was drag-selectable like a
 *   web page on the Windows alpha.
 *
 * **The subject is the HTML, not a module.** The detector runs inline against
 * `<html>` before React mounts, so there is no module to import — this reads
 * the shipped `index.html`, lifts the script out by its
 * `data-desktop-class-detect` marker, and evaluates that source directly.
 *
 * @module __tests__/desktop-class-detect
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// The shipped document itself, read as text — see boot-sentinel.test.ts for
// why `?raw` rather than `node:fs` (this runs under jsdom).
import indexHtml from '../../index.html?raw';

/**
 * The detector's source, lifted out of the document that ships it.
 *
 * @returns The JavaScript between the marked `<script>` tags.
 */
function readDetectorSource(): string {
  const match = /<script data-desktop-class-detect>([\s\S]*?)<\/script>/.exec(indexHtml);
  if (!match) {
    throw new Error(
      'apps/client/index.html has no <script data-desktop-class-detect> — the desktop class ' +
        'detector is gone, or its marker attribute was renamed and this test can no longer find it.'
    );
  }
  return match[1];
}

const DETECTOR_SOURCE = readDetectorSource();

/**
 * Evaluate the detector against the current jsdom window, exactly as the page
 * would. `new Function` because the subject under test is HTML source text —
 * there is no module to import.
 */
function runDetector(): void {
  new Function(DETECTOR_SOURCE)();
}

/** Stand in for the preload bridge's `window.electronAPI` with only what the detector reads. */
function setElectronPlatform(platform: string): void {
  window.electronAPI = { platform } as unknown as Window['electronAPI'];
}

describe('desktop class detector (index.html, DOR-562)', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('desktop', 'desktop-darwin', 'dark');
    delete window.electronAPI;
  });

  afterEach(() => {
    document.documentElement.classList.remove('desktop', 'desktop-darwin', 'dark');
    delete window.electronAPI;
  });

  it('adds neither class in a plain browser (no electronAPI)', () => {
    runDetector();

    expect(document.documentElement.classList.contains('desktop')).toBe(false);
    expect(document.documentElement.classList.contains('desktop-darwin')).toBe(false);
  });

  it('adds both desktop and desktop-darwin on macOS', () => {
    setElectronPlatform('darwin');

    runDetector();

    expect(document.documentElement.classList.contains('desktop')).toBe(true);
    expect(document.documentElement.classList.contains('desktop-darwin')).toBe(true);
  });

  it('adds the platform-neutral desktop class but NOT desktop-darwin on Windows', () => {
    setElectronPlatform('win32');

    runDetector();

    expect(document.documentElement.classList.contains('desktop')).toBe(true);
    expect(document.documentElement.classList.contains('desktop-darwin')).toBe(false);
  });

  it('adds the platform-neutral desktop class but NOT desktop-darwin on Linux', () => {
    setElectronPlatform('linux');

    runDetector();

    expect(document.documentElement.classList.contains('desktop')).toBe(true);
    expect(document.documentElement.classList.contains('desktop-darwin')).toBe(false);
  });
});
