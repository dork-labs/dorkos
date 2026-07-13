/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runCloudLogin,
  runCloudLogout,
  runCloudStatus,
  type CloudFlowClient,
  type CommandIO,
  type DeviceCodeResponse,
  type InstanceDescriptor,
  type PollResult,
} from '../cloud-commands.js';
import type { ConfigStore } from '../../config-commands.js';

const DESCRIPTOR: InstanceDescriptor = {
  name: 'kai-mbp',
  platform: 'darwin',
  dorkosVersion: '0.4.2',
};

const CODES: DeviceCodeResponse = {
  device_code: 'dev-123',
  user_code: 'ABCD1234',
  verification_uri: 'https://dorkos.ai/activate',
  verification_uri_complete: 'https://dorkos.ai/activate?user_code=ABCD1234',
  expires_in: 1800,
  interval: 5,
};

/** An in-memory config store over a flat dot-path map. */
function memoryConfigStore(initial: Record<string, unknown> = {}): ConfigStore {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    getAll: () => ({}) as never,
    getDot: (key) => data.get(key) ?? null,
    setDot: (key, value) => {
      data.set(key, value);
      return {};
    },
    reset: () => data.clear(),
    validate: () => ({ valid: true }),
    path: '/tmp/config.json',
  };
}

/** A capturing IO. */
function captureIo(): CommandIO & { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return { log: (m) => logs.push(m), error: (m) => errors.push(m), logs, errors };
}

/** A flow client whose device-token poll resolves to a fixed terminal result. */
function fakeClient(
  overrides: Partial<CloudFlowClient> & { poll?: PollResult } = {}
): CloudFlowClient {
  return {
    resolveCloudBaseUrl: () => 'https://dorkos.ai',
    buildInstanceDescriptor: () => DESCRIPTOR,
    requestDeviceCode: vi.fn(async () => CODES),
    pollForToken: vi.fn(
      async () => overrides.poll ?? { status: 'approved', accessToken: 'dork_inst_live' }
    ),
    sendHeartbeat: vi.fn(async () => ({
      ok: true,
      instanceId: 'inst-1',
      lastSeenAt: '2026-07-03T00:00:00Z',
    })),
    revokeInstanceKey: vi.fn(async () => true),
    ...overrides,
  };
}

