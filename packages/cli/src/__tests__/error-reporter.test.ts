/**
 * Tests for the CLI error-reporter adapter: reading opt-in consent from
 * config.json and the consent + DSN gate. Scrubbing/send are covered by the
 * shared `@dorkos/shared/error-report` tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  initCliErrorReporting,
  installCliErrorHandlers,
  readErrorReportingConsent,
} from '../lib/error-reporter.js';

const VALID_DSN = 'https://pub@o1.ingest.sentry.io/456';

function makeDorkHome(config?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-err-'));
  if (config !== undefined) {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config), 'utf-8');
  }
  return dir;
}

describe('readErrorReportingConsent', () => {
  it('returns true only when telemetry.errorReporting === true', () => {
    expect(readErrorReportingConsent(makeDorkHome({ telemetry: { errorReporting: true } }))).toBe(
      true
    );
    expect(readErrorReportingConsent(makeDorkHome({ telemetry: { errorReporting: false } }))).toBe(
      false
    );
    expect(readErrorReportingConsent(makeDorkHome({ telemetry: {} }))).toBe(false);
  });

  it('returns false for a missing or corrupt config', () => {
    expect(readErrorReportingConsent(makeDorkHome())).toBe(false); // no file
    const dir = makeDorkHome();
    fs.writeFileSync(path.join(dir, 'config.json'), '{not json', 'utf-8');
    expect(readErrorReportingConsent(dir)).toBe(false);
  });
});

describe('initCliErrorReporting — consent + DSN gate', () => {
  const original = process.env.SENTRY_DSN;

  afterEach(() => {
    if (original === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = original;
  });

  it('returns null when consent is false, even with a DSN', () => {
    process.env.SENTRY_DSN = VALID_DSN;
    const dorkHome = makeDorkHome({ telemetry: { errorReporting: false } });
    expect(initCliErrorReporting({ dorkHome, version: '0.46.0' })).toBeNull();
  });

  it('returns null when consent is true but no DSN is set', () => {
    delete process.env.SENTRY_DSN;
    const dorkHome = makeDorkHome({ telemetry: { errorReporting: true } });
    expect(initCliErrorReporting({ dorkHome, version: '0.46.0' })).toBeNull();
  });

  it('returns null when the DSN is malformed', () => {
    process.env.SENTRY_DSN = 'not-a-dsn';
    const dorkHome = makeDorkHome({ telemetry: { errorReporting: true } });
    expect(initCliErrorReporting({ dorkHome, version: '0.46.0' })).toBeNull();
  });

  it('returns a reporter when opted in and a valid DSN is set', () => {
    process.env.SENTRY_DSN = VALID_DSN;
    const dorkHome = makeDorkHome({ telemetry: { errorReporting: true } });
    expect(initCliErrorReporting({ dorkHome, version: '0.46.0' })).not.toBeNull();
  });
});

describe('installCliErrorHandlers', () => {
  const before = {
    ue: process.listenerCount('uncaughtException'),
    ur: process.listenerCount('unhandledRejection'),
  };

  afterEach(() => {
    // Ensure no leaked listeners between tests.
    expect(process.listenerCount('uncaughtException')).toBe(before.ue);
    expect(process.listenerCount('unhandledRejection')).toBe(before.ur);
  });

  it('adds handlers and the returned uninstall removes exactly them', () => {
    const uninstall = installCliErrorHandlers(null);
    expect(process.listenerCount('uncaughtException')).toBe(before.ue + 1);
    expect(process.listenerCount('unhandledRejection')).toBe(before.ur + 1);
    uninstall();
  });
});
