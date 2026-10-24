/**
 * The app's side of the `administer` pairing scope (DOR-3005): it asks only a space that offers
 * the scope, keeps the manage credential apart from the connection grant, hands it only to the
 * person-only loader, and drops it with its connection.
 */
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EncryptedFileCredentialStore } from '../../../../core/credential-provider.js';
import { RemoteConnectionNotFoundError, RemoteConnectionStore } from '../../connection-store.js';
import { RemoteCommunityPairingService } from '../../pairing-service.js';
import { parseCommunityOrigin } from '../../pinned-origin.js';
import { RemoteAdministerCredentials } from '../administer-credentials.js';
import { CONNECTION_SCOPES, pairingScopes } from '../pairing-scopes.js';

const communityId = randomUUID();
const qualified = `/api/v1/communities/${communityId}`;
const GRANT = 'connection-grant-token';
const MANAGE = 'manage-credential-token';
let server: Server;
let origin = '';
let directory = '';
/** What the fake space says to `/features`: an offer, a 404 like an older space, or junk. */
let features: 'offers' | 'absent' | 'junk' = 'offers';
/** Whether the fake space's exchange returns a manage credential. */
let issues = true;
/** The scopes each pairing start asked for. */
const asked: string[][] = [];

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    res.setHeader('content-type', 'application/json');
    const send = (value: unknown, status = 200) => {
      res.statusCode = status;
      res.end(JSON.stringify(value));
    };
    if (req.url === `${qualified}/community`)
      return send({
        id: communityId,
        name: 'Studio',
        description: null,
        createdAt: new Date().toISOString(),
      });
    if (req.url === `${qualified}/features`) {
      if (features === 'absent') return send({ code: 'NOT_FOUND', message: 'No.' }, 404);
      if (features === 'junk') return send({ nope: true });
      return send({ features: { agentDms: true, administer: true } });
    }
    if (req.url === `${qualified}/pairings/start`) {
      asked.push(body.scopes);
      const pairingId = randomUUID();
      return send(
        {
          pairingId,
          approvalUrl: `${origin}/c/${communityId}/pairing?pairingId=${pairingId}`,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
        201
      );
    }
    if (req.url === `${qualified}/pairings/poll`)
      return send({ status: 'approved', code: 'one-time-code' });
    if (req.url === `${qualified}/pairings/exchange`)
      return send({
        token: GRANT,
        ...(issues ? { administerToken: MANAGE } : {}),
        grant: {
          id: randomUUID(),
          memberId: 'person-id',
          installName: 'Studio Mac',
          scopes: ['read', 'post', 'enroll-agent'],
          lifecycle: 'active',
          capabilities: { read: true, post: true, enrollAgent: true, stream: true },
          createdAt: new Date().toISOString(),
        },
      });
    if (req.url === `${qualified}/me/connection` && req.method === 'DELETE') {
      res.statusCode = 204;
      return res.end();
    }
    send({ code: 'NOT_FOUND', message: 'No.' }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = await mkdtemp(join(tmpdir(), 'community-administer-'));
  features = 'offers';
  issues = true;
  asked.length = 0;
});

/** One app: its connection store, its manage credentials and its pairing service. */
function app() {
  const store = new RemoteConnectionStore(directory);
  const administer = new RemoteAdministerCredentials(
    store,
    new EncryptedFileCredentialStore(directory)
  );
  const service = new RemoteCommunityPairingService(
    store,
    undefined,
    undefined,
    {},
    undefined,
    undefined,
    undefined,
    {
      scopes: (pinned, id) => pairingScopes(pinned, id),
      keep: (ref, owner, token) => administer.save(ref, owner, token),
    }
  );
  return { store, administer, service };
}

async function connect(owner = 'owner-a') {
  const parts = app();
  const started = await parts.service.start(owner, `${origin}/c/${communityId}`, 'Studio Mac');
  const polled = await parts.service.poll(started.connection.ref, owner);
  expect(polled.status).toBe('connected');
  return { ...parts, ref: started.connection.ref, owner };
}

