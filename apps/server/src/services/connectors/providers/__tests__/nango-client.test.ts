import { describe, it, expect, vi } from 'vitest';
import { connections, createDb, eq, runMigrations } from '@dorkos/db';
import { ConnectorRegistry } from '../../registry.js';
import { FetchNangoHttpClient } from '../nango-client.js';
import {
  NangoConnectorProvider,
  toExternalAccountRef as toNangoExternalAccountRef,
} from '../nango.js';

/** Build a client over a fetch fake that records every call it receives. */
function clientWith(responses: Array<{ status?: number; body?: string }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const response = responses[Math.min(i, responses.length - 1)] ?? {};
    i += 1;
    return new Response(response.body ?? '{}', { status: response.status ?? 200 });
  });
  const client = new FetchNangoHttpClient({
    secretKey: 'sk-nango-secret',
    baseUrl: 'http://localhost:3003',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { client, calls };
}

describe('FetchNangoHttpClient — integration logos', () => {
  it('keeps a logo on the Nango server itself or on Nango’s hosted app, and nothing else', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown) => {
      calls.push(String(url));
      // The documented GET /integrations item shape, with logos on four hosts.
      return new Response(
        JSON.stringify({
          data: [
            {
              unique_key: 'slack-work',
              display_name: 'Slack',
              provider: 'slack',
              logo: 'https://nango.example.com/images/template-logos/slack.svg',
              created_at: '2023-10-16T08:45:26.241Z',
              updated_at: '2023-10-16T08:45:26.241Z',
            },
            {
              unique_key: 'github',
              provider: 'github',
              logo: 'https://app.nango.dev/images/template-logos/github.svg',
            },
            {
              unique_key: 'notion',
              provider: 'notion',
              logo: 'https://cdn.example.net/notion.svg',
            },
            { unique_key: 'hubspot', provider: 'hubspot' },
          ],
        })
      );
    });
    const client = new FetchNangoHttpClient({
      secretKey: 'sk-nango-secret',
      baseUrl: 'https://nango.example.com',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const integrations = await client.listIntegrations();

    expect(calls).toEqual(['https://nango.example.com/integrations']);
    expect(integrations.map((it) => [it.uniqueKey, it.logoUrl])).toEqual([
      ['slack-work', 'https://nango.example.com/images/template-logos/slack.svg'],
      ['github', 'https://app.nango.dev/images/template-logos/github.svg'],
      ['notion', undefined],
      ['hubspot', undefined],
    ]);
    // When it was set up rides along: it keeps which setup a popular app goes to stable.
    expect(integrations[0]?.createdAt).toBe('2023-10-16T08:45:26.241Z');
    expect(integrations[1]).not.toHaveProperty('createdAt');
  });
});

describe('FetchNangoHttpClient — status normalization (DOR-415 nit)', () => {
  /** Drive getConnectionState with a raw status and read the normalized one. */
  async function stateFor(rawStatus: string | undefined): Promise<string> {
    const { client } = clientWith([
      { body: JSON.stringify(rawStatus === undefined ? {} : { status: rawStatus }) },
    ]);
    const state = await client.getConnectionState('cs_1');
    return state.status;
  }

  it('keeps PENDING as the explicit in-flight case', async () => {
    await expect(stateFor('PENDING')).resolves.toBe('PENDING');
    await expect(stateFor('pending')).resolves.toBe('PENDING');
  });

  it('maps the known terminal states', async () => {
    await expect(stateFor('EXPIRED')).resolves.toBe('EXPIRED');
    await expect(stateFor('ERROR')).resolves.toBe('ERROR');
    await expect(stateFor('FAILED')).resolves.toBe('ERROR');
  });

  it('defaults an UNKNOWN status to ERROR, never in-flight (a poller must not spin forever)', async () => {
    await expect(stateFor('SOMETHING_NEW')).resolves.toBe('ERROR');
    await expect(stateFor(undefined)).resolves.toBe('ERROR');
  });
});

