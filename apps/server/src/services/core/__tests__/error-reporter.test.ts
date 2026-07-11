/**
 * Tests for the server error-reporter adapter: the consent + DSN gate (the
 * "fires only when opted in AND a DSN is set" guarantee) and that a live
 * reporter sends a scrubbed event to the DSN ingest endpoint.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { initServerErrorReporting, flushServerError } from '../error-reporter.js';
import { logger } from '../../../lib/logger.js';

const VALID_DSN = 'https://pub@o1.ingest.sentry.io/456';

const baseOptions = {
  version: '0.46.0',
  environment: 'production',
  cwd: '/srv/dorkos',
};

describe('initServerErrorReporting — consent + DSN gate', () => {
  it('returns null when consent is false (even with a DSN)', () => {
    const reporter = initServerErrorReporting({ ...baseOptions, consent: false, dsn: VALID_DSN });
    expect(reporter).toBeNull();
  });

  it('returns null and warns when consent is true but no DSN is set', () => {
    const reporter = initServerErrorReporting({ ...baseOptions, consent: true, dsn: undefined });
    expect(reporter).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no SENTRY_DSN'));
  });

  it('returns null and warns when the DSN is malformed', () => {
    const reporter = initServerErrorReporting({ ...baseOptions, consent: true, dsn: 'not-a-dsn' });
    expect(reporter).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('malformed'));
  });

  it('returns a reporter when consent is true and the DSN is valid', () => {
    const reporter = initServerErrorReporting({ ...baseOptions, consent: true, dsn: VALID_DSN });
    expect(reporter).not.toBeNull();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Error reporting enabled'));
  });
});

describe('ServerErrorReporter.capture', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalFetch) globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it('sends a scrubbed event to the DSN ingest URL and never throws', async () => {
    const reporter = initServerErrorReporting({ ...baseOptions, consent: true, dsn: VALID_DSN });
    expect(reporter).not.toBeNull();

    // capture now resolves when the send settles — await it directly.
    await reporter!.capture(new Error('boom at /Users/alice/x with sk-abcdefgh12345678'));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://o1.ingest.sentry.io/api/456/envelope/');
    // The message is omitted and PII scrubbed by the shared core.
    const body = init.body as string;
    expect(body).not.toContain('alice');
    expect(body).not.toContain('sk-abcdefgh12345678');
    expect(body).toContain('"surface":"server"');
    expect(body).toContain('dorkos@0.46.0');
  });
});

describe('flushServerError (fatal path)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalFetch) globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it('is a no-op that resolves when the reporter is null', async () => {
    await expect(flushServerError(null, new Error('boom'))).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('attempts the send (fetch) before resolving, so the report is not dropped on exit', async () => {
    const reporter = initServerErrorReporting({ ...baseOptions, consent: true, dsn: VALID_DSN });
    await flushServerError(reporter, new Error('boom'));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
