import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import type { ConnectorProviderInstanceId } from '@dorkos/shared/connector-provider';

import { env as flags } from '../../env.js';
import { initConfigManager } from '../../services/core/config-manager.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import { createTestDb } from '@dorkos/test-utils/db';
import { ConnectorRegistry } from '../../services/connectors/registry.js';
const originalFlags = {
  DORKOS_TEST_RUNTIME: flags.DORKOS_TEST_RUNTIME,
  DORKOS_REPLAY_RECORDING: flags.DORKOS_REPLAY_RECORDING,
  DORKOS_CLOUD_URL: flags.DORKOS_CLOUD_URL,
  DORKOS_CLOUD_API_URL: flags.DORKOS_CLOUD_API_URL,
};
// The only replaced modules are SDK boundaries. All app services remain real.
const constructed = vi.hoisted(() => ({
  model: vi.fn(() => {
    throw new Error('A model client was constructed');
  }),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  query: constructed.model,
}));
vi.mock('@openai/codex-sdk', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  Codex: class {
    constructor() {
      constructed.model();
    }
  },
}));
vi.mock('@opencode-ai/sdk', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createOpencode: constructed.model,
  createOpencodeClient: constructed.model,
}));
import { registerRuntimes } from '../runtimes.js';
import { startRelayAdapters } from '../relay-adapters.js';
import { relayStartsEnabled } from '../../services/relay/relay-state.js';
import { getCloudLinkManager } from '../../services/core/auth/cloud-link.js';
import { captureCloudV1Context } from '../../services/core/cloud/v1-client.js';
import { TunnelManager } from '../../services/core/tunnel-manager.js';
import { ConnectorProviderBootstrapper } from '../../services/connectors/bootstrap.js';
import {
  claimReplayIsolation,
  isReplayIsolated,
  REPLAY_HOME_MARKER,
} from '../../lib/replay/isolation.js';
import { TestModeRuntime } from '../../services/runtimes/test-mode/test-mode-runtime.js';

let home: string;
let db: ReturnType<typeof createTestDb>;
let fetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-replay-boot-'));
  vi.stubEnv('DORK_HOME', home);
  fs.writeFileSync(path.join(home, REPLAY_HOME_MARKER), 'demo-boot v1');
  fs.writeFileSync(
    path.join(home, 'reply.json'),
    JSON.stringify({
      version: 1,
      title: 'Sample',
      turns: [{ events: [{ type: 'text_delta', data: { text: 'Sample reply' } }] }],
    })
  );
  const settings = structuredClone(USER_CONFIG_DEFAULTS);
  Object.assign(settings, {
    relay: { ...settings.relay, enabled: true },
    tunnel: { ...settings.tunnel, enabled: true },
    cloud: { ...settings.cloud, instanceToken: 'made-up-demo-token' },
    runtimes: {
      ...settings.runtimes,
      codex: { enabled: true },
      opencode: { enabled: true },
      doe: { enabled: true },
    },
  });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(settings));
  initConfigManager(home);
  db = createTestDb();
  runtimeRegistry.setDb(db);
  flags.DORKOS_TEST_RUNTIME = true;
  flags.DORKOS_REPLAY_RECORDING = 'reply.json';
  flags.DORKOS_CLOUD_URL = 'https://cloud.example.invalid';
  flags.DORKOS_CLOUD_API_URL = 'https://cloud.example.invalid';
  fetch = vi.fn(() => {
    throw new Error('Network must not be reached');
  });
  vi.stubGlobal('fetch', fetch);
});
afterEach(() => {
  getCloudLinkManager().stop();
  Object.assign(flags, originalFlags);
  db.$client.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});
const deps = () => ({ db, dorkHome: home, currentCreditsRelay: () => null });

describe('recorded demo boot with seeded outside services enabled', () => {
  it('constructs only test-mode instances and never constructs a model client', async () => {
    const result = await registerRuntimes(deps());
    expect(runtimeRegistry.listRuntimes().map((runtime) => runtime.type)).toEqual([
      'test-mode',
      'claude-code',
      'codex',
    ]);
    expect(
      runtimeRegistry.listRuntimes().every((runtime) => runtime instanceof TestModeRuntime)
    ).toBe(true);
    expect(result.claudeRuntime).toBeNull();
    expect(result.doeRuntime).toBeNull();
    expect(result.creditsRelay).toBeNull();
    expect(constructed.model).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps relay and its chat-app connections off despite the config and env override', async () => {
    await registerRuntimes(deps());
    expect(relayStartsEnabled(undefined, true)).toBe(false);
    expect(relayStartsEnabled(true, true)).toBe(false);
    expect(await startRelayAdapters({ relayEnabled: true } as never)).toBeUndefined();
  });
  it('never constructs connection clients, reads keys, or registers raw MCP servers', async () => {
    await registerRuntimes(deps());
    const create = vi.fn(() => {
      throw new Error('Connection client constructed');
    });
    const resolve = vi.fn(async (_ref: string) => ({ ok: true as const, secret: 'made-up-key' }));
    const registry = new ConnectorRegistry({ db });
    const bootstrap = new ConnectorProviderBootstrapper({
      registry,
      credentials: { resolve },
      nangoEnv: () => ({ baseUrl: 'https://sample.invalid' }),
      rawMcpServers: () => [
        {
          slug: 'sample',
          displayName: 'Sample',
          connection: { transport: 'http', url: 'https://sample.invalid/mcp' },
        },
      ],
      rawMcpPendingConnect: () => undefined,
      makeComposioClient: create,
      makeNangoClient: create,
      managedCloud: {
        instanceId: 'sample-cloud' as ConnectorProviderInstanceId,
        configured: () => true,
        executionConfigDigest: () => 'sample',
        create,
      },
    });
    try {
      await bootstrap.registerBootProviders();
      await bootstrap.reloadManagedCloud();
      await bootstrap.recoverManagedCloud();
      expect(create).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
      expect(registry.listProviders()).toEqual([]);
    } finally {
      bootstrap.stop();
    }
  });
  it('blocks Cloud link and v1 requests even with a seeded instance token', async () => {
    await registerRuntimes(deps());
    const manager = getCloudLinkManager();
    await manager.initOnStartup();
    await expect(manager.startLink()).rejects.toThrow();
    const context = captureCloudV1Context();
    expect(context).not.toBeNull();
    await expect(context!.client.get('/v1/session', z.unknown())).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('refuses both kinds of tunnel and subsequent host changes before ngrok is called', async () => {
    await registerRuntimes(deps());
    const manager = new TunnelManager();
    expect(() => manager.start({ port: 4644 })).toThrow('outside actions');
    expect(() => manager.startManaged({} as never)).toThrow('outside actions');
    expect(() => manager.applyHosts(['sample.invalid'])).toThrow('outside actions');
    expect(manager.status.connected).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('refuses replay at registration when test mode is off', async () => {
    await registerRuntimes(deps());
    flags.DORKOS_TEST_RUNTIME = false;
    await expect(registerRuntimes(deps())).rejects.toThrow('test runtime');
    expect(constructed.model).not.toHaveBeenCalled();
  });
  it('latches isolation after flags and marker are removed', async () => {
    await registerRuntimes(deps());
    fs.unlinkSync(path.join(home, REPLAY_HOME_MARKER));
    flags.DORKOS_REPLAY_RECORDING = undefined;
    expect(isReplayIsolated()).toBe(true);
    expect(claimReplayIsolation(home)).toBe(true);
    expect(relayStartsEnabled(true, true)).toBe(false);
    await expect(registerRuntimes(deps())).rejects.toThrow('recording');
  });
});
