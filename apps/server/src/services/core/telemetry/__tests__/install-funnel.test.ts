/**
 * Tests for the app half of the install funnel (DOR-2862): `app_started`,
 * `first_run_completed` once per install with the install ref, and a daily
 * `instance_active`. Runs against the real usage reporter with an injected
 * `fetch`, so "sent" here means it reached the wire, and the opted-out case is
 * proved by what never reaches it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { recordInstallRef } from '@dorkos/shared/install-ref';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  flushUsageEvents,
  registerUsageReporter,
  shutdownUsageReporter,
} from '../../usage-reporter.js';
import { FUNNEL_STATE_FILENAME, startInstallFunnel, type FunnelConfig } from '../install-funnel.js';

const RUNTIMES = { codex: { enabled: true }, opencode: { enabled: false } };
const DONE = '2026-10-12T08:00:00Z';
const NOW = new Date('2026-10-12T09:00:00Z');

interface SentEvent {
  event: string;
  properties: Record<string, unknown>;
}

let dorkHome: string;
let stops: Array<() => void>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'install-funnel-'));
  stops = [];
  fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
});

afterEach(async () => {
  for (const stop of stops) stop();
  await shutdownUsageReporter();
  fs.rmSync(dorkHome, { recursive: true, force: true });
  vi.useRealTimers();
});

/** Live `telemetry.usage`, as the reporter's `isConsentLive` reads it. */
let usageSetting = true;

/** Register the real usage reporter, on or off, writing to `fetchMock`. */
function registerReporter(enabled: boolean): void {
  usageSetting = enabled;
  registerUsageReporter({
    enabled,
    isConsentLive: () => usageSetting,
    debug: false,
    dorkHome,
    dorkosVersion: '9.9.9',
    fetchImpl: fetchMock as unknown as typeof fetch,
    endpoint: 'https://example.invalid/api/telemetry/events',
  });
}

/** Flush the reporter and return every event that reached the wire so far. */
async function sent(): Promise<SentEvent[]> {
  await flushUsageEvents();
  return fetchMock.mock.calls.flatMap(
    ([, init]) =>
      (JSON.parse((init as RequestInit).body as string) as { events: SentEvent[] }).events
  );
}

