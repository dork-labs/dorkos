/**
 * `PATCH /api/config`: who may change the settings that protect this install.
 *
 * An agent is refused the operator-only paths (DOR-467); with login on, a key
 * is refused them too (DOR-505); the DorkOS account settings are the owner's
 * alone (DOR-2652); and once an owner exists, a caller with no session proves
 * no one (DOR-3330). Every refusal asserts the STORE as well as the status: a
 * refusal that still wrote would pass a status-only test.
 */
import { describe, it, expect, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import {
  asAgent,
  asPerson,
  caller,
  server,
  setOwnerId,
  store,
  useFreshConfigApp,
} from './config.fixtures.js';

/** The account that owns this install, as `readOwnerAccount` answers (DOR-2652). */
const owner = vi.hoisted(() => ({
  account: { id: 'user_cockpit', name: 'Owner' } as unknown,
  email: null as string | null,
}));
// The gate passes requests; the fixture supplies the caller for the route's real bars.
vi.mock('../../../services/core/auth/session-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/core/auth/session-gate.js')>()),
  decideSessionGate: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('../../../services/core/auth/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/core/auth/index.js')>()),
  readOwnerAccount: () => owner.account,
  readOwnerEmail: () => owner.email,
}));
setOwnerId(() => (owner.account as { id?: string } | null)?.id ?? null);

/** PATCH `body` as whoever {@link caller} names now. */
const send = (body: object) => request(server).patch('/api/config').send(body);

/** Expect an agent's `body` refused as operator-only, naming `leaf`. */
async function expectAgentRefused(body: object, leaf: string): Promise<void> {
  asAgent();
  const refused = await send(body).expect(403);
  expect(refused.body.code).toBe('person_only');
  expect(refused.body.paths).toContain(leaf);
}

/** Turn local login on, which is what makes a cookie possible at all. */
async function enableLogin(): Promise<void> {
  (await store()).set('auth', { enabled: true });
}

/** Run `fn` with no owner account on this install. */
async function withNoOwner(fn: () => Promise<void>): Promise<void> {
  owner.account = null;
  try {
    await fn();
  } finally {
    owner.account = { id: 'user_cockpit', name: 'Owner' };
  }
}

