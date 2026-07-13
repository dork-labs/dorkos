/**
 * Tests for the cockpit crash reporter (DOR-318): it relays a caught error to
 * `transport.reportError` exactly ONCE per unique error per session (dedup), and
 * never throws or loops even when the transport itself rejects.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  reportClientError,
  installClientErrorHandlers,
  __resetClientErrorReporterForTests,
} from '../client-error-reporter';

afterEach(() => {
  __resetClientErrorReporterForTests();
  vi.restoreAllMocks();
});

describe('reportClientError', () => {
  it('relays a caught error to transport.reportError with only the raw strings', () => {
    const reportError = vi.fn().mockResolvedValue(undefined);
    const err = new TypeError('boom');
    reportClientError({ reportError }, err);

    expect(reportError).toHaveBeenCalledTimes(1);
    const payload = reportError.mock.calls[0][0] as {
      name: string;
      message: string;
      stack?: string;
    };
    expect(payload.name).toBe('TypeError');
    expect(payload.message).toBe('boom');
    expect(typeof payload.stack === 'string' || payload.stack === undefined).toBe(true);
  });

  it('dedupes: the same error reports only once per session', () => {
    const reportError = vi.fn().mockResolvedValue(undefined);
    const err = new Error('same');
    err.stack = 'Error: same\n    at foo (app.ts:1:1)';

    reportClientError({ reportError }, err);
    reportClientError({ reportError }, err);
    reportClientError({ reportError }, err);

    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('reports two DISTINCT errors separately', () => {
    const reportError = vi.fn().mockResolvedValue(undefined);
    reportClientError({ reportError }, new Error('one'));
    reportClientError({ reportError }, new Error('two'));
    expect(reportError).toHaveBeenCalledTimes(2);
  });

  it('never throws even if the transport rejects (no loop)', () => {
    const reportError = vi.fn().mockRejectedValue(new Error('network'));
    expect(() => reportClientError({ reportError }, new Error('boom'))).not.toThrow();
  });

  it('handles a non-Error thrown value', () => {
    const reportError = vi.fn().mockResolvedValue(undefined);
    reportClientError({ reportError }, 'a plain string');
    expect(reportError).toHaveBeenCalledTimes(1);
    expect((reportError.mock.calls[0][0] as { name: string }).name).toBe('UnknownError');
  });
});

describe('installClientErrorHandlers', () => {
  it('reports window error + unhandledrejection, then uninstall stops it', () => {
    const reportError = vi.fn().mockResolvedValue(undefined);
    const uninstall = installClientErrorHandlers({ reportError });

    // Use message-only ErrorEvents: passing a real `error` makes jsdom log a
    // synthetic "uncaught" error, which is noise unrelated to what we assert.
    window.dispatchEvent(new ErrorEvent('error', { message: 'window-boom' }));
    // Distinct error so dedup doesn't collapse it with the first.
    const rejection = new Event('unhandledrejection') as Event & { reason?: unknown };
    rejection.reason = new Error('rejected-boom');
    window.dispatchEvent(rejection);

    expect(reportError).toHaveBeenCalledTimes(2);

    uninstall();
    window.dispatchEvent(new ErrorEvent('error', { message: 'after-uninstall' }));
    expect(reportError).toHaveBeenCalledTimes(2);
  });
});