/** A stand-in for the config manager: onboarding state plus a change feed the test fires. */
function fakeConfig(onboarding: { completedAt?: string | null; dismissedAt?: string | null }) {
  const listeners = new Set<(change: { sections: readonly string[] }) => void>();
  const state = { completedAt: null, dismissedAt: null, ...onboarding };
  const config = {
    get: (key: string) => (key === 'runtimes' ? RUNTIMES : state),
    onChange: (listener: (change: { sections: readonly string[] }) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as FunnelConfig;
  return {
    config,
    onboarding: state,
    emit: (sections: string[]) => listeners.forEach((listener) => listener({ sections })),
  };
}

/** Start the funnel; first run finished an hour ago unless told otherwise. */
function start(
  overrides: {
    cfg?: ReturnType<typeof fakeConfig>;
    now?: () => Date;
    checkIntervalMs?: number;
  } = {}
): void {
  stops.push(
    startInstallFunnel({
      dorkHome,
      config: (overrides.cfg ?? fakeConfig({ completedAt: DONE })).config,
      now: overrides.now ?? (() => NOW),
      checkIntervalMs: overrides.checkIntervalMs,
    })
  );
}

const names = (events: SentEvent[]) => events.map((e) => e.event);

describe('install funnel, usage channel on', () => {
  beforeEach(() => registerReporter(true));

  it('sends app_started, then the first run with the install ref, then instance_active', async () => {
    recordInstallRef(dorkHome, 'k3j4mnb8x2qa.hn.launch');
    start();
    const events = await sent();

    expect(events[0]).toMatchObject({
      event: 'app_started',
      properties: { os: `${process.platform}-${process.arch}`, runtimesConfigured: 2 },
    });
    expect(events[1]).toMatchObject({
      event: 'first_run_completed',
      properties: { installRef: 'k3j4mnb8x2qa', utmSource: 'hn', utmCampaign: 'launch' },
    });
    expect(events[2]).toMatchObject({ event: 'instance_active', properties: {} });
    expect(events[2]!.properties).toEqual({});
  });

  it('sends the first run with no ref properties when the install carried no ref', async () => {
    start();
    const firstRun = (await sent()).find((e) => e.event === 'first_run_completed');
    expect(firstRun?.properties).toEqual({});
  });

  it('never repeats the first run, or a day it already reported, after a restart', async () => {
    start();
    await sent();
    fetchMock.mockClear();

    start();
    expect(names(await sent())).toEqual(['app_started']);
  });

  it('waits for onboarding, then sends the first run when onboarding is written', async () => {
    const cfg = fakeConfig({});
    start({ cfg });
    cfg.emit(['ui']);
    expect(names(await sent())).not.toContain('first_run_completed');

    cfg.onboarding.completedAt = NOW.toISOString();
    cfg.emit(['onboarding']);
    cfg.emit(['onboarding']);
    expect(names(await sent()).filter((n) => n === 'first_run_completed')).toHaveLength(1);
  });

  it('sends instance_active again on a new UTC day, once', async () => {
    vi.useFakeTimers();
    let now = new Date('2026-10-12T23:30:00Z');
    start({ now: () => now, checkIntervalMs: 1000 });
    vi.advanceTimersByTime(3000);
    expect(names(await sent()).filter((n) => n === 'instance_active')).toHaveLength(1);

    now = new Date('2026-10-13T00:30:00Z');
    vi.advanceTimersByTime(3000);
    expect(names(await sent()).filter((n) => n === 'instance_active')).toHaveLength(2);
  });
  it('counts a dismissed first run as a first run (same rule as firstRunClosed)', async () => {
    start({ cfg: fakeConfig({ dismissedAt: DONE }) });
    expect(names(await sent())).toContain('first_run_completed');
  });

  it('does not send a late first run for an install upgrading in long after setup', async () => {
    start({ cfg: fakeConfig({ completedAt: '2026-06-01T00:00:00Z' }) });
    expect(names(await sent())).toEqual(['app_started', 'instance_active']);
    const state = JSON.parse(fs.readFileSync(path.join(dorkHome, FUNNEL_STATE_FILENAME), 'utf8'));
    expect(state.firstRunReportedAt).toEqual(expect.any(String));
  });

  it('writes the state file atomically, leaving no temp files behind', async () => {
    start();
    await sent();
    expect(fs.readdirSync(dorkHome).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('stops at once, sending and writing nothing, when usage is turned off mid-run', async () => {
    vi.useFakeTimers();
    let now = new Date('2026-10-12T23:30:00Z');
    const cfg = fakeConfig({});
    start({ cfg, now: () => now, checkIntervalMs: 1000 });
    await sent();
    fetchMock.mockClear();
    const before = fs.readFileSync(path.join(dorkHome, FUNNEL_STATE_FILENAME), 'utf8');

    usageSetting = false;
    cfg.onboarding.completedAt = now.toISOString();
    cfg.emit(['onboarding']);
    now = new Date('2026-10-13T00:30:00Z');
    vi.advanceTimersByTime(3000);

    expect(await sent()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(dorkHome, FUNNEL_STATE_FILENAME), 'utf8')).toBe(before);
  });

  it('drops events already queued when usage is turned off before the flush', async () => {
    start();
    usageSetting = false;
    expect(await sent()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('install funnel, person has not opted in', () => {
  it('sends nothing and writes nothing, even with an install ref on disk', async () => {
    recordInstallRef(dorkHome, 'k3j4mnb8x2qa.hn');
    registerReporter(false);
    start();

    expect(await sent()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dorkHome, FUNNEL_STATE_FILENAME))).toBe(false);
  });

  it('still sends the first run later, once the person opts in', async () => {
    registerReporter(false);
    start();
    registerReporter(true);
    start();
    expect(names(await sent())).toContain('first_run_completed');
  });
});
