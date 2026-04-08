/**
 * Tests for the dorkos.ai marketplace telemetry reporter.
 *
 * Mocks `node:fs/promises` (so install-id reads/writes never touch disk) and
 * `global.fetch` (so we can assert the wire-format payload). Each test starts
 * from a clean reporter slot via `_resetTelemetryReporter()`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const { mockReadFile, mockWriteFile, mockMkdir } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
  mockMkdir: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    mkdir: mockMkdir,
  },
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
}));

import {
  _resetTelemetryReporter,
  reportInstallEvent,
  type InstallEvent,
} from '../telemetry-hook.js';
import {
  buildPayload,
  getOrCreateInstallId,
  registerDorkosCommunityTelemetry,
} from '../telemetry-reporter.js';

const DORK_HOME = '/tmp/test-dork-home';
const INSTALL_ID_PATH = path.join(DORK_HOME, 'telemetry-install-id');
const TELEMETRY_ENDPOINT = 'https://dorkos.ai/api/telemetry/install';
const DORKOS_VERSION = '1.2.3';

const sampleEvent: InstallEvent = {
  packageName: 'code-reviewer',
  marketplace: 'dorkos-community',
  type: 'agent',
  outcome: 'success',
  durationMs: 4321,
};

const sampleFailureEvent: InstallEvent = {
  ...sampleEvent,
  outcome: 'failure',
  errorCode: 'NETWORK_ERROR',
};

describe('telemetry-reporter', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    _resetTelemetryReporter();
    mockReadFile.mockReset();
    mockWriteFile.mockReset();
    mockMkdir.mockReset();
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);

    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
  });

  describe('registerDorkosCommunityTelemetry', () => {
    it('does NOT register a reporter when consent is false', async () => {
      registerDorkosCommunityTelemetry(false, DORK_HOME, DORKOS_VERSION);

      await reportInstallEvent(sampleEvent);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockReadFile).not.toHaveBeenCalled();
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('registers a reporter that POSTs the correct URL and JSON body when consent is true', async () => {
      mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      registerDorkosCommunityTelemetry(true, DORK_HOME, DORKOS_VERSION);
      await reportInstallEvent(sampleEvent);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(TELEMETRY_ENDPOINT);
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');

      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body).toMatchObject({
        packageName: 'code-reviewer',
        marketplace: 'dorkos-community',
        type: 'agent',
        outcome: 'success',
        durationMs: 4321,
        dorkosVersion: DORKOS_VERSION,
      });
      expect(typeof body.installId).toBe('string');
      expect((body.installId as string).length).toBeGreaterThan(0);
    });
  });

  describe('getOrCreateInstallId', () => {
    it('reads existing UUID from disk when present', async () => {
      const existingId = '11111111-2222-3333-4444-555555555555';
      mockReadFile.mockResolvedValue(`${existingId}\n`);

      const id = await getOrCreateInstallId(DORK_HOME);

      expect(id).toBe(existingId);
      expect(mockReadFile).toHaveBeenCalledWith(INSTALL_ID_PATH, 'utf8');
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('generates and writes a new UUID when the file is missing', async () => {
      mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const id = await getOrCreateInstallId(DORK_HOME);

      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(mockMkdir).toHaveBeenCalledWith(DORK_HOME, { recursive: true });
      expect(mockWriteFile).toHaveBeenCalledWith(INSTALL_ID_PATH, id, 'utf8');
    });

    it('returns the same UUID across two calls', async () => {
      // Simulate a real filesystem with a single in-memory cell so the
      // second `getOrCreateInstallId` reads what the first one wrote.
      let stored: string | null = null;
      mockReadFile.mockImplementation(async () => {
        if (stored === null) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        return stored;
      });
      mockWriteFile.mockImplementation(async (_p, contents) => {
        stored = contents as string;
      });

      const first = await getOrCreateInstallId(DORK_HOME);
      const second = await getOrCreateInstallId(DORK_HOME);

      expect(second).toBe(first);
      // Only the first call should have written to disk.
      expect(mockWriteFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('buildPayload', () => {
    it('includes installId and dorkosVersion always', () => {
      const payload = buildPayload(sampleEvent, 'install-id-1', DORKOS_VERSION);

      expect(payload.installId).toBe('install-id-1');
      expect(payload.dorkosVersion).toBe(DORKOS_VERSION);
      expect(payload.packageName).toBe(sampleEvent.packageName);
      expect(payload.marketplace).toBe(sampleEvent.marketplace);
      expect(payload.type).toBe(sampleEvent.type);
      expect(payload.outcome).toBe(sampleEvent.outcome);
      expect(payload.durationMs).toBe(sampleEvent.durationMs);
    });

    it('includes errorCode only when present on the event', () => {
      const successPayload = buildPayload(sampleEvent, 'id', DORKOS_VERSION);
      expect(successPayload).not.toHaveProperty('errorCode');

      const failurePayload = buildPayload(sampleFailureEvent, 'id', DORKOS_VERSION);
      expect(failurePayload.errorCode).toBe('NETWORK_ERROR');
    });

    it('emits no PII fields beyond the documented contract', () => {
      const payload = buildPayload(sampleFailureEvent, 'install-id', DORKOS_VERSION);
      const allowedKeys = new Set([
        'packageName',
        'marketplace',
        'type',
        'outcome',
        'durationMs',
        'errorCode',
        'installId',
        'dorkosVersion',
      ]);
      for (const key of Object.keys(payload)) {
        expect(allowedKeys.has(key)).toBe(true);
      }
    });
  });
});