describe('runCloudLogin', () => {
  beforeEach(() => vi.clearAllMocks());

  it('saves the token, prints the code + URL, and never opens the browser when non-TTY', async () => {
    const client = fakeClient();
    const configStore = memoryConfigStore();
    const io = captureIo();
    const openUrl = vi.fn();

    const code = await runCloudLogin({ client, configStore, io, openUrl, isTty: false });

    expect(code).toBe(0);
    expect(configStore.getDot('cloud.instanceToken')).toBe('dork_inst_live');
    expect(configStore.getDot('cloud.instanceName')).toBe('kai-mbp');
    // The user code and verification URL are always printed (headless-safe).
    expect(io.logs.join('\n')).toContain('ABCD1234');
    expect(io.logs.join('\n')).toContain('https://dorkos.ai/activate');
    // Non-TTY: never launches a browser.
    expect(openUrl).not.toHaveBeenCalled();
    // Registration heartbeat fired.
    expect(client.sendHeartbeat).toHaveBeenCalledOnce();
  });

  it('resolves the analytics opt-in and passes the id to buildInstanceDescriptor', async () => {
    const buildInstanceDescriptor = vi.fn((telemetryInstanceId?: string) => ({
      ...DESCRIPTOR,
      ...(telemetryInstanceId ? { telemetryInstanceId } : {}),
    }));
    const client = fakeClient({ buildInstanceDescriptor });
    const requestDeviceCode = vi.fn(async () => CODES);
    client.requestDeviceCode = requestDeviceCode;

    await runCloudLogin({
      client,
      configStore: memoryConfigStore(),
      io: captureIo(),
      isTty: false,
      resolveTelemetryInstanceId: async () => 'inst-uuid-cli',
    });

    expect(buildInstanceDescriptor).toHaveBeenCalledWith('inst-uuid-cli');
    // The id rides into the device-code request via the descriptor.
    const descriptor = requestDeviceCode.mock.calls[0][0].descriptor;
    expect(descriptor.telemetryInstanceId).toBe('inst-uuid-cli');
  });

  it('omits the telemetry id when no resolver is provided (default, opt-in off)', async () => {
    const buildInstanceDescriptor = vi.fn(() => DESCRIPTOR);
    const client = fakeClient({ buildInstanceDescriptor });

    await runCloudLogin({
      client,
      configStore: memoryConfigStore(),
      io: captureIo(),
      isTty: false,
    });

    expect(buildInstanceDescriptor).toHaveBeenCalledWith(undefined);
  });

  it('opens the pre-filled URL when attached to a TTY', async () => {
    const client = fakeClient();
    const openUrl = vi.fn();
    await runCloudLogin({
      client,
      configStore: memoryConfigStore(),
      io: captureIo(),
      openUrl,
      isTty: true,
    });
    expect(openUrl).toHaveBeenCalledWith(CODES.verification_uri_complete);
  });

  it('returns 1 and stores no token on denial', async () => {
    const client = fakeClient({ poll: { status: 'denied' } });
    const configStore = memoryConfigStore();
    const io = captureIo();
    const code = await runCloudLogin({ client, configStore, io, isTty: false });
    expect(code).toBe(1);
    expect(configStore.getDot('cloud.instanceToken')).toBeNull();
    expect(io.errors.join('\n')).toMatch(/denied/i);
  });

  it('returns 1 and stores no token on expiry', async () => {
    const client = fakeClient({ poll: { status: 'expired' } });
    const configStore = memoryConfigStore();
    const io = captureIo();
    const code = await runCloudLogin({ client, configStore, io, isTty: false });
    expect(code).toBe(1);
    expect(configStore.getDot('cloud.instanceToken')).toBeNull();
    expect(io.errors.join('\n')).toMatch(/expired/i);
  });
});

describe('runCloudLogout', () => {
  beforeEach(() => vi.clearAllMocks());

  it('best-effort revokes then clears the cloud config fields', async () => {
    const client = fakeClient();
    const configStore = memoryConfigStore({
      'cloud.instanceToken': 'dork_inst_live',
      'cloud.instanceName': 'kai-mbp',
    });
    const io = captureIo();

    const code = await runCloudLogout({ client, configStore, io });

    expect(code).toBe(0);
    expect(client.revokeInstanceKey).toHaveBeenCalledWith({
      baseUrl: 'https://dorkos.ai',
      accessToken: 'dork_inst_live',
    });
    expect(configStore.getDot('cloud.instanceToken')).toBeNull();
    expect(configStore.getDot('cloud.instanceName')).toBeNull();
  });

  it('is a no-op when not linked', async () => {
    const client = fakeClient();
    const io = captureIo();
    const code = await runCloudLogout({ client, configStore: memoryConfigStore(), io });
    expect(code).toBe(0);
    expect(client.revokeInstanceKey).not.toHaveBeenCalled();
    expect(io.logs.join('\n')).toMatch(/not linked/i);
  });
});

describe('runCloudStatus', () => {
  it('prints the linked account label and instance name', () => {
    const io = captureIo();
    const configStore = memoryConfigStore({
      'cloud.instanceToken': 'dork_inst_live',
      'cloud.instanceName': 'kai-mbp',
      'cloud.linkedAccountLabel': 'Kai',
    });
    const code = runCloudStatus({ configStore, io });
    expect(code).toBe(0);
    expect(io.logs.join('\n')).toContain('Kai');
    expect(io.logs.join('\n')).toContain('kai-mbp');
  });

  it('prints "not linked" when there is no token', () => {
    const io = captureIo();
    const code = runCloudStatus({ configStore: memoryConfigStore(), io });
    expect(code).toBe(0);
    expect(io.logs.join('\n')).toMatch(/not linked/i);
  });
});
