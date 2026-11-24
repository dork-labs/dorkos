/**
 * Tests for the dorkos.ai marketplace telemetry reporter.
 *
 * Mocks `node:fs/promises` (so install-id reads/writes never touch disk) and
 * `global.fetch` (so we can assert the wire-format payload). Each test starts
 * from a clean reporter slot via `_resetTelemetryReporter()`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { InstallTelemetryEventSchema } from '@dorkos/shared/marketplace-install-telemetry';

import {
  _resetTelemetryReporter,
  reportInstallEvent,
  type InstallEvent,
} from '../telemetry-hook.js';
import { buildPayload, registerDorkosCommunityTelemetry } from '../telemetry-reporter.js';

const DORK_HOME = '/tmp/test-dork-home';
const TELEMETRY_ENDPOINT = 'https://dorkos.ai/api/telemetry/install';
const DORKOS_VERSION = '1.2.3';

const sampleEvent: InstallEvent = {
  packageName: 'code-reviewer',
  marketplace: 'dorkos-community',
  type: 'agent',
  outcome: 'success',
  durationMs: 4321,
  sourceType: 'relative-path',
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
        sourceType: 'relative-path',
      });
      expect(typeof body.installId).toBe('string');
      expect((body.installId as string).length).toBeGreaterThan(0);
    });

    // The contract with the site (DOR-4988): the body the reporter really POSTs
    // must pass the very schema `/api/telemetry/install` validates with, or
    // every event is a 400 and nothing is counted.
    it.each([
      ['a success', sampleEvent],
      ['a failure', sampleFailureEvent],
    ])('sends %s body the site route accepts', async (_label, event) => {
      mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      registerDorkosCommunityTelemetry(true, DORK_HOME, DORKOS_VERSION);
      await reportInstallEvent(event);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const parsed = InstallTelemetryEventSchema.safeParse(JSON.parse(init.body as string));
      expect(parsed.error?.issues).toBeUndefined();
      expect(parsed.success).toBe(true);
    });
  });

  describe('buildPayload', () => {
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
        'sourceType',
      ]);
      for (const key of Object.keys(payload)) {
        expect(allowedKeys.has(key)).toBe(true);
      }
    });
  });
});
