/**
 * A person's Allow on a server for every agent goes through "Confirm it's you"
 * (DOR-3234, DOR-3213). Nothing is written until it passes, a secret reaches no
 * statement, sheet, log or answer, and a proof covers exactly one version of
 * what runs.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn((key: string) => (key === 'auth' ? { enabled: false } : undefined)),
    set: vi.fn(),
    onChange: vi.fn(() => () => undefined),
  },
}));
vi.mock('../../services/core/auth/session-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/session-gate.js')>()),
  decideSessionGate: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('../../services/core/auth/install-owner.js', () => ({
  isInstallOwner: (user?: { userId: string }) => user?.userId === 'owner',
}));
const state = vi.hoisted(() => ({
  owner: { id: 'owner' } as unknown,
  notTheOwner: false,
}));
vi.mock('../../services/core/auth/index.js', () => ({
  readOwnerAccount: () => state.owner,
  hasAnyUser: () => state.owner !== null,
}));
vi.mock('../../services/audit/audit-trail.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/audit/audit-trail.js')>()),
  recordAudit: vi.fn(),
}));
vi.mock('../../lib/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/logger.js')>();
  return { ...actual, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } };
});
vi.mock('../../lib/caller-authority.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/caller-authority.js')>();
  return {
    ...actual,
    refuseFrontDoorChange: (...args: Parameters<typeof actual.refuseFrontDoorChange>) =>
      state.notTheOwner
        ? { status: 403, code: 'NEEDS_PERSON_AT_THIS_COMPUTER', error: 'Only the owner.' }
        : actual.refuseFrontDoorChange(...args),
  };
});

import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { StepUpRequiredBodySchema } from '@dorkos/shared/step-up';

import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { logger } from '../../lib/logger.js';
import { recordAudit } from '../../services/audit/audit-trail.js';
import {
  peekHeldStepUp,
  resetHeldStepUpsForTests,
} from '../../services/core/auth/step-up/step-up-holds.js';
import type { RequestUser } from '../../services/core/auth/session-gate.js';
import type { CredentialStore } from '../../services/core/credential-provider.js';
import { GlobalMcpStore } from '../../services/mesh/global-mcp/global-mcp-store.js';
import { createMcpServerRoutes } from '../mcp-servers.js';
import { createStepUpRoutes, type StepUpRouteDeps } from '../step-up.js';

const target = swappableServer();
const OWN_ORIGIN = 'http://localhost:4242';
const PASSWORD = 'correct horse battery';
const OWNER: RequestUser = { userId: 'owner', credential: 'cookie', sessionId: 'sess-a' };
const SECRET = 'ghp_made_up_secret_value';
const ARG_SECRET = 'made-up-arg-secret';

const stepUpDeps: StepUpRouteDeps = {
  ownerId: () => (state.owner ? 'owner' : null),
  checkPassword: async (password) =>
    !password ? 'required' : password === PASSWORD ? 'ok' : 'wrong',
  minPasswordLength: async () => 8,
  setOwnerPassword: async () => undefined,
  trustedOrigins: () => [OWN_ORIGIN],
};

const SERVER = {
  name: 'github',
  connection: {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_TOKEN: SECRET, LOG_LEVEL: 'info' },
  },
  enabled: true,
};

/** A stored server for `store.add`, as the schema would parse it. */
const stored = (over: Record<string, unknown> = {}) =>
  ({ ...SERVER, secretNames: [], excludedAgents: [], ...over }) as never;

/** What the server's records call each agent. */
const agentNames: Record<string, { name: string; displayName?: string }> = {
  'agent-a': { name: 'Made\u202Eup Scout' },
};

let home: string;
let store: GlobalMcpStore;

function secrets(): CredentialStore {
  const held = new Map<string, string>();
  return {
    put: async (name, secret) => (held.set(name, secret), `file:${name}`),
    get: async (name) => held.get(name) ?? null,
    delete: async (name) => void held.delete(name),
  };
}