describe('what a pairing asks for', () => {
  it('asks for administer only from a space that offers it', async () => {
    // Purpose: fails if an older space, which refuses an unknown scope, is ever asked for it.
    await app().service.start('owner-a', `${origin}/c/${communityId}`, 'One');
    features = 'absent';
    await app().service.start('owner-a', `${origin}/c/${communityId}`, 'Two');
    features = 'junk';
    await app().service.start('owner-a', `${origin}/c/${communityId}`, 'Three');
    expect(asked).toEqual([
      ['read', 'post', 'enroll-agent', 'administer'],
      [...CONNECTION_SCOPES],
      [...CONNECTION_SCOPES],
    ]);
  });

  it('asks for the connection’s own scopes when the space cannot be reached', async () => {
    expect(await pairingScopes(parseCommunityOrigin('http://127.0.0.1:9'), communityId)).toEqual([
      ...CONNECTION_SCOPES,
    ]);
  });

  it('asks for exactly what it always did without the administer wiring', async () => {
    // Purpose: fails if a pairing service built without it changes what an older space sees.
    const store = new RemoteConnectionStore(directory);
    await new RemoteCommunityPairingService(store).start(
      'owner-a',
      `${origin}/c/${communityId}`,
      'Plain'
    );
    expect(asked).toEqual([['read', 'post', 'enroll-agent']]);
  });
});

describe('where the manage credential is kept', () => {
  it('keeps it apart from the grant, and gives it only to the person loader', async () => {
    // Purpose: fails if the manage credential is stored as, or beside, the connection grant, or if
    // the grant's loader can return it (security rule 2).
    const { store, administer, ref, owner } = await connect();
    expect(await store.personalToken(ref, owner)).toBe(GRANT);
    expect(await administer.forPerson(ref, owner)).toBe(MANAGE);
    const onDisk = await readFile(
      join(directory, 'communities', 'remote', 'connections.json'),
      'utf8'
    );
    expect(onDisk).not.toContain(MANAGE);
    expect(onDisk).not.toContain('administer');
    expect(await administer.state(ref, owner)).toEqual({
      canAdminister: true,
      administerAvailable: true,
    });
  });

  it('never gives it to another owner', async () => {
    const { administer, ref } = await connect();
    await expect(administer.forPerson(ref, 'owner-b')).rejects.toBeInstanceOf(
      RemoteConnectionNotFoundError
    );
    await expect(administer.state(ref, 'owner-b')).rejects.toBeInstanceOf(
      RemoteConnectionNotFoundError
    );
  });

  it('holds none when the space issued none, and says pairing again would offer it', async () => {
    // Purpose: fails if an existing read-only connection is told it can manage, or is not told it
    // could pair again to (the Settings tab's "Pair again to manage here.").
    issues = false;
    const { store, administer, ref, owner } = await connect();
    expect(await store.personalToken(ref, owner)).toBe(GRANT);
    await expect(administer.forPerson(ref, owner)).rejects.toBeInstanceOf(
      RemoteConnectionNotFoundError
    );
    expect(await administer.state(ref, owner)).toEqual({
      canAdminister: false,
      administerAvailable: true,
    });
    features = 'absent';
    const older = await connect('owner-c');
    expect(await older.administer.state(older.ref, older.owner)).toEqual({
      canAdminister: false,
      administerAvailable: false,
    });
  });

  it('drops it when the connection is removed or must reconnect', async () => {
    // Purpose: fails if the manage credential outlives its connection here.
    const first = await connect();
    await first.service.disconnect(first.ref, first.owner);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const raw = new EncryptedFileCredentialStore(directory);
    expect(await raw.get(`community:${first.ref}:administer`)).toBeNull();

    const second = await connect('owner-d');
    await second.store.requireReconnect(second.ref, second.owner);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await raw.get(`community:${second.ref}:administer`)).toBeNull();
    await expect(second.administer.forPerson(second.ref, second.owner)).rejects.toBeInstanceOf(
      RemoteConnectionNotFoundError
    );
  });
});

describe('who may load it', () => {
  it('is reached only by the wiring and person-only routes', async () => {
    // Purpose: fails if an agent path, tool or adapter starts reaching the manage credential,
    // through its module or its accessor (security rule 3). Add a file here only if every route
    // in it is guarded by `resolveCommunityOwner`.
    const root = join(import.meta.dirname, '../../../../..');
    const reach = {
      module: /administer-credentials(\.js)?['"]/u,
      accessor: /\bgetRemoteAdministerCredentials\b/u,
    };
    const found: Record<keyof typeof reach, string[]> = { module: [], accessor: [] };
    async function walk(dir: string) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__' && entry.name !== 'node_modules') await walk(path);
        } else if (/\.tsx?$/u.test(entry.name)) {
          const text = await readFile(path, 'utf8');
          for (const key of ['module', 'accessor'] as const)
            if (reach[key].test(text)) found[key].push(relative(root, path));
        }
      }
    }
    await walk(root);
    expect(found.module.sort()).toEqual([
      'routes/community-administer.ts',
      'services/communities/remote/state.ts',
    ]);
    expect(found.accessor.sort()).toEqual([
      'routes/community-connections.ts',
      'services/communities/remote/state.ts',
    ]);
  });
});
