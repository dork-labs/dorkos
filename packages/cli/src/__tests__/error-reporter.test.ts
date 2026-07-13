/**
 * Tests for the CLI error-reporter adapter (DOR-318): reading opt-in consent
 * from config.json, the consent + env-kill-switch gate (no DSN anymore), and
 * that a live reporter sends a scrubbed `$exception` batch to the owned ingest.
 * Scrubbing/mapping are covered by the shared `@dorkos/shared/error-report` tests.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  initCliErrorReporting,
  installCliErrorHandlers,
  readErrorReportingConsent,
  type CliErrorReporter,
} from '../lib/error-reporter.js';

// These tests intentionally set and read process.env kill switches / debug to
// exercise the gate, so the "read env via env.ts" rule does not apply here.
/* eslint-disable no-restricted-syntax */

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

describe('initCliErrorReporting — consent + env gate', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    delete process.env.DO_NOT_TRACK;
    delete process.env.DORKOS_TELEMETRY_DISABLED;
    delete process.env.DORKOS_TELEMETRY_DEBUG;
    process.env.NODE_ENV = savedEnv.NODE_ENV;
    vi.restoreAllMocks();
  });

  it('returns null when consent is false', () => {
    const dorkHome = makeDorkHome({ telemetry: { errorReporting: false } });
    expect(initCliErrorReporting({ dorkHome, version: '0.46.0' })).toBeNull();
  });

  it('returns null when an env kill switch is set, even if opted in', () => {
    process.env.DO_NOT_TRACK = '1';
    const dorkHome = makeDorkHome({ telemetry: { errorReporting: true } });
    expect(initCliErrorReporting({ dorkHome, version: '0.46.0' })).toBeNull();
  });

  it('returns a reporter when opted in and no kill switch is set (no DSN needed)', () => {
    const dorkHome = makeDorkHome({ telemetry: { errorReporting: true } });
    expect(initCliErrorReporting({ dorkHome, version: '0.46.0' })).not.toBeNull();
  });

  it('capture sends a scrubbed $exception batch to the owned ingest', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const dorkHome = makeDorkHome({ telemetry: { errorReporting: true } });

    const reporter = initCliErrorReporting({ dorkHome, version: '0.46.0' });
    await reporter!.capture(new Error('boom at /Users/alice/x with sk-abcdefgh12345678'));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://dorkos.ai/api/telemetry/events');
    const body = (init.body as string) ?? '';
    expect(body).not.toContain('alice');
    expect(body).not.toContain('sk-abcdefgh12345678');
    expect(body).toContain('"event":"$exception"');
    expect(body).toContain('"surface":"cli"');
    vi.unstubAllGlobals();
  });

  it('capture in debug mode prints and sends nothing', async () => {
    process.env.DORKOS_TELEMETRY_DEBUG = '1';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const dorkHome = makeDorkHome({ telemetry: { errorReporting: true } });

    const reporter = initCliErrorReporting({ dorkHome, version: '0.46.0' });
    await reporter!.capture(new Error('boom'));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('$exception'));
    vi.unstubAllGlobals();
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
    const reporter: CliErrorReporter = { capture: vi.fn().mockResolvedValue(undefined) };
    const uninstall = installCliErrorHandlers(reporter);
    expect(process.listenerCount('uncaughtException')).toBe(before.ue + 1);
    expect(process.listenerCount('unhandledRejection')).toBe(before.ur + 1);
    uninstall();
  });

  it('reporting OFF: no CLI handler is installed, so Node crash-on-rejection stands', () => {
    // Mirrors cli.ts: only install for a non-null reporter. initCliErrorReporting
    // returns null when reporting is off, so no listener is added and an
    // unhandled rejection keeps its default non-zero-exit behavior.
    const reporter: CliErrorReporter | null = null;
    const uninstall = reporter ? installCliErrorHandlers(reporter) : undefined;
    expect(uninstall).toBeUndefined();
    expect(process.listenerCount('unhandledRejection')).toBe(before.ur);
  });

  it('reporting ON: an unhandled rejection still exits non-zero, after attempting the send', async () => {
    const capture = vi.fn().mockResolvedValue(undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const priorRejection = process.listeners('unhandledRejection');
    const uninstall = installCliErrorHandlers({ capture });
    const added = process
      .listeners('unhandledRejection')
      .filter((l) => !priorRejection.includes(l));
    expect(added).toHaveLength(1);

    (added[0] as (reason: unknown) => void)(new Error('boom'));
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
    // Send was attempted before the exit fired (fatal-flush, not dropped).
    expect(capture).toHaveBeenCalledTimes(1);

    uninstall();
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});
