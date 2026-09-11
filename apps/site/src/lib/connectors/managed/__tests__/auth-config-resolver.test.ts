/** @vitest-environment node */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@/db/schema';
import type { ManagedConnectorDatabase } from '../authority-service';
import {
  resolveManagedAuthenticationConfiguration,
  type ManagedAuthenticationConfigurationClient,
} from '../auth-config-resolver';
import {
  normalizeComposioAuthenticationConfiguration,
  type ComposioAuthenticationConfiguration,
  type ComposioToolkitAuthentication,
} from '@dorkos/connector-providers/composio';

const migration = readFileSync(
  fileURLToPath(new URL('../../../../../drizzle/0016_stale_dazzler.sql', import.meta.url)),
  'utf8'
);
const signal = () => new AbortController().signal;
function fakeClient() {
  let stored: ComposioAuthenticationConfiguration | undefined;
  const client = {
    authConfigProjectDigest: 'project-a',
    getToolkitAuthentication: vi.fn(
      async (toolkit: string): Promise<ComposioToolkitAuthentication> => ({
        toolkit,
        enabled: true,
        managedOAuth2: true,
        managedScopes: ['read', 'write'],
        managedUserScopes: [],
        methods: [],
      })
    ),
    getAuthenticationConfiguration: vi.fn(async (id: string) => {
      if (!stored || stored.id !== id) throw new Error('missing');
      return stored;
    }),
    listAuthenticationConfigurations: vi.fn<
      (input: { name: string }) => Promise<{ items: ComposioAuthenticationConfiguration[] }>
    >(async () => ({
      items: stored ? [stored] : [],
    })),
    createAuthenticationConfiguration: vi.fn(
      async (input: { name: string; descriptor: { toolkit: string; scheme: string } }) => {
        stored = {
          id: 'ac_auto',
          name: input.name,
          toolkit: input.descriptor.toolkit,
          scheme: input.descriptor.scheme,
          enabled: true,
          managed: input.descriptor.scheme === 'OAUTH2',
          policy: {
            type: input.descriptor.scheme === 'OAUTH2' ? 'default' : 'custom',
            scopes: [],
            userScopes: [],
            credentialsEmpty: true,
            routerEnabled: false,
          },
        };
        return { id: stored.id };
      }
    ),
  };
  return {
    client,
    setStored: (value: ComposioAuthenticationConfiguration | undefined) => {
      stored = value;
    },
  };
}

