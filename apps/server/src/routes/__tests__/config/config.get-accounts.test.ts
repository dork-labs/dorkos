/**
 * `GET /api/config`: where new agents live and which Claude account new work
 * runs on, both resolved by the server because the app cannot see its
 * environment or its data directory.
 */
import { DEFAULT_ACCOUNT_COLORS } from '@dorkos/shared/account-usage';
import { describe, it, expect, afterEach } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { server, store, useFreshConfigApp } from './config.fixtures.js';

/** GET the snapshot and hand back its body. */
async function getConfig() {
  return (await request(server).get('/api/config').expect(200)).body;
}

/** PATCH `body` as the person at the desk, expecting it to land. */
async function patch(body: object): Promise<void> {
  await request(server).patch('/api/config').send(body).expect(200);
}

describe('GET /api/config, agents and accounts', () => {
  const tmp = useFreshConfigApp({ withRuntimes: true });

  // The app shows where a new agent will live, so the reported directory has to
  // be the one the server creates in, resolved against DORK_HOME (DOR-662).
  describe('agents.defaultDirectory', () => {
    it('is resolved against DORK_HOME, not the home dir', async () => {
      const { agents } = await getConfig();
      expect(agents.defaultDirectory).toBe(path.join(tmp.dir, 'agents'));
      expect(agents.defaultAgent).toBe('dorkbot');
    });

    it('expands the tilde of a directory the person configured as their own', async () => {
      (await store()).set('agents', { defaultDirectory: '~/work/agents', defaultAgent: 'dorkbot' });
      expect((await getConfig()).agents.defaultDirectory).toBe(
        path.join(os.homedir(), 'work/agents')
      );
    });

    // GET ships a RESOLVED value while the store keeps the portable spelling;
    // that is only safe while no write round-trips the resolved form back.
    it('is never persisted resolved, by a patch or a default-agent change', async () => {
      await getConfig();
      await patch({ ui: { theme: 'dark' } });
      await request(server)
        .put('/api/config/agents/defaultAgent')
        .send({ value: 'scout' })
        .expect(200);

      expect((await store()).get('agents')).toEqual({
        defaultDirectory: '~/.dork/agents',
        defaultAgent: 'scout',
      });
    });
  });

  // The app cannot see the server's `CLAUDE_CONFIG_DIR`, so GET resolves the
  // active Claude account for the switcher (spec claude-code-accounts, AC 8).
  describe('claudeCode, which Claude account new work runs on', () => {
    const ORIGINAL_ENV = process.env.CLAUDE_CONFIG_DIR;

    afterEach(() => {
      if (ORIGINAL_ENV === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_ENV;
    });

    it('reports the inherited environment as the resolved account', async () => {
      process.env.CLAUDE_CONFIG_DIR = '/tmp/inherited-claude';

      expect((await getConfig()).claudeCode).toEqual({
        resolvedAccount: '/tmp/inherited-claude',
        inherited: true,
        accounts: [],
        defaultAccountColor: null,
        defaultAccountResolvedColor: DEFAULT_ACCOUNT_COLORS[0],
        // Nobody registered the inherited folder and Main never follows the
        // env (contract rev 6d), so no row is named; the override says where.
        launchOverride: { env: 'CLAUDE_CONFIG_DIR', path: '/tmp/inherited-claude' },
        defaultAccountOnlyProjects: null,
        projectAccounts: [],
        persistentSession: true,
        credits: expect.objectContaining({ id: 'dorkos-credits', isDefault: false }),
      });
    });

    it('reports a chosen account, its roster, and which of them it can find', async () => {
      const real = path.join(tmp.dir, 'claude2');
      fs.mkdirSync(path.join(real, 'projects'), { recursive: true });
      const missing = path.join(tmp.dir, 'gone');
      process.env.CLAUDE_CONFIG_DIR = '/tmp/inherited-claude';
      const configManager = await store();
      configManager.set('runtimes', {
        ...configManager.get('runtimes'),
        claudeCode: {
          defaultAccount: real,
          accounts: [
            { id: 'acme-corp', path: real, label: 'Acme Corp', color: '#12ab9f' },
            { id: 'gone', path: missing, label: null, color: null },
          ],
          defaultAccountColor: null,
          defaultAccountOnlyProjects: null,
          projectAccounts: {},
          dismissedFolders: [],
          defaultModel: null,
          defaultEffort: null,
          defaultTrustStop: null,
          persistentSession: false,
          maxWarmProcesses: null,
        },
      });

      // The chosen account wins over the inherited env var, and the roster says
      // honestly which entries no longer resolve.
      expect((await getConfig()).claudeCode).toEqual({
        resolvedAccount: real,
        inherited: false,
        defaultAccountColor: null,
        defaultAccountResolvedColor: '#12ab9f',
        resolvedAccountId: 'acme-corp',
        accounts: [
          {
            id: 'acme-corp',
            path: real,
            label: 'Acme Corp',
            color: '#12ab9f',
            colorIsDefault: false,
            isAccountRoot: true,
            // `default` names this row's folder, so it is Main's own row, which
            // agents never pick (DOR-5033).
            isDefault: true,
            onlyProjects: null,
          },
          {
            id: 'gone',
            path: missing,
            label: null,
            // No stored color: the default for its position, the second one.
            color: DEFAULT_ACCOUNT_COLORS[1],
            colorIsDefault: true,
            isAccountRoot: false,
            onlyProjects: null,
          },
        ],
        defaultAccountOnlyProjects: null,
        projectAccounts: [],
        persistentSession: false,
        credits: expect.objectContaining({ id: 'dorkos-credits', isDefault: false }),
      });
    });

    it('serves the default account color for the Settings row', async () => {
      const configManager = await store();
      configManager.setDot('runtimes.claudeCode.defaultAccountColor', '#d6336c');
      expect((await getConfig()).claudeCode.defaultAccountColor).toBe('#d6336c');
    });

    it.each([
      // The runtimes list stays flat ids, which other readers rely on.
      [null, ['claude-code', 'codex', 'opencode', 'doe']],
      ['codex', ['claude-code', 'opencode', 'doe']],
      ['doe', ['claude-code', 'codex', 'opencode']],
    ])('lists the enabled runtimes as flat ids (disabled: %s)', async (disabled, remaining) => {
      if (disabled) (await store()).setDot(`runtimes.${disabled}.enabled`, false);
      expect((await getConfig()).runtimes).toEqual(remaining);
    });
  });
});