function app(user: RequestUser | null = OWNER) {
  return target.mount(
    honoGroupListener(
      [
        {
          path: '/api/mcp-servers',
          routes: createMcpServerRoutes(store, (id) => agentNames[id]),
        },
        { path: '/api/step-up', routes: createStepUpRoutes(stepUpDeps) },
      ],
      {
        before: async (c, next) => {
          if (user) c.set('user', user);
          await next();
        },
      }
    )
  );
}

const post = (body: object = SERVER) =>
  request(app()).post('/api/mcp-servers').set('Origin', OWN_ORIGIN).send(body);
const patch = (body: object) =>
  request(app()).patch('/api/mcp-servers/github').set('Origin', OWN_ORIGIN).send(body);
const heldId = (res: { body: unknown }) => StepUpRequiredBodySchema.parse(res.body).heldActionId;
const confirm = (id: string, password = PASSWORD) =>
  request(app()).post(`/api/step-up/${id}/password`).set('Origin', OWN_ORIGIN).send({ password });
const sheet = async (id: string) => (await request(app()).get(`/api/step-up/${id}`)).body;

beforeEach(() => {
  vi.clearAllMocks();
  resetHeldStepUpsForTests();
  state.owner = { id: 'owner' };
  state.notTheOwner = false;
  home = mkdtempSync(path.join(tmpdir(), 'mcp-step-up-'));
  store = new GlobalMcpStore(home, secrets());
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('adding a server', () => {
  it('holds it, writes nothing, and answers without its secret', async () => {
    const res = await post();
    expect(res.status).toBe(428);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(store.list()).toEqual([]);
  });

  it('holds one that starts off too', async () => {
    expect((await post({ ...SERVER, enabled: false })).status).toBe(428);
    expect(store.list()).toEqual([]);
  });

  it('a wrong password and a cancel write nothing', async () => {
    const id = heldId(await post());
    expect((await confirm(id, 'nope-nope')).body.code).toBe('wrong-password');
    expect(store.list()).toEqual([]);
    const gone = await request(app()).delete(`/api/step-up/${id}`).set('Origin', OWN_ORIGIN);
    expect(gone.status).toBe(204);
    expect((await confirm(id)).status).toBe(404);
    expect(store.list()).toEqual([]);
  });

  it('the right password runs it once, with the secret it was sent', async () => {
    const id = heldId(await post());
    const done = await confirm(id);
    expect(done.body).toMatchObject({ ok: true, status: 201, result: { name: 'github' } });
    expect(JSON.stringify(done.body)).not.toContain(SECRET);
    expect(store.injectableFor('agent-a').github).toMatchObject({
      env: { GITHUB_TOKEN: SECRET },
    });
    expect((await confirm(id)).status).toBe(404);
  });

  it('re-checks the owner on the confirm: an owner replaced meanwhile writes nothing', async () => {
    const id = heldId(await post());
    state.notTheOwner = true;
    const res = await confirm(id);
    expect(res.body).toMatchObject({ ok: true, status: 403 });
    expect(store.list()).toEqual([]);
  });

  it('answers a refusal at the confirm with the store’s own words', async () => {
    const id = heldId(await post());
    await store.add(stored());
    const res = await confirm(id);
    expect(res.body).toMatchObject({ ok: true, status: 409, result: { code: 'name_taken' } });
  });

  it('refuses before the password what a password could not change', async () => {
    await store.add(stored());
    expect((await post()).status).toBe(409);
    const unsafe = await post({
      ...SERVER,
      name: 'other',
      connection: { ...SERVER.connection, env: { LD_PRELOAD: 'x' } },
    });
    expect(unsafe.status).toBe(422);
  });
});

describe('secrets', () => {
  it('reach no statement, sentence, note, audit row or log line, held or confirmed', async () => {
    const server = {
      ...SERVER,
      connection: {
        transport: 'stdio',
        command: 'npx',
        args: [
          '-y',
          '@made-up/server',
          `--token=${ARG_SECRET}`,
          '--api-key',
          ARG_SECRET,
          `postgres://user:${ARG_SECRET}@db.example.test/app?sslkey=${ARG_SECRET}`,
        ],
        env: { GITHUB_TOKEN: SECRET },
      },
    };
    const id = heldId(await post(server));
    const entry = peekHeldStepUp(id)!;
    const everyWord = JSON.stringify([entry.statement, entry.reason, entry.notes, await sheet(id)]);
    expect(everyWord).not.toContain(SECRET);
    expect(everyWord).not.toContain(ARG_SECRET);
    await confirm(id);
    const said = JSON.stringify([
      vi.mocked(recordAudit).mock.calls,
      vi.mocked(logger.info).mock.calls,
    ]);
    expect(said).not.toContain(SECRET);
    expect(said).not.toContain(ARG_SECRET);
  });

  it('canary: a secret anywhere reaches no 428, view, audit row or log line (Security Must 4)', async () => {
    const canary = (where: string) => `canary-${where}-made-up`;
    const stdio = await post({
      name: 'stdio-canary',
      enabled: true,
      connection: {
        transport: 'stdio',
        command: 'npx',
        args: [
          '-y',
          '@made-up/server',
          `--token=${canary('flag')}`,
          `postgres://user:${canary('userinfo')}@db.example.test/app?sslkey=${canary('query')}`,
          '--header',
          `Authorization: Bearer ${canary('header-arg')}`,
          `--header=Authorization: Bearer ${canary('header-eq')}`,
          '-H',
          `X-Api-Key: ${canary('dash-h')}`,
          `API_KEY=${canary('assign')}`,
          '--env',
          `TOKEN=${canary('env-flag')}`,
          `Bearer ${canary('bearer')}`,
        ],
        env: { MADE_UP_TOKEN: canary('env'), LOG_TARGET: canary('plain-env') },
      },
    });
    const remote = await post({
      name: 'remote-canary',
      enabled: true,
      connection: {
        transport: 'http',
        url: `https://user:${canary('url-userinfo')}@mcp.example.test/${canary('url-path')}?key=${canary('url-query')}`,
        headers: { Authorization: canary('header'), 'X-Plain': canary('plain-header') },
      },
    });
    const ids = [heldId(stdio), heldId(remote)];
    const views = await Promise.all(ids.map(sheet));
    for (const id of ids) await confirm(id);
    const everywhere = JSON.stringify([
      stdio.body,
      remote.body,
      views,
      vi.mocked(recordAudit).mock.calls,
      vi.mocked(logger.info).mock.calls,
      vi.mocked(logger.warn).mock.calls,
      vi.mocked(logger.error).mock.calls,
    ]);
    const listed = await request(app()).get('/api/mcp-servers');
    expect(JSON.stringify(listed.body)).not.toContain('canary-');
    expect(everywhere).not.toContain('canary-');
    // What is shown is masked; what runs is not.
    expect(store.injectableFor('agent-a')['stdio-canary']).toMatchObject({
      args: expect.arrayContaining([`--token=${canary('flag')}`]),
      env: { MADE_UP_TOKEN: canary('env') },
    });
    expect(store.injectableFor('agent-a')['remote-canary']).toMatchObject({
      url: expect.stringContaining(canary('url-query')),
    });
    expect(store.list().map((s) => s.name)).toEqual(['stdio-canary', 'remote-canary']);
  });

  it('a list and a write’s own answer mask args and address, like the sheet', async () => {
    await store.add(
      stored({
        connection: {
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@made-up/server', '--token', ARG_SECRET, `--api-key=${ARG_SECRET}`],
          env: {},
        },
      })
    );
    const [view] = store.list();
    expect(view!.args).toEqual(['-y', '@made-up/server', '--token', '•••', '--api-key=•••']);
    const answer = await patch({ enabled: false });
    expect(JSON.stringify(answer.body)).not.toContain(ARG_SECRET);
  });

  it('a value masking by flag name misses stays out of the audited sentence', async () => {
    const id = heldId(
      await post({
        ...SERVER,
        connection: {
          ...SERVER.connection,
          args: ['-y', '@made-up/server', '-p', ARG_SECRET],
        },
      })
    );
    expect(peekHeldStepUp(id)!.reason).not.toContain(ARG_SECRET);
    await confirm(id);
    expect(JSON.stringify(vi.mocked(recordAudit).mock.calls)).not.toContain(ARG_SECRET);
  });

  it('the statement’s hash stays inside the held map (Security Must 3)', async () => {
    const held = await post();
    const id = heldId(held);
    const { inputSha256 } = peekHeldStepUp(id)!.statement;
    const view = await sheet(id);
    await confirm(id);
    const everywhere = JSON.stringify([
      held.body,
      view,
      vi.mocked(recordAudit).mock.calls,
      vi.mocked(logger.info).mock.calls,
    ]);
    expect(everywhere).not.toContain(inputSha256);
  });

  it('the confirm writes the held body: a resend can’t reach the hold it replaced (Security Must 2)', async () => {
    const first = heldId(await post());
    const second = heldId(
      await post({
        ...SERVER,
        connection: {
          ...SERVER.connection,
          env: { GITHUB_TOKEN: 'swapped-made-up', LOG_LEVEL: 'info' },
        },
      })
    );
    // The first sheet's id no longer runs anything, so its person never approves the swap.
    expect((await confirm(first)).status).toBe(404);
    expect(store.list()).toEqual([]);
    await confirm(second);
    expect(store.injectableFor('agent-a').github).toMatchObject({
      env: { GITHUB_TOKEN: 'swapped-made-up' },
    });
  });

  it('a confirm’s own body changes nothing about what runs', async () => {
    const id = heldId(await post());
    const res = await request(app())
      .post(`/api/step-up/${id}/password`)
      .set('Origin', OWN_ORIGIN)
      .send({
        password: PASSWORD,
        name: 'other',
        connection: { transport: 'stdio', command: 'other', env: { GITHUB_TOKEN: 'swapped' } },
      });
    expect(res.body).toMatchObject({ ok: true, status: 201, result: { name: 'github' } });
    expect(store.injectableFor('agent-a').github).toMatchObject({
      command: 'npx',
      env: { GITHUB_TOKEN: SECRET },
    });
  });

  it('a replace never carries a stored secret to a new address (Security Must 1)', async () => {
    await store.add(
      stored({
        name: 'remote',
        connection: {
          transport: 'http',
          url: 'https://old.example.test',
          headers: { Authorization: SECRET },
        },
      })
    );
    const id = heldId(
      await request(app())
        .put('/api/mcp-servers/remote')
        .set('Origin', OWN_ORIGIN)
        .send({
          name: 'remote',
          enabled: true,
          connection: { transport: 'http', url: 'https://new.example.test' },
        })
    );
    await confirm(id);
    expect(store.injectableFor('agent-a').remote).toEqual({
      transport: 'http',
      url: 'https://new.example.test',
      headers: {},
    });
  });

  it('a hold with no browser session is refused once an owner exists (Security Must 7)', async () => {
    const res = await request(app({ userId: 'owner', credential: 'cookie' }))
      .post('/api/mcp-servers')
      .set('Origin', OWN_ORIGIN)
      .send(SERVER);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('not-a-person');
    expect(store.list()).toEqual([]);
  });

  it('strips control and direction characters from what the sheet says', async () => {
    const id = heldId(
      await post({
        ...SERVER,
        connection: { ...SERVER.connection, args: ['-y', 'made‮up\u0007-pkg', '--x​'] },
      })
    );
    const entry = peekHeldStepUp(id)!;
    expect(`${entry.reason}${entry.notes.join('')}`).not.toMatch(/\p{C}/u);
  });

  it('a held remote server keeps header values and URL credentials off the sheet', async () => {
    const id = heldId(
      await post({
        name: 'remote',
        enabled: true,
        connection: {
          transport: 'http',
          url: `https://user:${ARG_SECRET}@mcp.example.test/v1?key=${ARG_SECRET}`,
          headers: { Authorization: `Bearer ${SECRET}` },
        },
      })
    );
    const view = await sheet(id);
    expect(JSON.stringify(view)).not.toContain(SECRET);
    expect(JSON.stringify(view)).not.toContain(ARG_SECRET);
    expect(view.reason).toBe('Add remote (https://mcp.example.test) for all your agents.');
    expect(view.notes).toContain('Kept secret: Authorization');
    expect(view.notes.join()).not.toContain('Headers:');
  });

  it('the hash binds what runs, not a secret: a resend with a new secret replaces the hold', async () => {
    const first = heldId(await post());
    const second = heldId(
      await post({
        ...SERVER,
        connection: { ...SERVER.connection, env: { GITHUB_TOKEN: 'another', LOG_LEVEL: 'info' } },
      })
    );
    expect(peekHeldStepUp(first)).toBeUndefined();
    expect(peekHeldStepUp(second)).toBeDefined();
    await confirm(second);
    expect(store.injectableFor('agent-a').github).toMatchObject({
      env: { GITHUB_TOKEN: 'another' },
    });
  });
});

describe('what the sheet says', () => {
  it('names the package a runner runs, and says when it is not pinned', async () => {
    const view = await sheet(heldId(await post()));
    expect(view.kind).toBe('mcp-server.allow-global');
    expect(view.reason).toBe(
      'Add github (@modelcontextprotocol/server-github) for all your agents.'
    );
    expect(view.notes).toEqual([
      'Runs: npx -y @modelcontextprotocol/server-github',
      'Settings: LOG_LEVEL',
      'Kept secret: GITHUB_TOKEN',
      'Not pinned to a version. What runs can change later.',
    ]);
  });

  it('a pinned package has no unpinned line, and its version is in the sentence', async () => {
    const view = await sheet(
      heldId(
        await post({
          ...SERVER,
          connection: { ...SERVER.connection, args: ['-y', 'docs-search-mcp@1.3.0'] },
        })
      )
    );
    expect(view.reason).toContain('(docs-search-mcp@1.3.0)');
    expect(view.notes).not.toContain('Not pinned to a version. What runs can change later.');
  });

  it('never names a package a flag could swap for another', async () => {
    const view = await sheet(
      heldId(
        await post({
          ...SERVER,
          connection: { ...SERVER.connection, args: ['--package=made-up-other', 'trusted-name'] },
        })
      )
    );
    expect(view.reason).toBe('Add github (npx) for all your agents.');
    expect(view.notes[0]).toBe('Runs: npx --package=made-up-other trusted-name');
  });

  it('flags a secret header going over plain http to another computer', async () => {
    const remote = (url: string) => ({
      name: 'remote',
      enabled: true,
      connection: { transport: 'http', url, headers: { Authorization: SECRET } },
    });
    const line = 'This address isn’t encrypted, so Authorization travels in the clear.';
    expect((await sheet(heldId(await post(remote('http://mcp.example.test'))))).notes).toContain(
      line
    );
    for (const safe of [
      'https://mcp.example.test',
      'http://localhost:9000',
      'http://127.0.0.1:9000',
    ]) {
      expect((await sheet(heldId(await post(remote(safe))))).notes).not.toContain(line);
    }
  });

  it('says who is left out, and flags env names that change what loads', async () => {
    const view = await sheet(
      heldId(
        await post({
          ...SERVER,
          excludedAgents: ['agent-a', 'agent-b'],
          connection: { ...SERVER.connection, env: { NODE_OPTIONS: '--inspect' } },
        })
      )
    );
    expect(view.reason).toContain('for all your agents except 2.');
    expect(view.notes).toContain("NODE_OPTIONS changes what the program loads. Check it's yours.");
    expect(JSON.stringify(view)).not.toContain('--inspect');
  });

  it('marks the lines to look at twice, each still in its place among the notes', async () => {
    const flagged = await sheet(
      heldId(
        await post({
          ...SERVER,
          connection: { ...SERVER.connection, env: { NODE_OPTIONS: '--inspect' } },
        })
      )
    );
    expect(flagged.warnings).toEqual([
      "NODE_OPTIONS changes what the program loads. Check it's yours.",
    ]);
    expect(flagged.notes).toEqual(expect.arrayContaining(flagged.warnings!));
    const quiet = await sheet(heldId(await post()));
    expect(quiet.warnings).toBeUndefined();
    const plainHttp = await sheet(
      heldId(
        await post({
          name: 'remote',
          enabled: true,
          connection: {
            transport: 'http',
            url: 'http://mcp.example.test',
            headers: { Authorization: SECRET },
          },
        })
      )
    );
    expect(plainHttp.warnings).toEqual([
      'This address isn’t encrypted, so Authorization travels in the clear.',
    ]);
  });

  it('names every setting and header once, under one heading or the other', async () => {
    const stdio = await sheet(
      heldId(
        await post({
          ...SERVER,
          secretNames: ['MADE_UP_MARKED'],
          connection: {
            ...SERVER.connection,
            env: { GITHUB_TOKEN: SECRET, MADE_UP_MARKED: 'x', LOG_LEVEL: 'info', REGION: 'eu' },
          },
        })
      )
    );
    expect(stdio.notes).toContain('Settings: LOG_LEVEL, REGION');
    expect(stdio.notes).toContain('Kept secret: GITHUB_TOKEN, MADE_UP_MARKED');
    const mixed = await sheet(
      heldId(
        await post({
          name: 'remote',
          enabled: true,
          connection: {
            transport: 'http',
            url: 'https://mcp.example.test',
            headers: { Authorization: SECRET, 'X-Region': 'eu' },
          },
        })
      )
    );
    expect(mixed.notes).toContain('Headers: X-Region');
    expect(mixed.notes).toContain('Kept secret: Authorization');
    const onlyPlain = await sheet(
      heldId(
        await post({
          ...SERVER,
          connection: { ...SERVER.connection, env: { REGION: 'eu' } },
        })
      )
    );
    expect(onlyPlain.notes).toContain('Settings: REGION');
    expect(onlyPlain.notes.join()).not.toContain('Kept secret');
  });
});

describe('a proof covers one version of what runs (Security, Pin to {v})', () => {
  const PINNED = {
    ...SERVER,
    connection: { ...SERVER.connection, args: ['-y', '@modelcontextprotocol/server-github@1.3.0'] },
  };

  it('a proof for the unpinned action adds only the unpinned command', async () => {
    const unpinned = heldId(await post());
    const pinned = heldId(await post(PINNED));
    expect(unpinned).not.toBe(pinned);
    await confirm(unpinned);
    expect(store.list()[0]!.args).toEqual(SERVER.connection.args);
    expect((await confirm(pinned)).body).toMatchObject({ status: 409 });
    expect(store.list()[0]!.args).toEqual(SERVER.connection.args);
  });

  it('a proof for the pinned action adds only the pinned command', async () => {
    const unpinned = heldId(await post());
    const pinned = heldId(await post(PINNED));
    await confirm(pinned);
    expect(store.list()[0]!.args).toEqual(PINNED.connection.args);
    expect((await confirm(unpinned)).body).toMatchObject({ status: 409 });
    expect(store.list()[0]!.args).toEqual(PINNED.connection.args);
  });
});

describe('replacing a server', () => {
  it('holds it, leaves the old one running, then replaces it', async () => {
    await store.add(stored());
    const put = () => request(app()).put('/api/mcp-servers/github').set('Origin', OWN_ORIGIN);
    const res = await put().send({
      ...SERVER,
      connection: { ...SERVER.connection, env: { GITHUB_TOKEN: 'typed-again' } },
    });
    expect(res.status).toBe(428);
    expect(store.injectableFor('agent-a').github).toMatchObject({
      env: { GITHUB_TOKEN: SECRET },
    });
    const id = heldId(res);
    const view = await sheet(id);
    expect(view.reason).toContain('Change github');
    expect(view.notes).toContain('New values for: GITHUB_TOKEN');
    expect((await confirm(id)).body).toMatchObject({ ok: true, status: 200 });
    expect(store.injectableFor('agent-a').github).toMatchObject({
      env: { GITHUB_TOKEN: 'typed-again' },
    });
  });

  it('refuses a server that is not there before asking', async () => {
    const res = await request(app())
      .put('/api/mcp-servers/github')
      .set('Origin', OWN_ORIGIN)
      .send(SERVER);
    expect(res.status).toBe(404);
  });
});

describe('switching a server', () => {
  it('refuses anything but the two switches, so an off server can’t change what later turns on (Security Must 5)', async () => {
    await store.add(stored({ enabled: false }));
    const res = await patch({
      enabled: false,
      connection: { transport: 'stdio', command: 'made-up-other', args: [], env: {} },
    });
    expect(res.status).toBe(400);
    expect(store.list()[0]!.command).toBe('npx');
    expect((await patch({ enabled: true, name: 'other' })).status).toBe(400);
    const view = await sheet(heldId(await patch({ enabled: true })));
    expect(view.notes[0]).toBe('Runs: npx -y @modelcontextprotocol/server-github');
  });

  it('turning it on is held; the sheet reads what is stored', async () => {
    await store.add(stored({ enabled: false }));
    const res = await patch({ enabled: true });
    expect(res.status).toBe(428);
    expect(store.list()[0]!.enabled).toBe(false);
    const id = heldId(res);
    const view = await sheet(id);
    expect(view.reason).toBe(
      'Turn on github (@modelcontextprotocol/server-github) for all your agents.'
    );
    expect(view.notes.at(-1)).toBe('All your agents get it.');
    expect(JSON.stringify(view)).not.toContain('file:');
    expect((await confirm(id)).body).toMatchObject({ ok: true, status: 200 });
    expect(store.list()[0]!.enabled).toBe(true);
  });

  it('taking an agent off the exclusions of a running server is held', async () => {
    await store.add(stored({ excludedAgents: ['agent-a', 'agent-b'] }));
    const res = await patch({ excludedAgents: ['agent-b'] });
    expect(res.status).toBe(428);
    const id = heldId(res);
    const view = await sheet(id);
    expect(view.reason).toBe('Let Made up Scout use github.');
    expect(view.notes.at(-1)).toBe('Made up Scout gets it too.');
    expect(store.list()[0]!.excludedAgents).toEqual(['agent-a', 'agent-b']);
    await confirm(id);
    expect(store.list()[0]!.excludedAgents).toEqual(['agent-b']);
  });

  it('cuts a long agent name, since an agent picks its own', async () => {
    agentNames['agent-long'] = { name: 'x'.repeat(60) };
    await store.add(stored({ excludedAgents: ['agent-long', 'agent-b'] }));
    const res = await patch({ excludedAgents: ['agent-b'] });
    expect((await sheet(heldId(res))).reason).toBe(`Let ${'x'.repeat(39)}… use github.`);
  });

  it('shows the real name beside a display name that says something else', async () => {
    const reasonFor = async (names: { name: string; displayName?: string }) => {
      agentNames['agent-x'] = names;
      resetHeldStepUpsForTests();
      await store.remove('github').catch(() => undefined);
      await store.add(stored({ excludedAgents: ['agent-x', 'agent-b'] }));
      return sheet(heldId(await patch({ excludedAgents: ['agent-b'] })));
    };
    // The same name in other letter case: nothing to tell apart.
    expect((await reasonFor({ name: 'scout', displayName: 'Scout' })).reason).toBe(
      'Let Scout use github.'
    );
    // An agent can call itself anything, so its real name stays in view.
    const different = await reasonFor({ name: 'scout-2', displayName: 'Scout' });
    expect(different.reason).toBe('Let Scout (scout-2) use github.');
    expect(different.notes.at(-1)).toBe('Scout (scout-2) gets it too.');
    // A long one is cut, and a control character doesn't reach the sheet.
    const long = await reasonFor({ name: 'scout-2', displayName: `Ow\u202Ener ${'x'.repeat(60)}` });
    expect(long.reason).toBe(`Let Ow ner ${'x'.repeat(32)}… (scout-2) use github.`);
    expect((await reasonFor({ name: 'scout-2', displayName: '' })).reason).toBe(
      'Let scout-2 use github.'
    );
  });

  it('names no one when it can’t, and counts when it adds several', async () => {
    await store.add(stored({ excludedAgents: ['agent-a', 'agent-b', 'agent-c', 'agent-d'] }));
    const one = await patch({ excludedAgents: ['agent-a', 'agent-c', 'agent-d'] });
    const oneView = await sheet(heldId(one));
    expect(oneView.reason).toBe('Let one more agent use github.');
    expect(oneView.notes.at(-1)).toBe('One more agent gets it.');
    const two = await patch({ excludedAgents: ['agent-a', 'agent-b'] });
    expect((await sheet(heldId(two))).reason).toBe('Let 2 more agents use github.');
  });

  it('says all agents get it when a PATCH turns a server on and clears its exclusions', async () => {
    await store.add(stored({ enabled: false, excludedAgents: ['agent-a', 'agent-b'] }));
    const view = await sheet(heldId(await patch({ enabled: true, excludedAgents: [] })));
    expect(view.reason).toContain('Turn on github');
    expect(view.notes.at(-1)).toBe('All your agents get it.');
  });

  it('going from All except… to All agents on a running server is held', async () => {
    await store.add(stored({ excludedAgents: ['agent-a', 'agent-b'] }));
    const res = await patch({ excludedAgents: [] });
    expect(res.status).toBe(428);
    const id = heldId(res);
    const view = await sheet(id);
    expect(view.reason).toBe('Give github to all your agents.');
    expect(view.notes[0]).toBe('Runs: npx -y @modelcontextprotocol/server-github');
    expect(view.notes.at(-1)).toBe('2 more agents get it.');
    expect(store.list()[0]!.excludedAgents).toEqual(['agent-a', 'agent-b']);
    await confirm(id);
    expect(store.list()[0]!.excludedAgents).toEqual([]);
  });

  it('what only takes power away asks for nothing', async () => {
    await store.add(stored());
    expect((await patch({ excludedAgents: ['agent-a'] })).status).toBe(200);
    expect((await patch({ enabled: true })).status).toBe(200);
    expect((await patch({ enabled: false })).status).toBe(200);
    const removed = await request(app())
      .delete('/api/mcp-servers/github')
      .set('Origin', OWN_ORIGIN);
    expect(removed.status).toBe(204);
  });

  it('changing the exclusions of a server that is off is not held; turning it on then is', async () => {
    await store.add(stored({ enabled: false, excludedAgents: ['agent-a'] }));
    expect((await patch({ excludedAgents: [] })).status).toBe(200);
    expect((await patch({ enabled: true })).status).toBe(428);
  });

  it('a server that changed since the sheet was shown answers 409 and writes nothing', async () => {
    await store.add(stored({ enabled: false, excludedAgents: ['agent-a'] }));
    const id = heldId(await patch({ enabled: true }));
    expect((await patch({ excludedAgents: [] })).status).toBe(200);
    const res = await confirm(id);
    expect(res.body).toMatchObject({ ok: true, status: 409, result: { code: 'changed' } });
    expect(store.list()[0]!.enabled).toBe(false);
  });
});

describe('a mask sent back', () => {
  it('is refused before the password, so a hidden value never runs', async () => {
    const res = await post({
      ...SERVER,
      connection: { ...SERVER.connection, args: ['-y', '@made-up/server', '--token=•••'] },
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('masked_value');
    expect(store.list()).toEqual([]);
  });
});

describe('removing a server', () => {
  it('says so when the server went but its saved key could not be deleted', async () => {
    store = new GlobalMcpStore(home, {
      ...secrets(),
      delete: async () => {
        throw new Error('made-up store failure');
      },
    });
    await store.add(stored());
    const res = await request(app()).delete('/api/mcp-servers/github').set('Origin', OWN_ORIGIN);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      code: 'secret_left',
      error: "github is removed, but its saved key couldn't be deleted.",
    });
    expect(store.list()).toEqual([]);
    expect(store.injectableFor('agent-a')).toEqual({});
  });
});

describe('with no owner yet', () => {
  beforeEach(() => {
    state.owner = null;
  });

  it('the person at this computer goes on with no sheet', async () => {
    const res = await request(app(null)).post('/api/mcp-servers').send(SERVER);
    expect(res.status).toBe(201);
    const on = await request(app(null)).patch('/api/mcp-servers/github').send({ enabled: true });
    expect(on.status).toBe(200);
  });

  it('a program with a key is refused and nothing is written', async () => {
    const res = await request(app(null))
      .post('/api/mcp-servers')
      .set('Authorization', 'Bearer dork_key')
      .send(SERVER);
    expect(res.status).toBe(403);
    expect(store.list()).toEqual([]);
  });
});
