/**
 * A fresh install's first run, across real boots (DOR-5018): the first boot
 * shows the notice with nobody answered, the person finishes setup and says
 * yes to usage data on that same boot, and exactly one `first_run_completed`
 * reaches the wire. A second start sends none, and a person who never answers
 * sends nothing at all.
 *
 * Each boot wires the real consent helpers, usage reporter and install funnel
 * the way the server's startup step does, over a config store with a change
 * feed and an injected `fetch`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { decideTier1Boot } from '../../telemetry-first-run.js';
import { resolveTier1ChannelConsent } from '@dorkos/shared/telemetry-consent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  flushUsageEvents,
  registerUsageReporter,
  shutdownUsageReporter,
} from '../../usage-reporter.js';
import { startInstallFunnel, type FunnelConfig } from '../install-funnel.js';
import { startUsageChannel } from '../usage-channel.js';

const VERSION = '9.9.9';

interface Telemetry {
  userHasDecided: boolean;
  lastPromptedVersion: string | null;
  install: boolean;
  heartbeat: boolean;
  usage: boolean;
}

interface Store {
  telemetry: Telemetry;
  onboarding: { completedAt: string | null; dismissedAt: string | null };
  runtimes: { codex: { enabled: boolean }; opencode: { enabled: boolean } };
}

let dorkHome: string;
let fetchMock: ReturnType<typeof vi.fn>;
let stops: Array<() => void>;

beforeEach(() => {
  dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-channel-'));
  fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  stops = [];
});

afterEach(async () => {
  for (const stop of stops) stop();
  await shutdownUsageReporter();
  fs.rmSync(dorkHome, { recursive: true, force: true });
});

/** A config store that persists across boots and fires a change feed on each set. */
function makeStore(): {
  store: Store;
  config: FunnelConfig & { set: <K extends keyof Store>(key: K, value: Store[K]) => void };
  resetListeners: () => void;
} {
  const store: Store = {
    telemetry: {
      userHasDecided: false,
      lastPromptedVersion: null,
      install: false,
      heartbeat: false,
      usage: false,
    },
    onboarding: { completedAt: null, dismissedAt: null },
    runtimes: { codex: { enabled: false }, opencode: { enabled: false } },
  };
  let listeners = new Set<(change: { sections: readonly string[] }) => void>();
  const config = {
    get: (key: keyof Store) => store[key],
    set: <K extends keyof Store>(key: K, value: Store[K]) => {
      store[key] = value;
      for (const listener of [...listeners]) listener({ sections: [key] });
    },
    onChange: (listener: (change: { sections: readonly string[] }) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    store,
    config: config as unknown as FunnelConfig & {
      set: <K extends keyof Store>(key: K, value: Store[K]) => void;
    },
    resetListeners: () => {
      listeners = new Set();
    },
  };
}

/** One server boot's usage-channel wiring, as the startup step does it. */
function boot(config: ReturnType<typeof makeStore>['config'], store: Store): void {
  const decision = decideTier1Boot(store.telemetry, VERSION);
  const usageOn = () => resolveTier1ChannelConsent(store.telemetry, 'usage', {});
  const consentedAtBoot = usageOn() && decision.sendGate;
  if (decision.showNotice) {
    store.telemetry = { ...store.telemetry, lastPromptedVersion: VERSION };
  }
  stops.push(
    startUsageChannel({
      consentedAtBoot,
      usageOn,
      onChange: (listener) => config.onChange(listener),
      start: () => {
        registerUsageReporter({
          enabled: true,
          isConsentLive: usageOn,
          debug: false,
          dorkHome,
          dorkosVersion: VERSION,
          fetchImpl: fetchMock as unknown as typeof fetch,
          endpoint: 'https://example.invalid/api/telemetry/events',
        });
        stops.push(startInstallFunnel({ dorkHome, config }));
      },
    })
  );
}

/** Stop the boot's timers and listeners, flushing what it queued, like a shutdown. */
async function shutdown(resetListeners: () => void): Promise<void> {
  for (const stop of stops.splice(0)) stop();
  await shutdownUsageReporter();
  resetListeners();
}

/** Every event name that reached the wire so far. */
async function sentNames(): Promise<string[]> {
  await flushUsageEvents();
  return fetchMock.mock.calls.flatMap(([, init]) =>
    (
      JSON.parse((init as RequestInit).body as string) as { events: Array<{ event: string }> }
    ).events.map((e) => e.event)
  );
}

describe('a fresh install’s first run (DOR-5018)', () => {
  it('sends exactly one first_run_completed when the person says yes on the first boot', async () => {
    const { store, config, resetListeners } = makeStore();

    // Boot 1: nobody has answered; the notice shows and nothing may send yet.
    boot(config, store);
    expect(await sentNames()).toEqual([]);

    // Setup finishes, then the consent card's "yes" lands, on this same boot.
    config.set('onboarding', { completedAt: new Date().toISOString(), dismissedAt: null });
    config.set('telemetry', {
      ...store.telemetry,
      userHasDecided: true,
      install: true,
      heartbeat: true,
      usage: true,
    });
    await shutdown(resetListeners);
    expect((await sentNames()).filter((e) => e === 'first_run_completed')).toHaveLength(1);

    // Boot 2: a restart sends app_started again, but never a second first run.
    fetchMock.mockClear();
    boot(config, store);
    const second = await sentNames();
    expect(second).toContain('app_started');
    expect(second).not.toContain('first_run_completed');
  });

  it('sends nothing at all while the person has not answered', async () => {
    const { store, config, resetListeners } = makeStore();
    boot(config, store);
    config.set('onboarding', { completedAt: new Date().toISOString(), dismissedAt: null });
    // A stored "on" flag nobody answered for is not consent (DOR-4400).
    config.set('telemetry', { ...store.telemetry, usage: true });
    await shutdown(resetListeners);
    boot(config, store);
    expect(await sentNames()).toEqual([]);
  });

  it('stays silent after a "no", even when the setting changes for another reason', async () => {
    const { store, config, resetListeners } = makeStore();
    boot(config, store);
    config.set('onboarding', { completedAt: new Date().toISOString(), dismissedAt: null });
    config.set('telemetry', { ...store.telemetry, userHasDecided: true });
    config.set('telemetry', { ...store.telemetry, heartbeat: false });
    await shutdown(resetListeners);
    expect(await sentNames()).toEqual([]);
  });
});
