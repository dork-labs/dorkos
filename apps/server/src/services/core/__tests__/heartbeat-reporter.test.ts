/**
 * Tests for the anonymous daily heartbeat reporter.
 *
 * Covers the consent gate (the load-bearing "does NOT fire without consent"
 * guarantee), the daily-due cadence, and a privacy allow-list + no-PII check
 * on the exact wire body. Mocks `node:fs/promises` (last-sent marker + instance
 * id never touch disk) and `global.fetch` (to capture the payload).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import { UserConfigSchema } from '@dorkos/shared/config-schema';

const { mockReadFile, mockWriteFile, mockMkdir } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
  mockMkdir: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  default: { readFile: mockReadFile, writeFile: mockWriteFile, mkdir: mockMkdir },
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
}));

import {
  buildHeartbeatPayload,
  isHeartbeatDue,
  maybeSendHeartbeat,
  registerHeartbeat,
  HEARTBEAT_ENDPOINT,
  HEARTBEAT_INTERVAL_MS,
  LAST_SENT_FILENAME,
  type HeartbeatCounts,
  type HeartbeatOptions,
} from '../heartbeat-reporter.js';

const DORK_HOME = '/tmp/test-dork-home-heartbeat';
const DORKOS_VERSION = '9.9.9-heartbeat-test';

const ALLOWED_KEYS = [
  'instanceId',
  'dorkosVersion',
  'os',
  'runtimesConfigured',
  'tunnelEnabled',
  'cloudLinked',
  'counts',
] as const;

const counts: HeartbeatCounts = { agents: 4, tasks: 2, relayAdapters: 1 };

function makeOptions(overrides: Partial<HeartbeatOptions> = {}): HeartbeatOptions {
  return {
    consent: true,
    debug: false,
    dorkHome: DORK_HOME,
    dorkosVersion: DORKOS_VERSION,
    runtimesConfigured: ['claude-code', 'codex'],
    tunnelEnabled: false,
    cloudLinked: false,
    collectCounts: () => counts,
    ...overrides,
  };
}

describe('heartbeat-reporter', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    mockReadFile.mockReset();
    mockWriteFile.mockReset();
    mockMkdir.mockReset();
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    // Default: no instance-id file and no last-sent marker → generate id, due.
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  describe('consent gate', () => {
    it('maybeSendHeartbeat makes zero fetch/disk calls when consent is false', async () => {
      const sent = await maybeSendHeartbeat(makeOptions({ consent: false }));

      expect(sent).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mockReadFile).not.toHaveBeenCalled();
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('registerHeartbeat does not fire or schedule anything when consent is false', async () => {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

      registerHeartbeat(makeOptions({ consent: false }));
      // Let any (incorrectly) scheduled microtask settle.
      await Promise.resolve();

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mockReadFile).not.toHaveBeenCalled();
      expect(setIntervalSpy).not.toHaveBeenCalled();
      setIntervalSpy.mockRestore();
    });
  });

  describe('debug mode', () => {
    it('prints the payload to stderr and skips the network + last-sent write', async () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      const sent = await maybeSendHeartbeat(makeOptions({ debug: true }));

      expect(sent).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
      // The instance-id file may still be created (a local id, not telemetry),
      // but the cadence marker is never written in debug mode so it can be
      // re-inspected on every start.
      const wroteMarker = mockWriteFile.mock.calls.some((c) =>
        String(c[0]).endsWith(LAST_SENT_FILENAME)
      );
      expect(wroteMarker).toBe(false);
      const printed = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(printed).toContain('DORKOS_TELEMETRY_DEBUG');
      expect(printed).toContain('runtimesConfigured');
      stderrSpy.mockRestore();
    });
  });

  describe('cadence', () => {
    it('isHeartbeatDue is true when never sent', () => {
      expect(isHeartbeatDue(null, Date.now())).toBe(true);
    });

    it('isHeartbeatDue respects the daily interval', () => {
      const now = 1_000_000_000_000;
      expect(isHeartbeatDue(now - HEARTBEAT_INTERVAL_MS + 1, now)).toBe(false);
      expect(isHeartbeatDue(now - HEARTBEAT_INTERVAL_MS, now)).toBe(true);
    });

    it('does not send when a recent heartbeat exists', async () => {
      mockReadFile.mockResolvedValue(String(Date.now()));

      const sent = await maybeSendHeartbeat(makeOptions());

      expect(sent).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('sends and records the timestamp when due', async () => {
      const sent = await maybeSendHeartbeat(makeOptions());

      expect(sent).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(HEARTBEAT_ENDPOINT);
      expect(init.method).toBe('POST');
      // Records last-sent (writes both the new instance id and the marker).
      expect(mockWriteFile).toHaveBeenCalled();
    });
  });

  describe('privacy', () => {
    it('sends only allow-listed keys', async () => {
      await maybeSendHeartbeat(makeOptions());

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      const allowed = new Set<string>(ALLOWED_KEYS);
      for (const key of Object.keys(body)) {
        expect(allowed.has(key)).toBe(true);
      }
      expect(body.counts).toEqual(counts);
      expect(body.dorkosVersion).toBe(DORKOS_VERSION);
    });

    it('never includes runtime PII (hostname, username, cwd)', async () => {
      const hostname = os.hostname();
      const username = os.userInfo().username;
      const cwd = process.cwd();

      await maybeSendHeartbeat(makeOptions());

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const bodyString = init.body as string;
      expect(bodyString).not.toContain(hostname);
      expect(bodyString).not.toContain(username);
      expect(bodyString).not.toContain(cwd);
      expect(bodyString).not.toMatch(/"\/(?:Users|home|var|etc|opt)/);
    });

    // The profile never leaves the machine (spec user-profile-onboarding
    // §Privacy invariant). HeartbeatPayload is a closed interface with no
    // profile field; this pins that a config carrying a fully-populated
    // profile still contributes nothing profile-shaped to the wire body when
    // the inputs are derived from it the way the boot wiring does. What it
    // proves is exactly that: the sentinel values and the key `profile` are
    // absent from THIS body. A new payload field that reads the profile
    // through some other route is caught by the exact-shape pin in
    // `buildHeartbeatPayload emits exactly the allow-listed shape` below, not
    // by this test alone.
    it('a fully-populated profile never reaches the heartbeat wire body', async () => {
      const SENTINELS = [
        'SENTINEL-ROLE-hiring',
        'SENTINEL-TOOL-greenhouse',
        'SENTINEL-NAME-dorian',
      ];
      const config = UserConfigSchema.parse({
        version: 1,
        profile: {
          roles: [SENTINELS[0]],
          tools: [SENTINELS[1]],
          displayName: SENTINELS[2],
          rolePromptDismissedAt: '2026-07-29T00:00:00.000Z',
        },
        telemetry: { heartbeat: true, userHasDecided: true },
      });

      // Mirror the boot wiring: every heartbeat input that reads config is
      // derived from THIS config, so anything the payload could carry from a
      // profile-bearing config would show up here.
      await maybeSendHeartbeat(
        makeOptions({
          runtimesConfigured: ['claude-code'],
          tunnelEnabled: config.tunnel.enabled,
          cloudLinked: config.cloud.instanceToken != null,
        })
      );

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const bodyString = init.body as string;
      for (const sentinel of SENTINELS) {
        expect(bodyString).not.toContain(sentinel);
      }
      const body = JSON.parse(bodyString) as Record<string, unknown>;
      expect(Object.keys(body)).not.toContain('profile');
      expect(bodyString.toLowerCase()).not.toContain('"profile"');
    });
  });

  describe('buildHeartbeatPayload', () => {
    it('derives os from the running platform and passes fields through', () => {
      const payload = buildHeartbeatPayload({
        instanceId: 'id-1',
        dorkosVersion: DORKOS_VERSION,
        runtimesConfigured: ['claude-code'],
        tunnelEnabled: true,
        cloudLinked: true,
        counts,
      });
      expect(payload.os).toBe(`${process.platform}-${process.arch}`);
      expect(payload.tunnelEnabled).toBe(true);
      expect(payload.cloudLinked).toBe(true);
      expect(payload.instanceId).toBe('id-1');
    });

    // The exact-shape pin behind the privacy tests above: `toStrictEqual`
    // fails on ANY extra key, including one whose value happens to be
    // undefined — which JSON.stringify would silently drop from the wire
    // body, so the string-based sentinel checks alone could not see it.
    it('emits exactly the allow-listed shape, nothing more', () => {
      const payload = buildHeartbeatPayload({
        instanceId: 'id-1',
        dorkosVersion: DORKOS_VERSION,
        runtimesConfigured: ['claude-code'],
        tunnelEnabled: false,
        cloudLinked: false,
        counts,
      });
      expect(payload).toStrictEqual({
        instanceId: 'id-1',
        dorkosVersion: DORKOS_VERSION,
        os: `${process.platform}-${process.arch}`,
        runtimesConfigured: ['claude-code'],
        tunnelEnabled: false,
        cloudLinked: false,
        counts,
      });
    });
  });
});
