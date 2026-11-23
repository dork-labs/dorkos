/**
 * Tests for the anonymous feature-usage reporter (DOR-315).
 *
 * Covers the consent gate (`enabled: false` → zero network; the call site folds
 * channel flag + env kill switch + the captured Tier 1 notice gate into that one
 * boolean — see `decideTier1Boot`), debug mode, the batch-and-flush behavior,
 * graceful-shutdown flush, and a no-PII assertion on the exact wire body.
 * `getOrCreateInstanceId` is mocked so no disk is touched; `fetch` is injected
 * so the payload is captured.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetOrCreateInstanceId } = vi.hoisted(() => ({
  mockGetOrCreateInstanceId: vi.fn(),
}));

vi.mock('../../../lib/instance-id.js', () => ({
  getOrCreateInstanceId: mockGetOrCreateInstanceId,
}));

import {
  registerUsageReporter,
  reportUsageEvent,
  flushUsageEvents,
  shutdownUsageReporter,
  USAGE_ENDPOINT,
} from '../usage-reporter.js';

const INSTANCE_ID = '7c6d2b9a-9f44-4f3a-bf67-3f3aa6bbf7c4';
const DORK_HOME = '/tmp/test-dork-home-usage';
const VERSION = '9.9.9-usage-test';

let fetchMock: ReturnType<typeof vi.fn>;

function baseOptions(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    debug: false,
    dorkHome: DORK_HOME,
    dorkosVersion: VERSION,
    endpoint: USAGE_ENDPOINT,
    fetchImpl: fetchMock as unknown as typeof fetch,
    ...overrides,
  };
}

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  mockGetOrCreateInstanceId.mockResolvedValue(INSTANCE_ID);
});

afterEach(async () => {
  await shutdownUsageReporter();
  vi.clearAllMocks();
});

describe('usage reporter gating', () => {
  it('does NOT register a sender when enabled is false', async () => {
    registerUsageReporter(baseOptions({ enabled: false }));
    reportUsageEvent({
      event: 'app_started',
      properties: { os: 'linux-x64', runtimesConfigured: 1 },
    });
    await flushUsageEvents();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reportUsageEvent is a no-op before registration', async () => {
    reportUsageEvent({ event: 'session_created', properties: { runtime: 'codex' } });
    registerUsageReporter(baseOptions());
    await flushUsageEvents();
    // Nothing was queued before registration, so no batch is sent.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('debug mode prints to stderr and sends nothing', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    registerUsageReporter(baseOptions({ debug: true }));
    reportUsageEvent({ event: 'session_created', properties: { runtime: 'claude-code' } });
    await flushUsageEvents();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('DORKOS_TELEMETRY_DEBUG'));
    stderrSpy.mockRestore();
  });
});

describe('batch + flush behavior', () => {
  it('enqueues events and flushes them as one batch', async () => {
    registerUsageReporter(baseOptions());
    reportUsageEvent({
      event: 'app_started',
      properties: { os: 'darwin-arm64', runtimesConfigured: 3 },
    });
    reportUsageEvent({ event: 'session_created', properties: { runtime: 'claude-code' } });

    await flushUsageEvents();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(USAGE_ENDPOINT);
    const body = JSON.parse(init.body as string) as {
      events: Array<{ event: string; distinctId: string; dorkosVersion: string }>;
    };
    expect(body.events).toHaveLength(2);
    expect(body.events[0].distinctId).toBe(INSTANCE_ID);
    expect(body.events[0].dorkosVersion).toBe(VERSION);
  });

  it('flush is a no-op when the queue is empty', async () => {
    registerUsageReporter(baseOptions());
    await flushUsageEvents();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops a malformed event rather than sending it', async () => {
    registerUsageReporter(baseOptions());
    // Cast through unknown to smuggle an unknown property past the type checker.
    reportUsageEvent({
      event: 'session_created',
      properties: { runtime: 'codex', secret: '/Users/kai' },
    } as unknown as Parameters<typeof reportUsageEvent>[0]);
    await flushUsageEvents();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('swallows a fetch rejection without throwing', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    registerUsageReporter(baseOptions());
    reportUsageEvent({ event: 'session_created', properties: { runtime: 'codex' } });
    await expect(flushUsageEvents()).resolves.toBeUndefined();
  });

  it('flushes remaining events on shutdown', async () => {
    registerUsageReporter(baseOptions());
    reportUsageEvent({ event: 'session_created', properties: { runtime: 'opencode' } });
    await shutdownUsageReporter();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // A second shutdown is a no-op.
    await shutdownUsageReporter();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('person profiles (DOR-4989)', () => {
  type SentEvent = { event: string; properties: Record<string, unknown> };

  /** Report one of each usage event, flush, and return what reached the wire. */
  async function sendAll(): Promise<SentEvent[]> {
    reportUsageEvent({
      event: 'app_started',
      properties: { os: 'linux-x64', runtimesConfigured: 1 },
    });
    reportUsageEvent({ event: 'session_created', properties: { runtime: 'codex' } });
    reportUsageEvent({ event: 'first_run_completed', properties: {} });
    reportUsageEvent({ event: 'instance_active', properties: {} });
    await flushUsageEvents();
    const [, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    return (JSON.parse(init.body as string) as { events: SentEvent[] }).events;
  }

  it('marks every usage event anonymous when the install is not linked to an account', async () => {
    registerUsageReporter(baseOptions());
    const events = await sendAll();
    expect(events.map((e) => e.event)).toEqual([
      'app_started',
      'session_created',
      'first_run_completed',
      'instance_active',
    ]);
    for (const e of events) expect(e.properties.$process_person_profile).toBe(false);
  });

  it('leaves the mark off when linked with analytics linking on', async () => {
    registerUsageReporter(baseOptions({ isAnalyticsLinkedToAccount: () => true }));
    const events = await sendAll();
    expect(events).toHaveLength(4);
    for (const e of events) expect(e.properties).not.toHaveProperty('$process_person_profile');
  });

  it('reads the link at send time, not once at registration', async () => {
    let linked = false;
    registerUsageReporter(baseOptions({ isAnalyticsLinkedToAccount: () => linked }));
    reportUsageEvent({ event: 'session_created', properties: { runtime: 'codex' } });
    linked = true;
    const events = await sendAll();
    for (const e of events) expect(e.properties).not.toHaveProperty('$process_person_profile');

    linked = false;
    for (const e of await sendAll()) expect(e.properties.$process_person_profile).toBe(false);
  });

  it('stays anonymous when the link check throws', async () => {
    registerUsageReporter(
      baseOptions({
        isAnalyticsLinkedToAccount: () => {
          throw new Error('link manager not ready');
        },
      })
    );
    for (const e of await sendAll()) expect(e.properties.$process_person_profile).toBe(false);
  });
});

describe('privacy — no PII on the wire', () => {
  it('the batch body carries only allowlisted event fields', async () => {
    registerUsageReporter(baseOptions());
    reportUsageEvent({ event: 'session_created', properties: { runtime: 'claude-code' } });
    await flushUsageEvents();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const bodyStr = init.body as string;
    for (const forbidden of ['cwd', 'path', 'prompt', 'email', 'hostname', 'username', 'token']) {
      expect(bodyStr).not.toContain(`"${forbidden}"`);
    }
    // Only the anonymous instance id appears as the identity.
    expect(bodyStr).toContain(INSTANCE_ID);
  });
});
