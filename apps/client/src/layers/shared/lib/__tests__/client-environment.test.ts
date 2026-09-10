import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  FeedbackDiagnosticsSchema,
  MAX_CLIENT_REPORT_BROWSER_LEN,
  MAX_CLIENT_REPORT_TAG_LEN,
} from '@dorkos/shared/telemetry-events';
import { captureClientEnvironment } from '../client-environment';

/**
 * Build a diagnostics bundle around a captured environment and validate it, so
 * every assertion below is anchored to the STRICT schema that actually gates the
 * wire. A field name this capture gets wrong is a validation failure here rather
 * than a field that silently never arrives.
 */
function parseAsDiagnostics(env: ReturnType<typeof captureClientEnvironment>) {
  return FeedbackDiagnosticsSchema.safeParse({
    clientReport: { version: '1.0.0', platform: 'darwin-arm64', runtimes: [], flags: {}, ...env },
  });
}

describe('captureClientEnvironment', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as { electronAPI?: unknown }).electronAPI;
  });

  it('produces a bundle the strict schema accepts', () => {
    const result = parseAsDiagnostics(captureClientEnvironment('dark'));
    expect(result.success).toBe(true);
  });

  it('reports the resolved theme it was handed, not a preference', () => {
    // The caller resolves `system` before calling; this must not second-guess it
    // by reading matchMedia itself, or a dark-mode-on-a-light-OS report lies.
    expect(captureClientEnvironment('dark').theme).toBe('dark');
    expect(captureClientEnvironment('light').theme).toBe('light');
  });

  it('captures the window size and pixel density', () => {
    vi.stubGlobal('window', { ...window, innerWidth: 1280, innerHeight: 720, devicePixelRatio: 2 });

    expect(captureClientEnvironment('light').viewport).toEqual({
      width: 1280,
      height: 720,
      devicePixelRatio: 2,
    });
  });

  it('rounds a fractional viewport so the integer schema still accepts it', () => {
    // A zoomed window reports fractional CSS pixels. Passing them through fails
    // `z.number().int()`, which would drop the whole diagnostics bundle.
    vi.stubGlobal('window', {
      ...window,
      innerWidth: 1279.5,
      innerHeight: 719.2,
      devicePixelRatio: 1.5,
    });

    const env = captureClientEnvironment('light');
    expect(env.viewport).toEqual({ width: 1280, height: 719, devicePixelRatio: 1.5 });
    expect(parseAsDiagnostics(env).success).toBe(true);
  });

  it('reads the browser user agent', () => {
    vi.stubGlobal('navigator', { ...navigator, userAgent: 'Mozilla/5.0 (TestBrowser)' });

    expect(captureClientEnvironment('light').browser).toBe('Mozilla/5.0 (TestBrowser)');
  });

  it('truncates an over-long user agent to the schema cap', () => {
    // An over-cap string fails the strict schema, which loses the whole report.
    vi.stubGlobal('navigator', { ...navigator, userAgent: 'U'.repeat(5000) });

    const env = captureClientEnvironment('light');
    expect(env.browser).toHaveLength(MAX_CLIENT_REPORT_BROWSER_LEN);
    expect(parseAsDiagnostics(env).success).toBe(true);
  });

  it('truncates an over-long locale to the schema cap', () => {
    vi.stubGlobal('navigator', { ...navigator, language: 'x'.repeat(500) });

    const env = captureClientEnvironment('light');
    expect(env.locale).toHaveLength(MAX_CLIENT_REPORT_TAG_LEN);
    expect(parseAsDiagnostics(env).success).toBe(true);
  });

  it('reports the browser shell when there is no Electron bridge', () => {
    expect(captureClientEnvironment('light').shell).toBe('browser');
  });

  it('reports the desktop app when the Electron bridge is present', () => {
    // `isDesktopShell` feature-detects the METHOD, so a bare object must not
    // pass for the shell — that is what the function shape below pins.
    (window as { electronAPI?: unknown }).electronAPI = { getServerPort: () => 4242 };

    expect(captureClientEnvironment('light').shell).toBe('desktop-app');
  });

  it('reads the locale and an IANA timezone', () => {
    const env = captureClientEnvironment('light');

    expect(env.locale).toBe(navigator.language);
    // Asserted as a shape, not a literal: the value is whatever machine runs
    // this, and pinning a zone would make the test a CI-location test.
    expect(env.timezone).toEqual(expect.stringMatching(/^[A-Za-z]+(\/[A-Za-z_+\-0-9]+)*$/));
  });

  it('omits the timezone rather than throwing when Intl cannot resolve one', () => {
    // A partial `Intl` throws here on some hosts. A diagnostics nicety must
    // never be the reason a bug report fails to send.
    vi.stubGlobal('Intl', {
      DateTimeFormat: () => ({
        resolvedOptions: () => {
          throw new Error('no Intl data');
        },
      }),
    });

    const env = captureClientEnvironment('light');
    expect(env).not.toHaveProperty('timezone');
    expect(parseAsDiagnostics(env).success).toBe(true);
  });

  it('omits the viewport rather than throwing when there is no window', () => {
    vi.stubGlobal('window', undefined);

    const env = captureClientEnvironment('light');
    expect(env).not.toHaveProperty('viewport');
    expect(env.shell).toBe('browser');
    expect(parseAsDiagnostics(env).success).toBe(true);
  });

  it('omits the browser and locale rather than throwing when there is no navigator', () => {
    vi.stubGlobal('navigator', undefined);

    const env = captureClientEnvironment('light');
    expect(env).not.toHaveProperty('browser');
    expect(env).not.toHaveProperty('locale');
    expect(parseAsDiagnostics(env).success).toBe(true);
  });

  it('captures nothing outside the six declared environment fields', () => {
    // The strict schema is the send-side allowlist; this asserts the CAPTURE
    // side too, so a future read added here cannot ride along unreviewed.
    expect(Object.keys(captureClientEnvironment('light')).sort()).toEqual([
      'browser',
      'locale',
      'shell',
      'theme',
      'timezone',
      'viewport',
    ]);
  });
});
