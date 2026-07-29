import { beforeEach, describe, expect, it } from 'vitest';
import { connectorConformance } from '@dorkos/test-utils';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import type { ConnectedAccountId } from '@dorkos/shared/connector-provider';
import type {
  CredentialProvider,
  CredentialResolution,
} from '../../../core/credential-provider.js';
import { ConnectorRegistry } from '../../registry.js';
import {
  ConnectorProviderBootstrapper,
  TEST_CONNECTOR_API_KEY_REF,
  TEST_CONNECTOR_PROVIDER_TYPE,
} from '../../bootstrap.js';
import { maybeCreateTestModeConnectorProvider, TestModeConnectorProvider } from '../test-mode.js';

const LOCAL_ORIGIN = 'http://127.0.0.1:4243';

function makeProvider(): TestModeConnectorProvider {
  return new TestModeConnectorProvider({ localOrigin: LOCAL_ORIGIN });
}

/** A mutable credential fake: `store` writes stand in for the credential routes. */
function fakeCredentials(store: Map<string, string>): CredentialProvider {
  return {
    resolve(ref: string): Promise<CredentialResolution> {
      const secret = store.get(ref);
      if (secret === undefined) {
        return Promise.resolve({ ok: false, reason: 'unresolved', ref, message: 'absent' });
      }
      return Promise.resolve({ ok: true, secret });
    },
  };
}

// The scripted e2e backend clears the same behavioral gate every real backend
// does (task E1 acceptance). Multi-account, so the two-distinct-ids branch runs;
// the null branch is arranged by expiring a connected account.
connectorConformance(makeProvider, {
  name: 'TestModeConnectorProvider — conformance',
  toolkit: 'gmail',
  makeUnexposableAccount: async () => {
    const provider = makeProvider();
    const { flowId } = await provider.startConnect('gmail');
    const { account } = await provider.pollConnect(flowId);
    provider.setStatus(account!.id, 'expired');
    return { provider, accountId: account!.id };
  },
});

describe('TestModeConnectorProvider — scripted semantics', () => {
  it('declares the managed, multi-account, MCP-exposing capability shape', () => {
    const caps = makeProvider().getCapabilities();
    expect(caps).toMatchObject({
      type: TEST_CONNECTOR_PROVIDER_TYPE,
      supportsMultiAccount: true,
      custody: 'managed',
      exposesOverMcp: true,
    });
  });

  it('lists the scripted gmail + slack toolkits', async () => {
    const toolkits = await makeProvider().listToolkits();
    expect(toolkits.map((tk) => tk.slug)).toEqual(['gmail', 'slack']);
  });

  it('points the authorize URL at the local no-op page — everything stays on-machine', async () => {
    const provider = makeProvider();
    const start = await provider.startConnect('gmail', { label: 'work' });
    expect(start.authorizeUrl).toBe(
      `${LOCAL_ORIGIN}/api/test/connect-approved?flow=${start.flowId}`
    );
  });

  it('connects instantly with the given label, stable across re-polls', async () => {
    const provider = makeProvider();
    const { flowId } = await provider.startConnect('gmail', { label: 'work' });

    const first = await provider.pollConnect(flowId);
    expect(first.status).toBe('connected');
    expect(first.account).toMatchObject({ toolkit: 'gmail', label: 'work', status: 'active' });

    const second = await provider.pollConnect(flowId);
    expect(second.account?.id).toBe(first.account?.id);
  });

  it('exposes an active account as a stub http tool server on the local origin', async () => {
    const provider = makeProvider();
    const { flowId } = await provider.startConnect('slack', { label: 'team' });
    const { account } = await provider.pollConnect(flowId);

    const connection = await provider.toolServerForAccount(account!.id);
    expect(connection).toMatchObject({ transport: 'http' });
    expect((connection as { url: string }).url.startsWith(`${LOCAL_ORIGIN}/`)).toBe(true);
  });

  it('resolves null for an unknown account id — never a throw', async () => {
    await expect(
      makeProvider().toolServerForAccount('never-connected' as ConnectedAccountId)
    ).resolves.toBeNull();
  });
});

describe('maybeCreateTestModeConnectorProvider — the credential gate', () => {
  let db: Db;
  let registry: ConnectorRegistry;
  let secrets: Map<string, string>;
  let bootstrapper: ConnectorProviderBootstrapper;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    registry = new ConnectorRegistry({ db });
    secrets = new Map();
    const credentials = fakeCredentials(secrets);
    // The exact wiring index.ts uses under DORKOS_TEST_RUNTIME: the bootstrapper's
    // test-connector spec runs this factory on boot and on every credential reload.
    bootstrapper = new ConnectorProviderBootstrapper({
      registry,
      credentials,
      nangoEnv: () => ({}),
      // Nango is never configured in these tests; a throwing stub keeps the
      // real NangoProxyMcp (and its module graph) out of this file.
      nangoProxy: {} as never,
      rawMcpServers: () => [],
      testConnector: {
        create: () =>
          maybeCreateTestModeConnectorProvider({ credentials, localOrigin: LOCAL_ORIGIN }),
      },
    });
  });

  it('resolves null while no key is saved', async () => {
    await expect(
      maybeCreateTestModeConnectorProvider({
        credentials: fakeCredentials(new Map()),
        localOrigin: LOCAL_ORIGIN,
      })
    ).resolves.toBeNull();
  });

  it('is absent after boot without a key — configured:false, registered:false', async () => {
    await bootstrapper.registerBootProviders();
    expect(registry.resolveProvider(TEST_CONNECTOR_PROVIDER_TYPE)).toBeUndefined();

    const status = (await bootstrapper.listStatuses()).find(
      (s) => s.type === TEST_CONNECTOR_PROVIDER_TYPE
    )!;
    expect(status).toMatchObject({ configured: false, registered: false, custody: 'managed' });
  });

  it('registers live on key save + reload, and unregisters on delete + reload', async () => {
    await bootstrapper.registerBootProviders();

    // The credential route's write: store the key, then reload the provider.
    secrets.set(TEST_CONNECTOR_API_KEY_REF, 'test-key');
    const saved = await bootstrapper.reload(TEST_CONNECTOR_PROVIDER_TYPE);
    expect(saved).toMatchObject({ configured: true, registered: true });
    expect(registry.resolveProvider(TEST_CONNECTOR_PROVIDER_TYPE)).toBeInstanceOf(
      TestModeConnectorProvider
    );

    // The delete path: key gone, provider unregistered — no restart anywhere.
    secrets.delete(TEST_CONNECTOR_API_KEY_REF);
    const deleted = await bootstrapper.reload(TEST_CONNECTOR_PROVIDER_TYPE);
    expect(deleted).toMatchObject({ configured: false, registered: false });
    expect(registry.resolveProvider(TEST_CONNECTOR_PROVIDER_TYPE)).toBeUndefined();
  });

  it('is entirely absent without the test-mode seam — the production bootstrapper refuses the type', async () => {
    const production = new ConnectorProviderBootstrapper({
      registry,
      credentials: fakeCredentials(secrets),
      nangoEnv: () => ({}),
      nangoProxy: {} as never,
      rawMcpServers: () => [],
    });
    await production.registerBootProviders();

    // The credential routes validate via credentialNameFor — undefined = 400.
    expect(production.credentialNameFor(TEST_CONNECTOR_PROVIDER_TYPE)).toBeUndefined();
    await expect(production.reload(TEST_CONNECTOR_PROVIDER_TYPE)).rejects.toThrow(
      /Unknown connector provider/
    );
  });
});