describe('FetchNangoHttpClient — end_user identity (DOR-415 nit)', () => {
  it('sends a fresh UUID end_user.id per connect; the label stays display_name only', async () => {
    const { client, calls } = clientWith([
      { body: JSON.stringify({ data: { token: 't1' } }) },
      { body: JSON.stringify({ data: { token: 't2' } }) },
    ]);

    await client.initiateConnection({ integration: 'gmail', label: 'work' });
    await client.initiateConnection({ integration: 'gmail', label: 'work' });

    const bodies = calls.map(
      (call) =>
        JSON.parse(String(call.init.body)) as { end_user: { id: string; display_name: string } }
    );
    // Duplicate labels yield DISTINCT end-user ids…
    expect(bodies[0]!.end_user.id).not.toBe(bodies[1]!.end_user.id);
    expect(bodies[0]!.end_user.id).toMatch(/^[0-9a-f-]{36}$/);
    // …while the label rides only as the display name.
    expect(bodies[0]!.end_user.display_name).toBe('work');
    expect(bodies[1]!.end_user.display_name).toBe('work');
    expect(bodies[0]!.end_user.id).not.toBe('work');
  });
});

describe('FetchNangoHttpClient — sign-in status from the documented GET /connections shape (DOR-2501)', () => {
  /** A provider over the real client, answering GET /connections with `connections`. */
  function nangoOver(connections: unknown[]) {
    const fetchImpl = vi.fn(async (url: unknown) => {
      const path = new URL(String(url)).pathname;
      const body =
        path === '/integrations'
          ? { data: [{ unique_key: 'gmail', provider: 'google-mail', display_name: 'Gmail' }] }
          : { connections };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    return new NangoConnectorProvider({
      client: new FetchNangoHttpClient({
        secretKey: 'sk-nango-secret',
        baseUrl: 'http://localhost:3003',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    });
  }

  /** One `GET /connections` item as the Nango API reference shapes it: no `status`. */
  function connection(id: string, errors?: Array<{ type: string; log_id: string }>) {
    return {
      id: 1,
      connection_id: id,
      provider: 'google-mail',
      provider_config_key: 'gmail',
      created: '2026-09-01T00:00:00.000Z',
      metadata: {},
      ...(errors && { errors }),
    };
  }

  /** Keep one signed-in account per id on a fresh store, then record `provider`'s listing. */
  async function recordedStatuses(provider: NangoConnectorProvider, ids: string[]) {
    const db = createDb(':memory:');
    runMigrations(db);
    const registry = new ConnectorRegistry({ db });
    registry.register(provider);
    const kept = ids.map((id) =>
      registry.recordConnect(provider, {
        externalAccountRef: toNangoExternalAccountRef(id),
        toolkit: 'gmail',
        label: id,
        status: 'active',
        custody: 'self-host',
      })
    );
    // A listing that starts after the sign-ins were recorded.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const startedAt = new Date().toISOString();
    registry.recordSignInStatus(provider, await provider.listAccounts(), startedAt);
    return kept.map((account) =>
      db
        .select({ status: connections.status, at: connections.lastVerifiedAt })
        .from(connections)
        .where(eq(connections.id, account.id))
        .get()!
    );
  }

  it('reads no auth error as signed in, and an auth error as expired (a sync error is not a sign-in problem)', async () => {
    const provider = nangoOver([
      connection('c-ok', []),
      connection('c-sync', [{ type: 'sync', log_id: 'log-1' }]),
      connection('c-auth', [{ type: 'auth', log_id: 'log-2' }]),
    ]);

    const [ok, sync, auth] = await recordedStatuses(provider, ['c-ok', 'c-sync', 'c-auth']);

    expect(ok!.status).toBe('active');
    expect(sync!.status).toBe('active');
    expect(auth!.status).toBe('expired');
  });

  it('writes nothing when the listing says nothing about the sign-in', async () => {
    const provider = nangoOver([connection('c-silent'), { ...connection('c-odd'), status: 'NEW' }]);
    const accounts = await provider.listAccounts();
    expect(accounts.map((account) => account.status)).toEqual(['unknown', 'unknown']);

    const [silent, odd] = await recordedStatuses(provider, ['c-silent', 'c-odd']);

    // Still the sign-in's own record: no status written and no check time moved.
    for (const row of [silent!, odd!]) {
      expect(row.status).toBe('active');
      expect(row.at! < new Date(Date.now() - 4).toISOString()).toBe(true);
    }
  });
});
