import { createServer, request, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { expect, it, onTestFinished, vi } from 'vitest';
import { createBrokerIssuer } from '../issuer.js';
import { createPrivateBroker } from '../broker.js';
import { createNodeBrokerTransport } from '../node-transport.js';

async function endpoint() {
  const sockets = new Set<Socket>();
  let connections = 0;
  const requests: Record<string, string | string[] | undefined>[] = [];
  const server: Server = createServer((incoming, response) => {
    requests.push(incoming.headers);
    response.end('owned origin');
  });
  server.on('connection', (socket) => {
    connections++;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= new Promise<void>((resolve, reject) => {
      for (const socket of sockets) socket.destroy();
      server.close((error) => (error ? reject(error) : resolve()));
    }));
  onTestFinished(close);
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('FIXTURE_LISTENER_UNAVAILABLE');
  return {
    server,
    requests,
    get connections() {
      return connections;
    },
    port: address.port,
    url: `http://127.0.0.1:${address.port}/`,
  };
}

async function fixture(protectedPort: number) {
  const binding = {
    ownerId: 'fixture-owner',
    workspaceId: 'fixture-workspace',
    browserId: 'fixture-browser',
    browserGeneration: 1,
  };
  // Injected fixture authority, distinct from the future live server producer.
  const authority = () => ({
    binding,
    ownerExists: true as const,
    retainedRun: true as const,
    grantsCurrent: true as const,
    custodyKnown: true as const,
    runtimePolicyKnown: true as const,
    runtimeIdentity: 'fixture-runtime',
    authorizationEpoch: 1,
    policyRevision: 1,
    inventoryRevision: 1,
    monotonicNow: 0,
    utcNow: 1000,
    utcExpiresAt: 301000,
  });
  const issuer = createBrokerIssuer({
    now: () => 0,
    ports: {
      readCurrent: authority,
      readAuthority: async () => authority(),
      readInventory: () => ({
        revision: 1,
        publicAuthoritiesKnown: true,
        localCoverageComplete: true,
        validUntil: 300000,
        protectedEndpoints: [{ address: '127.0.0.1', port: protectedPort }],
        declaredInstances: ['fixture-admin'],
        coveredInstances: ['fixture-admin'],
      }),
    },
  });
  const run = await issuer.retainRun(binding);
  const resolver = vi.fn(async () => ({ a: [], aaaa: [], cname: [] }));
  const broker = createPrivateBroker({
    issuer,
    run,
    transport: createNodeBrokerTransport(),
    policy: {
      revision: 1,
      adminAuthorities: [`http://127.0.0.1:${protectedPort}`],
      privateAdminEndpoints: [{ address: '127.0.0.1', port: protectedPort }],
      hostInterfaces: [],
      resolver,
    },
  });
  onTestFinished(async () => {
    expect(await broker.close()).toBe(true);
  });
  const descriptor = await broker.start();
  return { issuer, run, broker, resolver, descriptor };
}

it('forwards through the real broker without leaking credentials or reaching its protected endpoint', async () => {
  const allowed = await endpoint(),
    admin = await endpoint(),
    f = await fixture(admin.port);
  f.broker.grantLocal(allowed.url, 'http', 300000);
  const body = await new Promise<string>((resolve, reject) => {
    const outgoing = request(
      f.descriptor.server,
      {
        path: allowed.url,
        headers: {
          Host: `127.0.0.1:${allowed.port}`,
          'Proxy-Authorization': `Bearer ${f.descriptor.credential}`,
        },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.once('error', reject);
        incoming.once('end', () => resolve(Buffer.concat(chunks).toString()));
      }
    );
    outgoing.once('error', reject);
    outgoing.setTimeout(2000, () => outgoing.destroy(new Error('FIXTURE_REQUEST_TIMEOUT')));
    onTestFinished(() => {
      outgoing.destroy();
    });
    outgoing.end();
  });
  expect(body).toBe('owned origin');
  expect(allowed.requests).toHaveLength(1);
  expect(allowed.requests[0]!['proxy-authorization']).toBeUndefined();
  expect(JSON.stringify(allowed.requests)).not.toContain(f.descriptor.credential);
  expect(() => f.broker.grantLocal(admin.url, 'http', 300000)).toThrow('AUTHORITY_REFUSED');
  await expect(
    new Promise<void>((resolve, reject) => {
      const forbidden = request(
        f.descriptor.server,
        {
          path: admin.url,
          headers: {
            Host: `127.0.0.1:${admin.port}`,
            'Proxy-Authorization': `Bearer ${f.descriptor.credential}`,
          },
        },
        () => resolve()
      );
      forbidden.once('error', reject);
      forbidden.setTimeout(2000, () =>
        forbidden.destroy(new Error('FIXTURE_FORBIDDEN_REQUEST_TIMEOUT'))
      );
      onTestFinished(() => {
        forbidden.destroy();
      });
      forbidden.end();
    })
  ).rejects.toMatchObject({ code: 'ECONNRESET' });
  expect(admin.requests).toHaveLength(0);
  expect(admin.connections).toBe(0);
  expect(f.resolver).not.toHaveBeenCalled();
});

it('revocation closes an actual CONNECT client and releases its original circuit and listener', async () => {
  const allowed = await endpoint(),
    admin = await endpoint(),
    f = await fixture(admin.port);
  f.broker.grantLocal(`https://127.0.0.1:${allowed.port}/`, 'opaque-connect', 300000);
  const brokerPort = Number(new URL(f.descriptor.server).port);
  const client = connect({ host: '127.0.0.1', port: brokerPort });
  const closed = once(client, 'close');
  onTestFinished(() => {
    client.destroy();
  });
  client.setTimeout(2000, () => client.destroy(new Error('FIXTURE_TUNNEL_TIMEOUT')));
  await once(client, 'connect');
  const response = once(client, 'data');
  client.write(
    `CONNECT 127.0.0.1:${allowed.port} HTTP/1.1\r\nHost: 127.0.0.1:${allowed.port}\r\nProxy-Authorization: Bearer ${f.descriptor.credential}\r\n\r\n`
  );
  expect(String((await response)[0])).toContain('200 Connection Established');
  f.issuer.revoke(f.run);
  await closed;
  expect(await f.broker.close()).toBe(true);
  expect(f.broker.status().ledger.charged).toBe(0);
  expect(admin.requests).toHaveLength(0);
  expect(f.resolver).not.toHaveBeenCalled();
});

it('preserves distinct origin Set-Cookie fields through the actual Node broker', async () => {
  const allowed = await endpoint(),
    admin = await endpoint(),
    f = await fixture(admin.port);
  const cookies = [
    'fixture_a=one; Path=/; HttpOnly',
    'fixture_b=two; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/',
  ];
  allowed.server.prependListener('request', (_incoming, response) =>
    response.setHeader('Set-Cookie', cookies)
  );
  f.broker.grantLocal(allowed.url, 'http', 300000);
  const received = await new Promise<string[] | undefined>((resolve, reject) => {
    const outgoing = request(
      f.descriptor.server,
      {
        path: allowed.url,
        headers: {
          Host: `127.0.0.1:${allowed.port}`,
          'Proxy-Authorization': `Bearer ${f.descriptor.credential}`,
        },
      },
      (incoming) => {
        incoming.resume();
        incoming.once('error', reject);
        incoming.once('end', () => resolve(incoming.headers['set-cookie']));
      }
    );
    outgoing.once('error', reject);
    outgoing.setTimeout(2000, () => outgoing.destroy(new Error('FIXTURE_REQUEST_TIMEOUT')));
    onTestFinished(() => {
      outgoing.destroy();
    });
    outgoing.end();
  });
  expect(received).toEqual(cookies);
});
