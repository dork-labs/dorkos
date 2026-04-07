/**
 * End-to-end privacy assertion for the marketplace telemetry pipeline.
 *
 * This test exercises the full client-side path from
 * {@link reportInstallEvent} through the registered
 * {@link registerDorkosCommunityTelemetry} reporter, captures the exact
 * `fetch` call that goes to dorkos.ai, and asserts two complementary
 * privacy guarantees:
 *
 * 1. **Allow-list enforcement** — the JSON body has ONLY keys from the
 *    documented contract. Any future change that adds a new field to the
 *    payload (intentional or accidental) must update this test.
 *
 * 2. **No PII** — the raw body string does NOT contain runtime values that
 *    are commonly leaked by environment introspection (`os.hostname()`,
 *    `os.userInfo().username`, `process.cwd()`). The values are read at
 *    test time, so any future change that pulls them into the payload —
 *    even indirectly via a stack trace or path — fails this test.
 *
 * Plus the opt-out path: when `consent === false`, the reporter is never
 * registered and zero `fetch` calls are made.
 *
 * The schema-side counterpart lives at
 * `apps/site/src/db/__tests__/schema.test.ts` and the receive-side
 * counterpart at `apps/site/src/app/api/telemetry/install/__tests__/route.test.ts`.
 * Together the three tests form defense in depth around the privacy
 * contract documented in `contributing/marketplace-telemetry.md`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';

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
import { registerDorkosCommunityTelemetry } from '../telemetry-reporter.js';

const DORK_HOME = '/tmp/test-dork-home-privacy';
const DORKOS_VERSION = '9.9.9-privacy-test';

const ALLOWED_PAYLOAD_KEYS = [
  'packageName',
  'marketplace',
  'type',
  'outcome',
  'durationMs',
  'errorCode',
  'installId',
  'dorkosVersion',
] as const;

const sampleEvent: InstallEvent = {
  packageName: 'code-reviewer',
  marketplace: 'dorkos-community',
  type: 'agent',
  outcome: 'failure',
  durationMs: 4321,
  errorCode: 'NETWORK_ERROR',
};

describe('telemetry-privacy (end-to-end)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    _resetTelemetryReporter();
    mockReadFile.mockReset();
    mockWriteFile.mockReset();
    mockMkdir.mockReset();
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    // First call: file missing, so a fresh UUID is generated and written.
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
  });

  it('only sends allow-listed keys in the JSON body', async () => {
    registerDorkosCommunityTelemetry(true, DORK_HOME, DORKOS_VERSION);
    await reportInstallEvent(sampleEvent);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;

    const allowed = new Set<string>(ALLOWED_PAYLOAD_KEYS);
    for (const key of Object.keys(body)) {
      expect(allowed.has(key)).toBe(true);
    }
    // Sanity: the contract fields we always expect on a failure event.
    expect(body).toMatchObject({
      packageName: sampleEvent.packageName,
      marketplace: sampleEvent.marketplace,
      type: sampleEvent.type,
      outcome: sampleEvent.outcome,
      durationMs: sampleEvent.durationMs,
      errorCode: sampleEvent.errorCode,
      dorkosVersion: DORKOS_VERSION,
    });
  });

  it('never includes runtime PII (hostname, username, cwd) in the body', async () => {
    // Pull the actual environment values at test time. If the reporter ever
    // starts copying them into the payload — directly or via a stack trace —
    // these assertions will fail.
    const hostname = os.hostname();
    const username = os.userInfo().username;
    const cwd = process.cwd();

    registerDorkosCommunityTelemetry(true, DORK_HOME, DORKOS_VERSION);
    await reportInstallEvent(sampleEvent);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const bodyString = init.body as string;

    expect(bodyString).not.toContain(hostname);
    expect(bodyString).not.toContain(username);
    expect(bodyString).not.toContain(cwd);
    // Path-shaped strings (absolute Unix paths) must not appear at all —
    // a defensive guard against any future field that serializes a file
    // path. We exclude the test-only DORK_HOME marker because it is the
    // dorkHome argument the test itself passed in and is never embedded
    // in the payload by the reporter.
    expect(bodyString).not.toMatch(/"\/(?:Users|home|var|etc|opt|tmp\/(?!test-dork-home-privacy))/);
  });

  it('makes zero fetch calls when consent is false', async () => {
    registerDorkosCommunityTelemetry(false, DORK_HOME, DORKOS_VERSION);
    await reportInstallEvent(sampleEvent);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});
