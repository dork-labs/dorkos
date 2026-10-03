import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  BrowserValidationError,
  advanceCounter,
  parseBrowserCommand,
  parseBrowserResult,
  parseBrowserId,
  parseProfileId,
  parseTabId,
  parseRuntimeDescriptor,
  validateEngineConfiguration,
  type BrowserId,
} from '../index.js';

const profileId = 'profile_0123456789abcdef0123456789ab';
const browserId = 'browser_0123456789abcdef0123456789ab';
const tabId = 'tab_0123456789abcdef0123456789abcdef';
const requestId = 'request_0123456789abcdef0123456789ab';
const binding = {
  browserId,
  browserGeneration: 0,
  tabId,
  navigationGeneration: 0,
  viewportVersion: 0,
  epoch: 0,
  inputGeneration: 0,
};
const runtime = {
  library: {
    package: 'playwright-core',
    version: '1.63.0',
    rootDir: '/private/fake-library',
    assets: { manifest: 'browsers.json', cli: 'cli.js' },
  },
  executable: {
    path: '/private/fake-chromium',
    sha256: 'a'.repeat(64),
    revision: '1243',
    version: '153.0.8010.12',
    platform: 'darwin',
    arch: 'arm64',
  },
  identity: { mode: 'native', policyRevision: 0 },
};
function configuration() {
  return {
    dataDir: '/private/fake-browser-data',
    runtime,
    network: { kind: 'fixture' as const, origin: 'http://127.0.0.1:9000' },
    clock: { monotonicNow: () => 10, wallNow: () => 1_000 },
    processes: {
      observe: async () => ({ status: 'unknown' as const }),
      descendants: async () => ({ status: 'unknown' as const, identities: [] }),
    },
    policy: {
      authorizeAction: async () => 'refused' as const,
      verifyBrokerLease: async () => 'unknown' as const,
    },
  };
}

