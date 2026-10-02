import { it, expect, vi } from 'vitest';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { createEgressPolicy, type PinnedEndpoint } from '../index.js';

const context = {
  ownerId: 'owner-a',
  workspaceId: 'workspace-a',
  browserId: 'browser-a',
  browserGeneration: 1,
};
async function listener() {
  const sockets = new Set<Socket>();
  let connections = 0;
  const server: Server = createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.end('FAKE_ENDPOINT');
  });
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
  };
  try {
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        done();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('FAKE_LISTENER_UNAVAILABLE');
    return {
      url: `http://127.0.0.1:${address.port}/`,
      port: address.port,
      get connections() {
        return connections;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function fakeSocket(endpoint: PinnedEndpoint): Promise<string> {
  expect(endpoint.address).toBe('127.0.0.1');
  return new Promise<string>((done, reject) => {
    const socket = connect({
      host: endpoint.address,
      port: endpoint.port,
      family: endpoint.family,
    });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(Error('FAKE_SOCKET_TIMEOUT'));
    }, 1000);
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => clearTimeout(timeout));
    socket.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
  });
}

it('opens only an authorized pinned literal socket and produces zero admin/alias connects', async () => {
  const cleanups: (() => Promise<void>)[] = [];
  let primary: { error: unknown } | undefined;
  const failures: unknown[] = [];
  try {
    const allowed = await listener();
    cleanups.push(allowed.close);
    const admin = await listener();
    cleanups.push(admin.close);
    const resolve = vi.fn(async () => ({ a: ['127.0.0.1'], aaaa: [], cname: [] }));
    const policy = createEgressPolicy({
      revision: 31,
      adminAuthorities: [admin.url, `http://alias.fixture.invalid:${admin.port}`],
      privateAdminEndpoints: [{ address: '127.0.0.1', port: admin.port }],
      hostInterfaces: [],
      resolver: resolve,
      now: () => 1000,
    });
    const grant = policy.issueLocalGrant(context, allowed.url, 2000);
    const decision = await policy.authorize({
      url: allowed.url,
      hostHeader: `127.0.0.1:${allowed.port}`,
      context,
      grant,
    });
    const endpoint = decision.endpoints[0]!;
    const body = await fakeSocket(endpoint);
    expect(body).toBe('FAKE_ENDPOINT');
    expect(allowed.connections).toBe(1);
    expect(resolve).not.toHaveBeenCalled();
    let refused: unknown;
    try {
      const forbiddenGrant = policy.issueLocalGrant(context, admin.url, 2000);
      const forbidden = await policy.authorize({ url: admin.url, context, grant: forbiddenGrant });
      await fakeSocket(forbidden.endpoints[0]!);
    } catch (error) {
      refused = error;
    }
    expect(admin.connections, 'FORBIDDEN_ADMIN_SOCKET_REACHED').toBe(0);
    expect(refused).toMatchObject({ code: 'ADMIN_DENIED' });
    for (const url of [admin.url, `http://alias.fixture.invalid:${admin.port}/`]) {
      await expect(policy.authorize({ url, context, grant })).rejects.toMatchObject({
        code: 'ADMIN_DENIED',
      });
    }
    expect(admin.connections).toBe(0);
    expect(resolve).not.toHaveBeenCalled();
    expect(() => policy.issueLocalGrant(context, admin.url, 2000)).toThrow();
    expect(admin.connections).toBe(0);
  } catch (error) {
    primary = { error };
  } finally {
    for (const cleanup of cleanups.reverse())
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
  }
  if (primary) throw primary.error;
  if (failures.length) throw new AggregateError(failures, 'FAKE_CLEANUP_FAILED');
});
