import { createServer, request, type Server } from 'node:http';
import { type Socket } from 'node:net';
import { once } from 'node:events';
import { expect, it, onTestFinished, vi } from 'vitest';
import { createBrokerIssuer, type PreparedRunReceiver } from '../issuer.js';
import { createPreparedPrivateBroker } from '../broker.js';
import { createNodeBrokerTransport } from '../node-transport.js';
import type { BrokerTransport, OwnedSocket } from '../transport.js';

async function origin(status = 200) {
  const sockets = new Set<Socket>();
  let connections = 0;
  const headers: Record<string, unknown>[] = [];
  const server: Server = createServer((incoming, response) => {
    headers.push(incoming.headers);
    response.statusCode = status;
    if (status === 401) response.setHeader('WWW-Authenticate', 'Basic realm="Origin"');
    response.end('actual origin');
  });
  server.on('connection', (socket) => {
    connections++;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  let closing: Promise<void> | undefined;
  onTestFinished(
    () =>
      (closing ??= new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }))
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture origin');
  return {
    url: `http://127.0.0.1:${address.port}/`,
    port: address.port,
    headers,
    get connections() {
      return connections;
    },
  };
}

async function cold(
  options: {
    limits?: Parameters<typeof createBrokerIssuer>[0]['limits'];
    ttl?: number;
    holdSocketClose?: boolean;
    seal?: () => readonly { address: string; port: number }[];
    missingSeal?: 'undefined' | 'null';
  } = {}
) {
  let ready = false,
    time = 0,
    epoch = 1,
    revision = 1,
    inventoryRevision = 1,
    owner = true;
  let authorityRead: (() => Promise<ReturnType<typeof observation>>) | undefined;
  const binding = {
    ownerId: 'owner',
    workspaceId: 'workspace',
    browserId: 'browser',
    browserGeneration: 1,
  };
  const receiver: PreparedRunReceiver = Object.freeze({
    browserId: 'browser',
    browserGeneration: 1,
    isAuthorityCurrent: () => ready,
  });
  const observation = () => {
    if (!ready || !owner) throw new Error('Actual owner not ready');
    return {
      binding,
      ownerExists: true as const,
      retainedRun: true as const,
      grantsCurrent: true as const,
      custodyKnown: true as const,
      runtimePolicyKnown: true as const,
      runtimeIdentity: 'runtime',
      authorizationEpoch: epoch,
      policyRevision: revision,
      inventoryRevision,
      monotonicNow: time,
      utcNow: 1000 + time,
      utcExpiresAt: 100000 + time,
    };
  };
  const current = vi.fn(observation),
    read = vi.fn(async () => (authorityRead ? authorityRead() : observation()));
  const issuer = createBrokerIssuer({
    now: () => time,
    limits: options.limits,
    ports: {
      ...(options.seal
        ? {
            readPreparedPolicy: (_binding: unknown, original: PreparedRunReceiver) => {
              if (original !== receiver || !ready) throw new Error('Wrong original owner');
              if (options.missingSeal === 'undefined') return undefined as never;
              if (options.missingSeal === 'null') return null as never;
              const privateAdminEndpoints = options.seal!();
              inventoryRevision++;
              return {
                revision: 1,
                adminAuthorities: [],
                hostInterfaces: [],
                privateAdminEndpoints,
                resolver,
              };
            },
          }
        : {}),
      readCurrent: current,
      readAuthority: read,
      readInventory: () => ({
        revision: inventoryRevision,
        publicAuthoritiesKnown: true,
        localCoverageComplete: true,
        validUntil: time + 10000,
        protectedEndpoints: [],
        declaredInstances: ['main'],
        coveredInstances: ['main'],
      }),
    },
  });
  const run = issuer.prepareRun(
    binding,
    {
      runtimeIdentity: 'runtime',
      authorizationEpoch: 1,
      policyRevision: 1,
      inventoryRevision: 1,
      receiver,
    },
    options.ttl
  );
  const native = createNodeBrokerTransport();
  const originals: OwnedSocket[] = [];
  let releaseOriginal: (() => void) | undefined;
  const listen = vi.fn((input: Parameters<BrokerTransport['listen']>[0]) =>
    native.listen({
      ...input,
      onSocket: (slot, socket) => {
        originals.push(socket);
        if (options.holdSocketClose) {
          const original = socket.identity as Socket;
          const destroy = original.destroy.bind(original);
          releaseOriginal = () => {
            destroy();
          };
          original.destroy = () => original;
        }
        return input.onSocket(slot, socket);
      },
    })
  );
  const transport = { ...native, listen, dial: vi.fn(native.dial) };
  const resolver = vi.fn(async () => ({ a: ['8.8.8.8'], aaaa: [], cname: [] }));
  const broker = createPreparedPrivateBroker({
    issuer,
    run,
    receiver,
    transport,
    policy: {
      revision: 1,
      adminAuthorities: [],
      hostInterfaces: [],
      privateAdminEndpoints: [],
      resolver,
    },
  });
  onTestFinished(async () => {
    releaseOriginal?.();
    await broker.close();
  });
  const descriptor = await broker.start();
  return {
    issuer,
    run,
    receiver,
    broker,
    descriptor,
    transport,
    resolver,
    current,
    read,
    originals,
    ready: () => {
      ready = true;
    },
    setTime: (value: number) => {
      time = value;
    },
    setEpoch: (value: number) => {
      epoch = value;
    },
    setRevision: (value: number) => {
      revision = value;
    },
    setInventory: (value: number) => {
      inventoryRevision = value;
    },
    invalidateOwner: () => {
      owner = false;
    },
    deferAuthority: (value: typeof authorityRead) => {
      authorityRead = value;
    },
    releaseOriginal: () => releaseOriginal?.(),
  };
}

async function http(
  f: Awaited<ReturnType<typeof cold>>,
  target: Awaited<ReturnType<typeof origin>>,
  auth?: string
) {
  return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>(
    (resolve, reject) => {
      const outgoing = request(
        f.descriptor.server,
        {
          path: target.url,
          headers: {
            Host: `127.0.0.1:${target.port}`,
            ...(auth === undefined ? {} : { 'Proxy-Authorization': auth }),
          },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
          incoming.once('error', reject);
          incoming.once('end', () =>
            resolve({
              status: incoming.statusCode!,
              body: Buffer.concat(chunks).toString(),
              headers: incoming.headers,
            })
          );
        }
      );
      onTestFinished(() => {
        outgoing.destroy();
      });
      outgoing.on('error', reject);
      outgoing.setTimeout(1000, () => outgoing.destroy(new Error('Fixture HTTP timeout')));
      outgoing.end();
    }
  );
}
const basic = (secret: string) => `Basic ${Buffer.from('dorkos:' + secret).toString('base64')}`;
async function waitFor(predicate: () => boolean) {
  const end = performance.now() + 1000;
  while (!predicate()) {
    if (performance.now() >= end) throw new Error('Fixture observation expired');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

it('owns one cold native listener and refuses all traffic, credentials, grants and permits before actual readiness', async () => {
  const target = await origin(),
    f = await cold();
  expect(f.issuer.snapshot(f.run).state).toBe('prepared');
  expect(f.broker.isCustodyKnown()).toBe(true);
  expect(f.issuer.ledger.snapshot()).toMatchObject({
    principals: 1,
    listeners: 1,
    circuits: 0,
    permits: 0,
  });
  for (const auth of [
    undefined,
    `Bearer ${f.descriptor.credential}`,
    basic(f.descriptor.credential),
    'Bearer wrong',
  ])
    await expect(http(f, target, auth)).rejects.toMatchObject({ code: 'ECONNRESET' });
  await waitFor(() => f.issuer.ledger.snapshot().unauthenticated === 0);
  expect(target.connections).toBe(0);
  expect(f.resolver).not.toHaveBeenCalled();
  expect(f.transport.dial).not.toHaveBeenCalled();
  expect(f.current).not.toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalled();
  expect(() => f.broker.grantLocal(target.url, 'http', 500)).toThrow('CLOSED');
  await expect(f.issuer.continuation(f.run, 0)).rejects.toThrow('CLOSED');
  await expect(f.issuer.revisionPermit(f.run, 0)).rejects.toThrow('PERMIT_REFUSED');
  expect(() => f.issuer.consume(f.run, 0, { kind: 'broker-permit' })).toThrow('CLOSED');
  expect(f.transport.listen).toHaveBeenCalledOnce();
  expect(await f.broker.close()).toBe(true);
  expect(f.issuer.ledger.snapshot().charged).toBe(0);
});

it('activates the exact original listener and credential once, forwards canonical Basic, then revokes its actual originals', async () => {
  const target = await origin(),
    f = await cold();
  const endpoint = f.descriptor.server;
  f.ready();
  await f.broker.activate(f.receiver);
  expect(f.issuer.snapshot(f.run).state).toBe('active');
  expect(f.issuer.ledger.snapshot()).toMatchObject({ principals: 1, listeners: 1 });
  expect(() => f.broker.grantLocal(f.descriptor.server, 'http', 500)).toThrow('AUTHORITY_REFUSED');
  expect(f.transport.dial).not.toHaveBeenCalled();
  f.broker.grantLocal(target.url, 'http', 500);
  const response = await http(f, target, basic(f.descriptor.credential));
  expect(response.body).toBe('actual origin');
  expect(target.headers[0]!['proxy-authorization']).toBeUndefined();
  expect(target.headers[0]!['authorization']).toBeUndefined();
  expect(JSON.stringify(target.headers)).not.toContain(f.descriptor.credential);
  expect(f.transport.listen).toHaveBeenCalledOnce();
  expect(f.descriptor.server).toBe(endpoint);
  expect(f.descriptor.credentials).toEqual({
    username: 'dorkos',
    password: f.descriptor.credential,
  });
  await expect(f.broker.activate(f.receiver)).rejects.toThrow('CLOSED');
  await expect(f.broker.start()).rejects.toThrow('CLOSED');
  f.issuer.revoke(f.run);
  expect(await f.broker.close()).toBe(true);
  expect(f.broker.isCustodyKnown()).toBe(false);
  expect(f.originals.every((socket) => socket.observedClosed)).toBe(true);
  expect(f.issuer.ledger.snapshot().charged).toBe(0);
});

it('emits a bounded ready-only 407 without DNS or an origin connection, and preserves origin 401 without leaking proxy credentials', async () => {
  const target = await origin(401),
    f = await cold();
  f.ready();
  await f.broker.activate(f.receiver);
  const challenge = await http(f, target);
  expect(challenge.status).toBe(407);
  expect(challenge.headers['proxy-authenticate']).toBe('Basic realm="DorkOS"');
  expect(target.connections).toBe(0);
  expect(f.resolver).not.toHaveBeenCalled();
  expect(f.transport.dial).not.toHaveBeenCalled();
  f.broker.grantLocal(target.url, 'http', 500);
  const response = await http(f, target, basic(f.descriptor.credential));
  expect(response.status).toBe(401);
  expect(response.headers['www-authenticate']).toBe('Basic realm="Origin"');
  expect(target.headers[0]!['authorization']).toBeUndefined();
  expect(target.headers[0]!['proxy-authorization']).toBeUndefined();
  expect(JSON.stringify(target.headers)).not.toContain(f.descriptor.credential);
});

it('never challenges a stale ready owner or connects an origin after its authority is lost', async () => {
  const target = await origin(),
    f = await cold();
  f.ready();
  await f.broker.activate(f.receiver);
  f.invalidateOwner();
  await expect(http(f, target)).rejects.toThrow();
  expect(target.connections).toBe(0);
  expect(f.resolver).not.toHaveBeenCalled();
  expect(f.transport.dial).not.toHaveBeenCalled();
  expect(await f.broker.close()).toBe(true);
});