describe('durable default authentication configuration', () => {
  let client: PGlite;
  let db: ManagedConnectorDatabase;
  beforeEach(async () => {
    client = new PGlite();
    await client.exec(
      "CREATE TABLE managed_connector_auth_flow (id text PRIMARY KEY); INSERT INTO managed_connector_auth_flow VALUES ('old-oauth-flow');"
    );
    await client.exec(migration);
    db = drizzle(client, { schema }) as unknown as ManagedConnectorDatabase;
  });
  afterEach(async () => {
    await client.close();
  });
  const resolve = (accounts: ManagedAuthenticationConfigurationClient, toolkit = 'gmail') =>
    resolveManagedAuthenticationConfiguration({ db, accounts, toolkit, signal: signal() });

  it('appends migration defaults without relabeling or deleting an existing OAuth flow', async () => {
    const result = await client.query('SELECT * FROM managed_connector_auth_flow');
    expect(result.rows).toEqual([
      {
        id: 'old-oauth-flow',
        completion_kind: 'oauth',
        authentication_descriptor: null,
        authentication_descriptor_digest: null,
      },
    ]);
  });
  it('reuses a ready exact config and never creates again on normal refresh', async () => {
    const { client: accounts } = fakeClient();
    const first = await resolve(accounts);
    expect(await resolve(accounts)).toEqual(first);
    expect(accounts.createAuthenticationConfiguration).toHaveBeenCalledTimes(1);
    expect((await db.select().from(schema.managedConnectorAuthConfigResolution))[0].state).toBe(
      'ready'
    );
  });
  it('gives one concurrent claimant the sole create while another call stays closed', async () => {
    const { client: accounts } = fakeClient();
    const create = accounts.createAuthenticationConfiguration.getMockImplementation()!;
    let enter!: () => void;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    accounts.createAuthenticationConfiguration.mockImplementation(async (input) => {
      enter();
      await gate;
      return create(input);
    });
    const first = resolve(accounts);
    await Promise.race([
      entered,
      first.then(() => {
        throw new Error('Resolver completed without entering create');
      }),
    ]);
    await expect(resolve(accounts)).rejects.toThrow('Account setup could not be confirmed');
    expect(accounts.createAuthenticationConfiguration).toHaveBeenCalledTimes(1);
    release();
    await expect(first).resolves.toMatchObject({ authConfigId: 'ac_auto' });
  });
  it('reconciles a lost create response by exact reads only', async () => {
    const { client: accounts } = fakeClient();
    const create = accounts.createAuthenticationConfiguration.getMockImplementation()!;
    accounts.createAuthenticationConfiguration.mockImplementationOnce(async (input) => {
      await create(input);
      throw new Error('lost response');
    });
    await expect(resolve(accounts)).rejects.toThrow();
    expect((await db.select().from(schema.managedConnectorAuthConfigResolution))[0].state).toBe(
      'create_unknown'
    );
    await expect(resolve(accounts)).resolves.toMatchObject({ authConfigId: 'ac_auto' });
    expect(accounts.createAuthenticationConfiguration).toHaveBeenCalledTimes(1);
  });
  it('reconciles a recorded configuration after a failed read without creating again', async () => {
    const { client: accounts, setStored } = fakeClient();
    accounts.getAuthenticationConfiguration.mockRejectedValueOnce(new Error('PRIVATE_SENTINEL'));
    await expect(resolve(accounts)).rejects.toMatchObject({ reason: 'retrieve_failed' });
    const [unknown] = await db.select().from(schema.managedConnectorAuthConfigResolution);
    expect(unknown).toMatchObject({ state: 'create_unknown', authConfigId: 'ac_auto' });
    setStored(
      normalizeComposioAuthenticationConfiguration({
        id: 'ac_auto',
        name: unknown.name,
        toolkit: { slug: 'gmail' },
        status: 'ENABLED',
        auth_scheme: 'OAUTH2',
        is_composio_managed: true,
        type: 'default',
        is_enabled_for_tool_router: false,
        is_connection_revoke_supported: true,
        credentials: {
          client_id: 'synthetic',
          client_secret: 'PRIVATE_SENTINEL',
          oauth_redirect_uri: 'https://backend.composio.dev/api/v1/auth-apps/add',
          scopes: ['read'],
        },
        shared_credentials: {},
        tool_access_config: {},
      })
    );
    await expect(resolve(accounts)).resolves.toMatchObject({ authConfigId: 'ac_auto' });
    expect(accounts.createAuthenticationConfiguration).toHaveBeenCalledTimes(1);
    expect(accounts.getAuthenticationConfiguration).toHaveBeenCalledTimes(2);
  });
  it('refuses a replacement candidate when the unknown attempt already recorded another ID', async () => {
    const { client: accounts } = fakeClient();
    accounts.getAuthenticationConfiguration.mockRejectedValueOnce(new Error('lost read'));
    await expect(resolve(accounts)).rejects.toThrow();
    const original = await accounts.getAuthenticationConfiguration('ac_auto');
    accounts.listAuthenticationConfigurations.mockResolvedValue({
      items: [{ ...original, id: 'ac_other' }],
    });
    await expect(resolve(accounts)).rejects.toMatchObject({ reason: 'identity_mismatch' });
    expect(accounts.createAuthenticationConfiguration).toHaveBeenCalledTimes(1);
  });
  it('does not retry an unknown create when the provider still returns no candidate', async () => {
    const { client: accounts } = fakeClient();
    accounts.createAuthenticationConfiguration.mockRejectedValue(new Error('unknown'));
    await expect(resolve(accounts)).rejects.toThrow();
    await expect(resolve(accounts)).rejects.toThrow();
    expect(accounts.createAuthenticationConfiguration).toHaveBeenCalledTimes(1);
  });
  it.each(['duplicate', 'disabled', 'foreign-toolkit', 'wrong-scheme', 'custom'])(
    'refuses exact-name ambiguity or incompatible candidate %s before create',
    async (kind) => {
      const { client: accounts } = fakeClient();
      accounts.listAuthenticationConfigurations.mockImplementation(async ({ name }) => {
        const candidate = {
          id: 'ac_bad',
          name,
          toolkit: kind === 'foreign-toolkit' ? 'foreign' : 'gmail',
          scheme: kind === 'wrong-scheme' ? 'API_KEY' : 'OAUTH2',
          enabled: kind !== 'disabled',
          managed: kind !== 'custom',
        };
        return {
          items: kind === 'duplicate' ? [candidate, { ...candidate, id: 'other' }] : [candidate],
        };
      });
      await expect(resolve(accounts)).rejects.toThrow();
      expect(accounts.createAuthenticationConfiguration).not.toHaveBeenCalled();
    }
  );
  it('checks later candidate pages before accepting a matching first-page configuration', async () => {
    const { client: accounts } = fakeClient();
    accounts.listAuthenticationConfigurations.mockImplementation(async ({ name }) => ({
      items: [
        {
          id:
            accounts.listAuthenticationConfigurations.mock.calls.length === 1
              ? 'first'
              : 'duplicate',
          name,
          toolkit: 'gmail',
          scheme: 'OAUTH2',
          enabled: true,
          managed: true,
        },
      ],
      ...(accounts.listAuthenticationConfigurations.mock.calls.length === 1
        ? { nextCursor: 'page-two' }
        : {}),
    }));
    await expect(resolve(accounts)).rejects.toThrow();
    expect(accounts.listAuthenticationConfigurations).toHaveBeenCalledTimes(2);
    expect(accounts.createAuthenticationConfiguration).not.toHaveBeenCalled();
  });

  it.each(['ready', 'create_unknown'] as const)(
    'refuses mutated same-identity automatic policy on %s reuse',
    async (state) => {
      for (const changed of [
        'widened-scope',
        'shared-credential',
        'tool-restriction',
        'proxy',
        'router',
        'unknown-policy',
        'field-credential',
      ]) {
        const toolkit = `case-${changed}`;
        const { client: accounts, setStored } = fakeClient();
        if (changed === 'field-credential')
          accounts.getToolkitAuthentication.mockResolvedValue({
            toolkit,
            enabled: true,
            managedOAuth2: false,
            managedScopes: [],
            managedUserScopes: [],
            methods: [
              {
                scheme: 'API_KEY',
                needsDeveloperConfiguration: false,
                descriptor: {
                  toolkit,
                  scheme: 'API_KEY',
                  kind: 'fields',
                  source: 'account-fields',
                  fields: [
                    {
                      name: 'api_key',
                      label: 'Key',
                      description: '',
                      type: 'string',
                      secret: true,
                      required: true,
                    },
                  ],
                },
              },
            ],
          });
        const create = accounts.createAuthenticationConfiguration.getMockImplementation()!;
        if (state === 'create_unknown')
          accounts.createAuthenticationConfiguration.mockImplementationOnce(async (input) => {
            await create(input);
            throw new Error('lost response');
          });
        if (state === 'ready') await resolve(accounts, toolkit);
        else await expect(resolve(accounts, toolkit)).rejects.toThrow();
        const stored = await accounts.getAuthenticationConfiguration('ac_auto');
        const raw: Record<string, unknown> = {
          id: stored.id,
          name: stored.name,
          toolkit: { slug: toolkit },
          auth_scheme: stored.scheme,
          status: 'ENABLED',
          is_composio_managed: stored.managed,
          type: stored.managed ? 'default' : 'custom',
          credentials: stored.managed ? { scopes: ['read'] } : {},
          tool_access_config: {},
          is_enabled_for_tool_router: false,
        };
        if (changed === 'widened-scope') raw.credentials = { scopes: ['read', 'UNDECLARED_SCOPE'] };
        if (changed === 'shared-credential')
          raw.shared_credentials = { api_key: 'PRIVATE_POLICY_SENTINEL' };
        if (changed === 'tool-restriction')
          raw.tool_access_config = { tools_available_for_execution: ['ONLY_THIS'] };
        if (changed === 'proxy')
          raw.proxy_config = {
            proxy_url: 'https://example.invalid',
            proxy_auth_key: 'PRIVATE_POLICY_SENTINEL',
          };
        if (changed === 'router') raw.is_enabled_for_tool_router = true;
        if (changed === 'unknown-policy') raw.unrecognized_policy = 'PRIVATE_POLICY_SENTINEL';
        if (changed === 'field-credential')
          raw.credentials = { api_key: 'PRIVATE_POLICY_SENTINEL' };
        const normalized = normalizeComposioAuthenticationConfiguration(raw);
        expect(JSON.stringify(normalized)).not.toContain('PRIVATE_POLICY_SENTINEL');
        setStored(normalized);
        await expect(resolve(accounts, toolkit)).rejects.toThrow(
          'Account setup could not be confirmed'
        );
        expect(accounts.createAuthenticationConfiguration).toHaveBeenCalledTimes(1);
      }
    }
  );

  it('refuses repeated cursors without searching indefinitely or creating', async () => {
    const { client: accounts } = fakeClient();
    accounts.listAuthenticationConfigurations.mockResolvedValue({
      items: [],
      nextCursor: 'same',
    } as never);
    await expect(resolve(accounts)).rejects.toThrow();
    expect(accounts.listAuthenticationConfigurations).toHaveBeenCalledTimes(2);
    expect(accounts.createAuthenticationConfiguration).not.toHaveBeenCalled();
  });
  it('does not provision or fall back when the explicit configuration is invalid', async () => {
    const { client: accounts } = fakeClient();
    accounts.getAuthenticationConfiguration.mockResolvedValue({
      id: 'ac_override',
      name: 'custom',
      toolkit: 'foreign',
      scheme: 'OAUTH2',
      enabled: false,
      managed: false,
    });
    await expect(
      resolveManagedAuthenticationConfiguration({
        db,
        accounts,
        toolkit: 'gmail',
        configuredAuthConfigId: 'ac_override',
        signal: signal(),
      })
    ).rejects.toThrow();
    expect(accounts.createAuthenticationConfiguration).not.toHaveBeenCalled();
    expect(await db.select().from(schema.managedConnectorAuthConfigResolution)).toEqual([]);
  });
  it('isolates projects and preserves an already stored ready row when another toolkit is added', async () => {
    const first = fakeClient().client;
    await resolve(first);
    const old = await db.select().from(schema.managedConnectorAuthConfigResolution);
    await resolve(fakeClient().client, 'linear');
    const other = fakeClient().client;
    other.authConfigProjectDigest = 'project-b';
    await resolve(other);
    const rows = await db.select().from(schema.managedConnectorAuthConfigResolution);
    expect(rows).toHaveLength(3);
    expect(
      rows.find((row) => row.toolkit === 'gmail' && row.projectDigest === 'project-a')
    ).toEqual(old[0]);
  });
});