describe('browser engine contract foundation', () => {
  it('preserves separate opaque IDs and exact safe generation counters', () => {
    expect(parseProfileId(profileId)).toBe(profileId);
    expect(parseBrowserId(browserId)).toBe(browserId);
    expect(parseTabId(tabId)).toBe(tabId);
    expectTypeOf(parseProfileId(profileId)).not.toEqualTypeOf<BrowserId>();
    expect(advanceCounter(0)).toBe(1);
    expect(advanceCounter(Number.MAX_SAFE_INTEGER - 1)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => advanceCounter(Number.MAX_SAFE_INTEGER)).toThrowError(
      expect.objectContaining({ code: 'COUNTER_EXHAUSTED' })
    );
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(() => advanceCounter(value)).toThrow(BrowserValidationError);
  });

  it('accepts fictitious retained and clean commands without paths or authority in their bodies', () => {
    expect(parseBrowserCommand({ kind: 'open', requestId, mode: 'persistent', profileId })).toEqual(
      { kind: 'open', requestId, mode: 'persistent', profileId }
    );
    expect(parseBrowserCommand({ kind: 'open', requestId, mode: 'ephemeral' })).toEqual({
      kind: 'open',
      requestId,
      mode: 'ephemeral',
    });
    expect(() =>
      parseBrowserCommand({ kind: 'open', requestId, mode: 'ephemeral', profileId })
    ).toThrow(BrowserValidationError);
    for (const field of ['profilePath', 'actorId', 'page', 'cdp', 'selector', 'evaluate']) {
      expect(() =>
        parseBrowserCommand({
          kind: 'open',
          requestId,
          mode: 'persistent',
          profileId,
          [field]: '/private/operator-secret',
        })
      ).toThrow(BrowserValidationError);
    }
  });

  it('rejects malformed bounded input and stale-identity shapes instead of stripping extra fields', () => {
    const command = {
      kind: 'input',
      requestId,
      binding,
      steps: [{ kind: 'text', text: 'fake 😀' }],
    };
    expect(parseBrowserCommand(command)).toEqual(command);
    const changes = [
      { binding: { ...binding, epoch: -1 } },
      { binding: { ...binding, navigationGeneration: NaN } },
      { binding: { ...binding, tabId: '' } },
      { steps: new Array(1) },
      { steps: [{ kind: 'text', text: '😀'.repeat(2049) }] },
      { steps: [{ kind: 'click', x: Infinity, y: 0, button: 'left' }] },
      { steps: [{ kind: 'evaluate', source: 'arbitrary' }] },
      { steps: [] },
    ];
    expect(changes).toHaveLength(8);
    for (const change of changes)
      expect(() => parseBrowserCommand({ ...command, ...change })).toThrow(BrowserValidationError);
    let reads = 0;
    const steps: unknown[] = [];
    Object.defineProperty(steps, '0', {
      get() {
        reads++;
        return { kind: 'text', text: 'fake' };
      },
      enumerable: true,
    });
    expect(() => parseBrowserCommand({ ...command, steps })).toThrow(BrowserValidationError);
    expect(reads).toBe(0);
  });

  it('validates attributed outcomes and bounded captures without page payloads or error echoes', () => {
    const opened = {
      kind: 'opened',
      requestId,
      browserId,
      browserGeneration: 0,
      tab: binding,
      mode: 'persistent',
      profileId,
    };
    expect(parseBrowserResult(opened)).toEqual(opened);
    expect(() =>
      parseBrowserResult({ ...opened, browserId: 'other_0123456789abcdef0123456789abcd' })
    ).toThrow(BrowserValidationError);
    expect(() => parseBrowserResult({ ...opened, mode: 'ephemeral' })).toThrow(
      BrowserValidationError
    );
    expect(
      parseBrowserResult({
        kind: 'close',
        requestId,
        browserId,
        browserGeneration: 0,
        cleanup: 'observed',
      })
    ).toEqual({ kind: 'close', requestId, browserId, browserGeneration: 0, cleanup: 'observed' });
    expect(() =>
      parseBrowserResult({
        kind: 'close',
        requestId,
        browserId,
        browserGeneration: 0,
        cleanup: 'unverified',
      })
    ).toThrow(BrowserValidationError);
    const result = { kind: 'action', requestId, binding, outcome: 'completed' };
    expect(parseBrowserResult(result)).toEqual(result);
    expect(() => parseBrowserResult({ ...result, reason: 'deadline' })).toThrow(
      BrowserValidationError
    );
    expect(() => parseBrowserResult({ ...result, outcome: 'uncertain' })).toThrow(
      BrowserValidationError
    );
    expect(parseBrowserResult({ ...result, outcome: 'uncertain', reason: 'responseLost' })).toEqual(
      expect.objectContaining({ outcome: 'uncertain' })
    );
    const frame = {
      kind: 'frame',
      binding,
      captureSequence: 1,
      rasterWidth: 1280,
      rasterHeight: 720,
      pointer: { x: 0, y: 0, revision: 1 },
      width: 1280,
      height: 720,
      byteLength: 2 * 1024 * 1024,
      format: 'jpeg',
    };
    expect(parseBrowserResult(frame)).toEqual(frame);
    for (const invalid of [
      { ...frame, rasterWidth: 0 },
      { ...frame, rasterWidth: 16384, rasterHeight: 16384 },
      { ...frame, pointer: { x: 1280, y: 0, revision: 1 } },
      { ...frame, pointer: { x: 0, y: 720, revision: 1 } },
    ])
      expect(() => parseBrowserResult(invalid)).toThrow(BrowserValidationError);
    expect(() => parseBrowserResult({ ...frame, byteLength: frame.byteLength + 1 })).toThrow(
      BrowserValidationError
    );
    try {
      parseBrowserCommand({ secret: 'private-input-value' });
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserValidationError);
      expect(String(error)).not.toContain('private-input-value');
    }
  });

  it('requires injected configuration without reading roots, calling hooks or claiming installation', () => {
    let calls = 0;
    const config = configuration();
    config.clock.monotonicNow = () => {
      calls++;
      return 1;
    };
    Object.assign(config.clock.monotonicNow, {
      toJSON: () => {
        calls++;
        return 'unexpected';
      },
    });
    const validated = validateEngineConfiguration(config);
    expect(validated.dataDir).toBe('/private/fake-browser-data');
    expect(validated.clock.monotonicNow).toBe(config.clock.monotonicNow);
    expect(calls).toBe(0);
    for (const dataDir of ['', '.', '~/browser', '/private/bad\0root'])
      expect(() => validateEngineConfiguration({ ...config, dataDir })).toThrow(
        BrowserValidationError
      );
    expect(() =>
      validateEngineConfiguration({ ...config, clock: { ...config.clock, wallNow: 3 } })
    ).toThrow(BrowserValidationError);
    expect(() => validateEngineConfiguration({ ...config, processes: {} })).toThrow(
      BrowserValidationError
    );
    expect(() =>
      validateEngineConfiguration({
        ...config,
        policy: { ...config.policy, verifyBrokerLease: false },
      })
    ).toThrow(BrowserValidationError);
    expect(() => validateEngineConfiguration({ ...config, installed: true })).toThrow(
      BrowserValidationError
    );
    for (const origin of [
      'http://localhost:4242',
      'http://127.0.0.1:9000/path',
      'https://example.test',
      'http://127.0.0.1:9000/?token=fake',
    ]) {
      expect(() =>
        validateEngineConfiguration({ ...config, network: { kind: 'fixture', origin } })
      ).toThrow(BrowserValidationError);
    }
  });

  it('pins public library provenance and relative assets without asserting file existence', () => {
    expect(parseRuntimeDescriptor(runtime)).toEqual(runtime);
    const invalid = [
      { library: { ...runtime.library, version: '1.62.0' } },
      { library: { ...runtime.library, package: 'private-patched-playwright' } },
      { library: { ...runtime.library, assets: { manifest: '../browsers.json', cli: 'cli.js' } } },
      { executable: { ...runtime.executable, sha256: 'invalid' } },
      { executable: { ...runtime.executable, path: './chromium' } },
      { identity: { ...runtime.identity, mode: 'anything' } },
      { ready: true },
    ];
    expect(invalid).toHaveLength(7);
    for (const change of invalid)
      expect(() => parseRuntimeDescriptor({ ...runtime, ...change })).toThrow(
        BrowserValidationError
      );
  });
});
