/**
 * Tests for the server error-reporter (DOR-318). Covers the consent gate, that a
 * live reporter sends a scrubbed `$exception` batch to the owned ingest, the
 * debug (print-not-send) mode, the fatal-path flush, and — the security-critical
 * one — that `captureClientError` re-scrubs a HOSTILE client payload server-side.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  registerServerErrorReporting,
  isServerErrorReportingEnabled,
  captureServerError,
  captureClientError,
  flushServerError,
} from '../error-reporter.js';

const ENDPOINT = 'https://ingest.test/api/telemetry/events';

function makeDorkHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'srv-err-'));
}

function baseOptions(fetchImpl: typeof fetch, extra?: { debug?: boolean }) {
  return {
    version: '0.46.0',
    environment: 'production',
    cwd: '/srv/dorkos',
    dorkHome: makeDorkHome(),
    debug: extra?.debug ?? false,
    endpoint: ENDPOINT,
    fetchImpl,
  };
}

afterEach(() => {
  // Tear down the module singleton so tests don't leak state into each other.
  registerServerErrorReporting({
    consent: false,
    version: '0',
    environment: 'test',
    cwd: '/',
    dorkHome: '/',
    debug: false,
  });
  vi.clearAllMocks();
});

describe('registerServerErrorReporting — consent gate', () => {
  it('is disabled when consent is false', () => {
    registerServerErrorReporting({ ...baseOptions(vi.fn()), consent: false });
    expect(isServerErrorReportingEnabled()).toBe(false);
  });

  it('is enabled when consent is true', () => {
    registerServerErrorReporting({ ...baseOptions(vi.fn()), consent: true });
    expect(isServerErrorReportingEnabled()).toBe(true);
  });
});

describe('captureServerError', () => {
  it('is a silent no-op when reporting is off', async () => {
    const fetchSpy = vi.fn();
    registerServerErrorReporting({ ...baseOptions(fetchSpy), consent: false });
    await captureServerError(new Error('boom'));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends a scrubbed $exception batch to the owned ingest and never leaks', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    registerServerErrorReporting({ ...baseOptions(fetchSpy), consent: true });

    await captureServerError(new Error('boom at /Users/alice/x with sk-abcdefgh12345678'));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    const body = init.body as string;
    expect(body).not.toContain('alice');
    expect(body).not.toContain('sk-abcdefgh12345678');
    expect(body).toContain('"event":"$exception"');
    expect(body).toContain('"surface":"server"');
    expect(body).toContain('dorkos@0.46.0');
  });

  it('in debug mode prints and sends nothing', async () => {
    const fetchSpy = vi.fn();
    const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    registerServerErrorReporting({ ...baseOptions(fetchSpy, { debug: true }), consent: true });

    await captureServerError(new Error('boom'));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('$exception'));
    writeSpy.mockRestore();
  });
});

describe('captureClientError — server-side re-scrub of a hostile payload', () => {
  it('strips absolute paths and tokens the client tried to smuggle in', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    registerServerErrorReporting({ ...baseOptions(fetchSpy), consent: true });

    // A hostile client crafts a payload full of PII. The server must NOT trust
    // it — it rebuilds and scrubs before anything leaves.
    await captureClientError({
      name: 'Err_/Users/alice',
      message: 'user said hello; token sk-abcdef0123456789ABCDEF',
      stack: [
        'Error: boom',
        '    at h (/Users/alice/secret-client/apps/client/src/x.ts:5:9)',
        '    at C:\\Users\\alice\\dev\\y.ts:3:2',
      ].join('\n'),
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = (fetchSpy.mock.calls[0][1] as RequestInit).body as string;
    expect(body).not.toContain('alice');
    expect(body).not.toContain('secret-client');
    expect(body).not.toContain('sk-abcdef0123456789ABCDEF');
    expect(body).not.toContain('user said hello'); // raw message never sent
    expect(body).not.toContain('C:\\Users');
    // Reported under the client surface.
    expect(body).toContain('"surface":"client"');
  });

  it('is a no-op when reporting is off (route still accepts, drops here)', async () => {
    const fetchSpy = vi.fn();
    registerServerErrorReporting({ ...baseOptions(fetchSpy), consent: false });
    await captureClientError({ name: 'X', message: 'y', stack: 'Error: y' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('flushServerError (fatal path)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  });

  it('is a no-op that resolves when reporting is off', async () => {
    registerServerErrorReporting({ ...baseOptions(fetchSpy), consent: false });
    await expect(flushServerError(new Error('boom'))).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('attempts the send before resolving, so the report is not dropped on exit', async () => {
    registerServerErrorReporting({ ...baseOptions(fetchSpy), consent: true });
    await flushServerError(new Error('boom'));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
