import { createServer, request, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { once } from 'node:events';
import { expect, it, onTestFinished, vi } from 'vitest';
import { createBrokerIssuer } from '../issuer.js';
import { createPrivateBroker } from '../broker.js';
import { createNodeBrokerTransport } from '../node-transport.js';
import { createFixtureOriginCustody } from '../live/fixture-origin-custody.js';

async function endpoint(port = 0) {
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
  server.listen(port, '127.0.0.1');
  await listening;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('FIXTURE_LISTENER_UNAVAILABLE');
  return {
    server,
    close,
    requests,
    get connections() {
      return connections;
    },
    port: address.port,
    url: `http://127.0.0.1:${address.port}/`,
  };
}

async function fixture(
  protectedPort: number,
  check: (binding: {
    ownerId: string;
    workspaceId: string;
    browserId: string;
    browserGeneration: number;
  }) => void
) {
  const binding = {
    ownerId: 'fixture-owner',
    workspaceId: 'fixture-workspace',
    browserId: 'fixture-browser',
    browserGeneration: 1,
  };
  // Injected fixture authority, distinct from the future live server producer.
  const authority = () => {
    check(binding);
    return {
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
    };
  };
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
  return { issuer, run, broker, resolver, descriptor, binding };
}

it('revokes real local forwarding before original close acknowledgement and refuses same-port replacement', async () => {
  const origins = createFixtureOriginCustody();
  const admin = await endpoint(),
    original = await endpoint();
  const f = await fixture(admin.port, origins.check);
  const url = origins.grant(original.server, f.binding, f.broker, 300000);
  const forward = () =>
    new Promise<string>((resolve, reject) => {
      const outgoing = request(
        f.descriptor.server,
        {
          path: url,
          headers: {
            Host: `127.0.0.1:${original.port}`,
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
  expect(await forward()).toBe('owned origin');
  expect(original.requests).toHaveLength(1);
  const closure = original.close(); // listening=false immediately, before actual close event.
  await closure;
  const replacement = await endpoint(original.port);
  await expect(forward()).rejects.toThrow();
  expect(replacement.connections).toBe(0);
  expect(replacement.requests).toHaveLength(0);
  expect(() => origins.url(original.server, f.binding)).toThrow('AUTHORITY_REFUSED');
});

it('refuses closing original before its asynchronous close event', async () => {
  const origins = createFixtureOriginCustody(),
    original = await endpoint();
  const binding = {
    ownerId: 'owner',
    workspaceId: 'workspace',
    browserId: 'browser',
    browserGeneration: 1,
  };
  const revokeLocal = vi.fn();
  origins.grant(original.server, binding, { grantLocal: vi.fn(), revokeLocal }, 1000);
  const closure = original.close();
  expect(() => origins.check(binding)).toThrow('AUTHORITY_REFUSED');
  expect(revokeLocal).toHaveBeenCalled();
  await closure;
});

it('separately binds HTTP and WS consent to the same original listener and revokes both on close', async () => {
  const origins = createFixtureOriginCustody(),
    original = await endpoint();
  const binding = {
    ownerId: 'owner',
    workspaceId: 'workspace',
    browserId: 'browser',
    browserGeneration: 1,
  };
  const grantLocal = vi.fn(),
    revokeLocal = vi.fn(),
    broker = { grantLocal, revokeLocal };
  const http = origins.grant(original.server, binding, broker, 1000);
  const ws = origins.grant(original.server, binding, broker, 1000, 'websocket');
  expect(ws).toBe(http.replace(/^http:/, 'ws:'));
  expect(grantLocal.mock.calls).toEqual([
    [http, 'http', 1000],
    [ws, 'websocket', 1000],
  ]);
  expect(() => origins.grant(original.server, binding, broker, 1000, 'websocket')).toThrow();
  await original.close();
  expect(() => origins.check(binding)).toThrow('AUTHORITY_REFUSED');
  expect(revokeLocal).toHaveBeenCalled();
});
