/**
 * `PATCH /api/config` and `PUT /api/config/agents/defaultAgent` as the person
 * at the desk: what a write stores, what it refuses as malformed, and what the
 * answer may carry back. Agent and key refusals are `config.authority.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import os from 'os';
import path from 'path';
import { asPerson, server, setOwnerId, store, useFreshConfigApp } from './config.fixtures.js';

/** An owner exists, so operator-only saves are held for the person's step-up. */
vi.mock('../../../services/core/auth/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/core/auth/index.js')>()),
  readOwnerAccount: () => ({ id: 'user_cockpit', name: 'Owner' }),
  readOwnerEmail: () => null,
}));
setOwnerId(() => 'user_cockpit');

/** PATCH as the person, confirming a held save with their password. */
const personPatch = (body: object) => asPerson(request(server).patch('/api/config').send(body));

describe('PATCH /api/config', () => {
  const tmp = useFreshConfigApp();

  it('returns the merged config for a partial update, and stores it', async () => {
    const response = await request(server)
      .patch('/api/config')
      .send({ ui: { theme: 'dark' } })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.config.ui.theme).toBe('dark');
    expect(response.body.config.server.port).toBe(4242);
    expect((await store()).getDot('ui.theme')).toBe('dark');
  });

  it('takes an empty object as a no-op', async () => {
    const response = await request(server).patch('/api/config').send({}).expect(200);
    expect(response.body.config.server.port).toBe(4242);
  });

  it('refuses an array body', async () => {
    const response = await request(server)
      .patch('/api/config')
      .send([{ server: { port: 5000 } }])
      .expect(400);
    expect(response.body.detail).toContain('JSON object');
  });

  it.each([
    ['a port below the range', { server: { port: 80 } }, 'server.port'],
    ['a port above the range', { server: { port: 70000 } }, 'server.port'],
    ['an unknown theme', { ui: { theme: 'invalid-theme' } }, 'ui.theme'],
  ])('refuses %s with the schema errors', async (_label, body, leaf) => {
    const response = await request(server).patch('/api/config').send(body).expect(400);
    expect(response.body.code).toBe('invalid_request');
    expect(response.body.detail).toContain(leaf);
  });

  it('warns once for each sensitive key the patch stores', async () => {
    const response = await personPatch({ tunnel: { authtoken: 'token', auth: 'user:pass' } });
    expect(response.status).toBe(200);
    expect(response.body.warnings).toHaveLength(2);
    expect(response.body.warnings[0]).toContain('sensitive data');
  });

  it('lets a person change the operator-only settings', async () => {
    // The write allowlist, proven not to have leaked onto the human path.
    const response = await personPatch({
      tunnel: { enabled: true, domain: 'me.ngrok.app' },
      mcp: { apiKey: 'chosen-by-a-person' },
      telemetry: { usage: false },
      server: { boundary: tmp.dir },
    });
    expect(response.status).toBe(200);
    expect(response.body.config.tunnel).toMatchObject({ enabled: true, domain: 'me.ngrok.app' });
    expect(response.body.config.telemetry.usage).toBe(false);
    expect(response.body.config.server.boundary).toBe(tmp.dir);
  });

  it('lets a person turn the knock off without resetting its siblings (DOR-1385)', async () => {
    // Settings writes through this route, so an operator-only bar that refused
    // the person here would leave them no way to change their own sounds.
    await request(server)
      .patch('/api/config')
      .send({ notifications: { sounds: { knock: false } } })
      .expect(200);

    const configManager = await store();
    expect(configManager.getDot('notifications.sounds.knock')).toBe(false);
    expect(configManager.getDot('notifications.sounds.allClear')).toBe(true);
    expect(configManager.getDot('notifications.notifyOnTurnCompleteWhileAway')).toBe(true);
  });

  it('lets a person set and clear company certificates (DOR-3361)', async () => {
    const configManager = await store();
    const bundle = '/Users/someone/company-ca.pem';
    expect((await personPatch({ network: { extraCaCertsPath: bundle } })).status).toBe(200);
    expect(configManager.getDot('network.extraCaCertsPath')).toBe(bundle);
    expect((await personPatch({ network: { extraCaCertsPath: null } })).status).toBe(200);
    expect(configManager.getDot('network.extraCaCertsPath')).toBeNull();
  });

  describe('settings that live inside a list (DOR-1113)', () => {
    it('lets the person write both lists, which is how they are managed', async () => {
      // Exactly what `ClaudeAccountsSection.tsx` `write()` sends.
      const accounts = await personPatch({
        runtimes: {
          claudeCode: {
            accounts: [{ id: 'me', path: '/Users/me/.claude', label: 'Me', color: null }],
          },
        },
      });
      expect(accounts.status).toBe(200);
      expect(accounts.body.config.runtimes.claudeCode.accounts).toEqual([
        { id: 'me', path: '/Users/me/.claude', label: 'Me', color: null },
      ]);

      const servers = await personPatch({
        connectors: {
          rawMcpServers: [
            {
              slug: 'notes',
              displayName: 'Notes',
              url: 'https://notes.test/mcp',
              transport: 'http',
            },
          ],
        },
      });
      expect(servers.status).toBe(200);
      expect(servers.body.config.connectors.rawMcpServers[0].slug).toBe('notes');

      // Emptying is a write to the list too; the person must be able to undo an add.
      const emptied = await personPatch({
        runtimes: { claudeCode: { accounts: [], accountsSeen: ['me'] } },
      });
      expect(emptied.status).toBe(200);
      expect(emptied.body.config.runtimes.claudeCode.accounts).toEqual([]);
    });
  });

  describe('the account rules (spec flow-multiproject §8.1)', () => {
    // A rule in the wrong shape is refused, never stored as the wider "no rule".
    it('refuses a malformed rule with a 400 naming it, and stores nothing', async () => {
      const configManager = await store();
      const before = JSON.stringify(configManager.get('runtimes'));
      const bad: [string, Record<string, unknown>][] = [
        ['defaultAccountOnlyProjects', { defaultAccountOnlyProjects: 'client-app' }],
        ['defaultAccountOnlyProjects', { defaultAccountOnlyProjects: [''] }],
        ['projectAccounts', { projectAccounts: { '/work/client.app': {} } }],
        ['projectAccounts', { projectAccounts: { '/work/a': { allowed: ['work'] } } }],
        ['projectAccounts', { projectAccounts: { '/work/a': { allow: ['work', ''] } } }],
      ];
      for (const [leaf, claudeCode] of bad) {
        const refused = await personPatch({ runtimes: { claudeCode } });
        expect(refused.status).toBe(400);
        expect(JSON.stringify(refused.body)).toContain(`runtimes.claudeCode.${leaf}`);
      }
      expect(JSON.stringify(configManager.get('runtimes'))).toBe(before);

      // The control: a well-formed rule is stored.
      const ok = await personPatch({
        runtimes: { claudeCode: { projectAccounts: { '/work/a': { allow: ['work'] } } } },
      });
      expect(ok.status).toBe(200);
      expect(configManager.get('runtimes').claudeCode.projectAccounts).toMatchObject({
        '/work/a': { allow: ['work'] },
      });
    });
  });

  describe('the default account color (DOR-2492)', () => {
    const stored = async () => (await store()).getDot('runtimes.claudeCode.defaultAccountColor');

    it('stores a color the person chooses, and clears it again with null', async () => {
      for (const value of ['#0d9488', null]) {
        await request(server)
          .patch('/api/config')
          .send({ runtimes: { claudeCode: { defaultAccountColor: value } } })
          .expect(200);
        expect(await stored()).toBe(value);
      }
    });

    it('refuses a color that is not lowercase #rrggbb with a 400, and stores nothing', async () => {
      for (const bad of ['#ABCDEF', 'teal', '#abc', 42]) {
        const refused = await request(server)
          .patch('/api/config')
          .send({ runtimes: { claudeCode: { defaultAccountColor: bad } } })
          .expect(400);
        expect(JSON.stringify(refused.body)).toContain('defaultAccountColor');
      }
      expect(await stored()).toBeNull();
    });

    it('survives a Settings save of the accounts, which never names it', async () => {
      expect(
        (await personPatch({ runtimes: { claudeCode: { defaultAccountColor: '#0d9488' } } })).status
      ).toBe(200);
      const save = await personPatch({
        runtimes: {
          claudeCode: {
            accounts: [{ id: 'me', path: '/Users/me/.claude2', label: 'Me', color: null }],
            accountsSeen: [],
          },
        },
      });
      expect(save.status).toBe(200);
      expect(await stored()).toBe('#0d9488');
    });
  });

  it('stores a default account written with ~ as the absolute folder', async () => {
    // The absolute and null spellings are `config-write.test.ts`.
    const res = await personPatch({ runtimes: { claudeCode: { defaultAccount: '~/.claude2' } } });
    expect(res.status).toBe(200);
    expect((await store()).getDot('runtimes.claudeCode.defaultAccount')).toBe(
      path.join(os.homedir(), '.claude2')
    );
  });

  describe('the answer never carries a stored secret (DOR-1740)', () => {
    // The response used to be the whole stored file, so saving an ngrok token
    // got it back verbatim, and every unrelated patch carried it after that.

    /** Read a dot-path out of a response body, or `undefined` if any hop is missing. */
    function readDotPath(root: unknown, dotPath: string): unknown {
      let node: unknown = root;
      for (const part of dotPath.split('.')) {
        if (node === null || typeof node !== 'object') return undefined;
        node = (node as Record<string, unknown>)[part];
      }
      return node;
    }

    it('withholds the token a patch just saved, and says only that one is set', async () => {
      const response = await personPatch({ tunnel: { authtoken: 'ngrok-secret-value' } });
      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).not.toContain('ngrok-secret-value');
      // Withheld by ABSENCE plus a boolean, never by `null`, which reads as "no token".
      expect('authtoken' in response.body.config.tunnel).toBe(false);
      expect(response.body.config.tunnel.authtokenConfigured).toBe(true);
      expect((await store()).getDot('tunnel.authtoken')).toBe('ngrok-secret-value');
    });

    it('never carries the secrets already on disk, whatever the patch was about', async () => {
      // Derived from `SENSITIVE_CONFIG_KEYS`, so a new secret is covered the day it is added.
      const { SENSITIVE_CONFIG_KEYS } = await import('@dorkos/shared/config-schema');
      const configManager = await store();
      const planted = new Map(
        SENSITIVE_CONFIG_KEYS.map((key) => [key, `planted-${key.replace(/\./g, '-')}`])
      );
      expect(planted.size).toBeGreaterThan(0);
      for (const [key, value] of planted) configManager.setDot(key, value);

      const response = await request(server)
        .patch('/api/config')
        .send({ ui: { theme: 'dark' } })
        .expect(200);

      const serialized = JSON.stringify(response.body);
      for (const [key, value] of planted) {
        expect(serialized, `${key} rode the PATCH response`).not.toContain(value);
        expect(readDotPath(response.body.config, key)).toBeUndefined();
        const parts = key.split('.');
        const flag = [...parts.slice(0, -1), `${parts.at(-1)!}Configured`].join('.');
        expect(readDotPath(response.body.config, flag)).toBe(true);
      }
      // And the leak was not "fixed" by refusing to store them.
      for (const [key, value] of planted) expect(configManager.getDot(key)).toBe(value);
    });

    it('matches the published wire contract, so the schema is not a decoration', async () => {
      const { ConfigPatchResponseSchema } = await import('@dorkos/shared/schemas');
      const response = await request(server)
        .patch('/api/config')
        .send({ server: { port: 8080 }, ui: { theme: 'dark' } })
        .expect(200);

      const parsed = ConfigPatchResponseSchema.safeParse(response.body);
      expect(parsed.error?.issues ?? []).toEqual([]);
      expect(parsed.data?.config.tunnel).toEqual({
        enabled: false,
        domain: null,
        authtokenConfigured: false,
        authConfigured: false,
      });
    });

    it('withholds the credential REFERENCES too, which name where a secret lives', async () => {
      // ADR-0315: a `file:` reference tells a reader which file to open.
      const configManager = await store();
      configManager.set('providers', { anthropic: 'file:planted-provider-ref' });
      configManager.setDot('runtimes.codex.credentialRef', 'env:PLANTED_CODEX_KEY');

      const response = await request(server)
        .patch('/api/config')
        .send({ ui: { theme: 'light' } })
        .expect(200);

      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain('file:planted-provider-ref');
      expect(serialized).not.toContain('env:PLANTED_CODEX_KEY');
      expect(response.body.config.providersConfigured).toEqual(['anthropic']);
      expect(response.body.config.runtimes.codex.credentialRefConfigured).toBe(true);
    });

    it('carries nothing of the managed remote record but its mode and two booleans (DOR-2086)', async () => {
      const { updateRemoteState } = await import('../../../services/core/remote/remote-state.js');
      updateRemoteState('test', {
        mode: 'managed',
        enrolmentId: 'enr_PLANTED',
        consentVersion: 'consent_PLANTED',
        instanceId: 'inst_PLANTED',
        credentialId: 'cred_PLANTED',
        fingerprint: 'fp_PLANTED',
        credentialRef: 'file:remote-tunnel-cred_PLANTED',
        edgeProofRef: 'file:remote-edge-cred_PLANTED',
        edgeProofHeader: 'x-planted-edge',
        hosts: ['planted.example.com'],
      });

      const patched = await request(server)
        .patch('/api/config')
        .send({ ui: { theme: 'dark' } })
        .expect(200);
      const fetched = await request(server).get('/api/config').expect(200);

      for (const body of [patched.body, fetched.body]) {
        expect(JSON.stringify(body)).not.toMatch(/PLANTED|planted/);
      }
      expect(patched.body.config.cloud.remote).toEqual({
        mode: 'managed',
        credentialRefConfigured: true,
        edgeProofRefConfigured: true,
      });
    });

    it('refuses a patch that names cloud.remote, and changes nothing', async () => {
      const response = await request(server)
        .patch('/api/config')
        .send({ cloud: { remote: { mode: 'managed' } } });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('invalid_request');
      expect((await store()).get('cloud').remote.mode).toBe('off');
    });
  });
});

describe('PUT /api/config/agents/defaultAgent', () => {
  useFreshConfigApp();

  it('stores the trimmed name and answers with it', async () => {
    const res = await request(server)
      .put('/api/config/agents/defaultAgent')
      .send({ value: '  my-agent  ' })
      .expect(200);

    expect(res.body).toMatchObject({ success: true, defaultAgent: 'my-agent' });
    expect((await store()).get('agents')?.defaultAgent).toBe('my-agent');
  });

  it.each([
    ['missing', {}],
    ['blank', { value: '  ' }],
    ['not a string', { value: 123 }],
  ])('refuses a value that is %s', async (_label, body) => {
    const res = await request(server).put('/api/config/agents/defaultAgent').send(body).expect(400);
    expect(res.body.detail).toContain('non-empty');
  });
});