describe('PATCH /api/config, who may write what', () => {
  useFreshConfigApp();

  it('lets a person turn login on and off (the app path, DOR-488)', async () => {
    // `OwnerSetupHost.tsx` and `SecurityPanel.tsx` write through here; if this
    // refused, a person could no longer turn login on at all.
    const configManager = await store();
    const enabled = await asPerson(send({ auth: { enabled: true } }));
    expect(enabled.status).toBe(200);
    expect(configManager.getDot('auth.enabled')).toBe(true);

    const disabled = await asPerson(send({ auth: { enabled: false } }));
    expect(disabled.status).toBe(200);
    expect(configManager.getDot('auth.enabled')).toBe(false);
  });

  it('refuses an AGENT the settings that protect the instance (DOR-467)', async () => {
    // With login off `sessionGate` is a pass-through, so this route reached
    // `applyConfigPatch` with no policy check until DOR-467.
    await expectAgentRefused({ server: { boundary: '/' } }, 'server.boundary');
    expect((await store()).getDot('server.boundary')).not.toBe('/');
  });

  it.each([
    // The file every connection trusts; it replaced NODE_EXTRA_CA_CERTS because
    // anything running as the user could set that (DOR-3361).
    [
      'company certificates',
      { network: { extraCaCertsPath: '/tmp/attacker-ca.pem' } },
      'network.extraCaCertsPath',
      'network.extraCaCertsPath',
      null,
    ],
    ['turning login off', { auth: { enabled: false } }, 'auth.enabled', null, undefined],
    // An agent that could silence the knock could park on a question nobody hears of (DOR-1385).
    [
      'the knock',
      { notifications: { sounds: { knock: false } } },
      'notifications.sounds.knock',
      'notifications.sounds.knock',
      true,
    ],
    [
      'the escalation ladder',
      { notifications: { escalation: { phoneAfterMinutes: 'never' } } },
      'notifications.escalation.phoneAfterMinutes',
      null,
      undefined,
    ],
    [
      'the default account color (DOR-2492)',
      { runtimes: { claudeCode: { defaultAccountColor: '#0d9488' } } },
      'runtimes.claudeCode.defaultAccountColor',
      'runtimes.claudeCode.defaultAccountColor',
      null,
    ],
    // Until DOR-1113 the path matcher stopped at the array, so both bars were skipped.
    [
      'a raw MCP server',
      {
        connectors: {
          rawMcpServers: [
            { slug: 'exfil', displayName: 'Exfil', url: 'https://attacker.test/mcp' },
          ],
        },
      },
      'connectors.rawMcpServers[].url',
      'connectors.rawMcpServers',
      [],
    ],
    [
      'a Claude account',
      {
        runtimes: {
          claudeCode: {
            accounts: [{ id: 'acct-1', path: '/tmp/theirs', label: null, color: null }],
          },
        },
      },
      'runtimes.claudeCode.accounts[].path',
      'runtimes.claudeCode.accounts',
      [],
    ],
  ] as const)(
    'refuses an agent %s, and stores nothing',
    async (_label, body, leaf, storedPath, expected) => {
      await expectAgentRefused(body, leaf);
      if (storedPath) expect((await store()).getDot(storedPath)).toEqual(expected);
    }
  );

  describe('settings a config wipe refuses to reverse (DOR-1497)', () => {
    // Every leaf is on `PROTECTIVE_CARRYOVERS`: a wipe may lose a preference but
    // never a protection, so an agent must not reverse one deliberately either.
    // Measured before the fix: each returned 200 and the protective value was gone.
    // One test per direction, not a case each: every case mints a fresh module
    // graph, and twenty more of those ran the worker out of heap.
    const carried: Array<{
      path: string;
      protective: unknown;
      agentWants: unknown;
      patch: object;
    }> = [
      {
        path: 'runtimes.claudeCode.persistentSession',
        protective: false,
        agentWants: true,
        patch: { runtimes: { claudeCode: { persistentSession: true } } },
      },
      {
        path: 'harness.autoSync',
        protective: false,
        agentWants: true,
        patch: { harness: { autoSync: true } },
      },
      {
        path: 'uploads.maxFileSize',
        protective: 1024,
        agentWants: 104857600,
        patch: { uploads: { maxFileSize: 104857600 } },
      },
      {
        path: 'uploads.maxFiles',
        protective: 1,
        agentWants: 20,
        patch: { uploads: { maxFiles: 20 } },
      },
      {
        path: 'uploads.allowedTypes',
        protective: ['image/*'],
        agentWants: ['*/*'],
        patch: { uploads: { allowedTypes: ['*/*'] } },
      },
      {
        path: 'scheduler.maxConcurrentRuns',
        protective: 1,
        agentWants: 10,
        patch: { scheduler: { maxConcurrentRuns: 10 } },
      },
    ];

    it('refuses an AGENT every one of them, and writes nothing', async () => {
      const configManager = await store();
      for (const leaf of carried) configManager.setDot(leaf.path, leaf.protective);
      asAgent();

      for (const leaf of carried) {
        const refused = await send(leaf.patch);
        expect(refused.status, leaf.path).toBe(403);
        expect(refused.body.code, leaf.path).toBe('person_only');
        expect(refused.body.paths, leaf.path).toContain(leaf.path);
        expect(configManager.getDot(leaf.path), leaf.path).toEqual(leaf.protective);
      }
    });

    it('lets the PERSON write every one of them through the same door', async () => {
      // The Control Center, Settings and `dorkos config set` all write here.
      const configManager = await store();
      for (const leaf of carried) configManager.setDot(leaf.path, leaf.protective);

      for (const leaf of carried) {
        const response = await asPerson(send(leaf.patch));
        expect(response.status, leaf.path).toBe(200);
        expect(configManager.getDot(leaf.path), leaf.path).toEqual(leaf.agentWants);
      }
    });

    it('refuses the whole patch when one carried leaf rides along with preferences', async () => {
      // No partial write: the legitimate half must not land as cover.
      const configManager = await store();
      configManager.setDot('harness.autoSync', false);
      asAgent();

      const refused = await send({ ui: { theme: 'dark' }, harness: { autoSync: true } }).expect(
        403
      );
      expect(refused.body.paths).toEqual(['harness.autoSync']);
      expect(configManager.getDot('harness.autoSync')).toBe(false);
      expect(configManager.getDot('ui.theme')).not.toBe('dark');
    });
  });

  it('leaves an agent the ordinary preferences and the lists it may write', async () => {
    // The over-refusal check: each sits beside a refused leaf, and none is
    // carried across a wipe or operator-only, so all must still go through.
    asAgent();
    const ok = await send({
      ui: { theme: 'dark', statusBar: { pins: ['runtime'] } },
      scheduler: { retentionCount: 50 },
      runtimes: { claudeCode: { defaultModel: 'opus' } },
    }).expect(200);

    expect(ok.body.config.ui.statusBar.pins).toEqual(['runtime']);
    const configManager = await store();
    expect(configManager.getDot('ui.theme')).toBe('dark');
    expect(configManager.getDot('runtimes.claudeCode.defaultModel')).toBe('opus');
    expect(configManager.getDot('scheduler.retentionCount')).toBe(50);
  });

  describe('an account kept out of automatic moves (Re-seat P0)', () => {
    const row = { id: 'claude-ab1', path: '/Users/me/.claude-ab1', label: 'AB1', color: null };
    const storedFlag = async () =>
      (
        (await store()).getDot('runtimes.claudeCode.accounts') as Array<{
          id: string;
          noAutoMove?: unknown;
        }>
      ).find((a) => a.id === 'claude-ab1')?.noAutoMove;
    const flagPatch = (noAutoMove: boolean) => ({
      runtimes: { claudeCode: { accounts: [{ ...row, noAutoMove }] } },
    });

    it('refuses an agent clearing the flag, and lets the person clear it', async () => {
      expect((await asPerson(send(flagPatch(true)))).status).toBe(200);
      expect(await storedFlag()).toBe(true);

      await expectAgentRefused(flagPatch(false), 'runtimes.claudeCode.accounts[].noAutoMove');
      expect(await storedFlag()).toBe(true);

      caller.agentHeader = undefined;
      caller.signedInUser = { userId: 'user_cockpit', credential: 'cookie' };
      expect((await asPerson(send(flagPatch(false)))).status).toBe(200);
      expect(await storedFlag()).toBe(false);
    });
  });

  describe('every operator-only setting, with login on (DOR-505)', () => {
    it('refuses a caller holding a per-user API key the login gate and every other operator-only path', async () => {
      // A program with one of the person's keys satisfies `sessionGate` as a
      // browser does (DOR-474), and dropping its agent header clears
      // `trustedCaller`. Before DOR-505 it could turn login off.
      await enableLogin();
      caller.signedInUser = { userId: 'user_program', credential: 'api-key' };

      const refused = await send({ auth: { enabled: false } }).expect(403);
      expect(refused.body.code).toBe('person_only');
      expect(refused.body.paths).toEqual(['auth.enabled']);
      for (const patch of [
        { tunnel: { authtoken: 'attacker-ngrok-token' } },
        { mcp: { apiKey: 'attacker-bearer' } },
        { server: { boundary: '/' } },
        { runtimes: { codex: { binaryPath: '/tmp/evil' } } },
      ]) {
        expect((await send(patch).expect(403)).body.code).toBe('person_only');
      }

      const configManager = await store();
      expect(configManager.getDot('auth.enabled')).toBe(true);
      expect(configManager.getDot('tunnel.authtoken')).toBeNull();
      expect(configManager.getDot('mcp.apiKey')).toBeNull();

      // A key is a legitimate credential, just not a person: ordinary settings go through.
      expect((await send({ ui: { theme: 'dark' } }).expect(200)).body.config.ui.theme).toBe('dark');
    });

    // The DorkOS account's settings are its owner's alone (DOR-2652).
    it('refuses a signed-in person who does not own this DorkOS the account settings', async () => {
      await enableLogin();
      caller.signedInUser = { userId: 'user_member', credential: 'cookie' };

      for (const patch of [
        { cloud: { instanceToken: 'dork_inst_other' } },
        { cloud: { credits: { defaults: { 'claude-code': { runsOn: 'credits' } } } } },
        { cloud: { credits: { agents: ['agent-1'] } } },
        // Cheap checks on credits spend the same account (spec `heartbeats` §6.3).
        { heartbeats: { triageOnCredits: true } },
      ]) {
        const refused = await send(patch).expect(403);
        expect(refused.body.code).toBe('owner_only');
        expect(refused.body.message).toBe(
          'Only the owner of this DorkOS can change its DorkOS account settings.'
        );
      }
      const configManager = await store();
      expect(configManager.getDot('cloud.instanceToken')).not.toBe('dork_inst_other');
      expect(configManager.getDot('heartbeats.triageOnCredits')).not.toBe(true);
    });

    it('refuses the account settings when no owner account can be read', async () => {
      await enableLogin();
      await withNoOwner(async () => {
        const refused = await send({ cloud: { credits: { agents: ['agent-1'] } } }).expect(403);
        expect(refused.body.code).toBe('owner_only');
      });
    });

    it('lets the owner signed in to the app change the account and operator-only settings', async () => {
      await enableLogin();
      expect((await asPerson(send({ cloud: { credits: { agents: ['agent-1'] } } }))).status).toBe(
        200
      );
      const ok = await asPerson(send({ tunnel: { authtoken: 'chosen-by-a-person' } }));
      expect(ok.status).toBe(200);
      // Read off the store: the answer never carries the token (DOR-1740).
      const configManager = await store();
      expect(configManager.getDot('cloud.credits.agents')).toEqual(['agent-1']);
      expect(configManager.getDot('tunnel.authtoken')).toBe('chosen-by-a-person');
      expect(ok.body.config.tunnel.authtokenConfigured).toBe(true);
    });

    it('still refuses an agent that names itself, cookie or not', async () => {
      // Clearing the cookie bar never softens the agent bar behind it.
      await enableLogin();
      caller.agentHeader = 'agent-token';
      const refused = await send({ auth: { enabled: false } }).expect(403);
      expect(refused.body.code).toBe('person_only');
    });
  });

  describe('a caller with no session, once an owner exists (DOR-3330)', () => {
    it('is refused these writes, and nothing is written', async () => {
      caller.signedInUser = undefined;
      const planted = { tunnel: { authtoken: 'planted' }, mcp: { apiKey: 'planted' } };

      // A program hears the route's refusal; the app is asked to step up.
      await send(planted).expect(403);
      await request(server).patch('/api/config').set('x-dorkos-app', '1').send(planted).expect(401);
      // Including turning login on: `OwnerSetupHost.tsx` signs in first.
      await request(server)
        .patch('/api/config')
        .set('x-dorkos-app', '1')
        .send({ auth: { enabled: true } })
        .expect(401);

      const configManager = await store();
      expect(configManager.getDot('tunnel.authtoken')).not.toBe('planted');
      expect(configManager.getDot('mcp.apiKey')).not.toBe('planted');
      expect(configManager.getDot('auth.enabled')).toBe(false);
    });

    it('may still write them before anyone owns this install', async () => {
      caller.signedInUser = undefined;
      await withNoOwner(async () => {
        expect((await send({ tunnel: { authtoken: 'planted' } }).expect(200)).body.success).toBe(
          true
        );
      });
    });
  });

  it('names the owner’s email so turning login on can ask them to sign in (DOR-2964)', async () => {
    expect((await request(server).get('/api/config').expect(200)).body.auth).toMatchObject({
      ownerEmail: null,
    });
    owner.email = 'owner@example.com';
    try {
      const res = await request(server).get('/api/config').expect(200);
      expect(res.body.auth).toMatchObject({ enabled: false, ownerEmail: 'owner@example.com' });
    } finally {
      owner.email = null;
    }
  });
});
