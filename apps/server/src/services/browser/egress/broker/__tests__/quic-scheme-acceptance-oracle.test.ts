import { expect, it } from 'vitest';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { connect, type Socket } from 'node:net';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseBrowserCommand } from '@dorkos/browser';
import {
  ownDeniedQuicEndpoint,
  deriveProxyOmission,
  classifyWebTransport,
  ownQuicSchemeEndpoints,
  type TransportAttempt,
} from './quic-scheme-acceptance-endpoints.js';
const attempt: TransportAttempt = {
  api: true,
  constructed: true,
  secureContext: true,
  ready: 'rejected',
  closedSettled: true,
};
it('does not promote dead or unexercised WebTransport endpoint calibration', () => {
  expect(
    classifyWebTransport({
      restricted: attempt,
      calibration: attempt,
      restrictedPackets: 0,
      calibrationPackets: 0,
    })
  ).toBe('unverified');
  for (const field of ['api', 'constructed', 'secureContext', 'closedSettled'] as const)
    expect(
      classifyWebTransport({
        restricted: { ...attempt, [field]: false },
        calibration: attempt,
        restrictedPackets: 0,
        calibrationPackets: 1,
      })
    ).toBe('unverified');
});
it('requires actual calibrated packet zero and reports observed forbidden packets as bypass', () => {
  expect(
    classifyWebTransport({
      restricted: attempt,
      calibration: attempt,
      restrictedPackets: 0,
      calibrationPackets: 1,
    })
  ).toBe('observed');
  expect(
    classifyWebTransport({
      restricted: attempt,
      calibration: attempt,
      restrictedPackets: 1,
      calibrationPackets: 1,
    })
  ).toBe('bypass');
});
it('the UDP observer detects actual version1 Initial-shaped packets; this Node control is not Page calibration', async () => {
  const endpoint = ownQuicSchemeEndpoints();
  const client = createSocket('udp4');
  let primary = false,
    first: unknown;
  try {
    const { quicPort } = await endpoint.listen();
    const packet = Buffer.alloc(1200);
    packet[0] = 0xc0;
    packet.writeUInt32BE(1, 1);
    const received = expect.poll(() => endpoint.snapshot().packets).toBe(1);
    await new Promise<void>((resolve, reject) =>
      client.send(packet, quicPort, '127.0.0.1', (error) => (error ? reject(error) : resolve()))
    );
    await received;
  } catch (error) {
    primary = true;
    first = error;
  }
  for (const close of [
    async () => {
      const returned = once(client, 'close');
      client.close();
      await returned;
    },
    () => endpoint.close(),
  ])
    try {
      await close();
    } catch (error) {
      if (!primary) first = error;
      primary = true;
    }
  if (primary) throw first;
  expect(endpoint.snapshot().udpClosed).toBe(true);
});
it('public navigation parser rejects unsupported schemes before any producer; this is not native scheme containment', () => {
  const binding = {
    browserId: 'AAAAAAAAAAAAAAAAAAAAAA',
    browserGeneration: 1,
    tabId: 'BBBBBBBBBBBBBBBBBBBBBB',
    navigationGeneration: 1,
    viewportVersion: 1,
    epoch: 1,
    inputGeneration: 1,
  };
  expect(
    parseBrowserCommand({
      kind: 'navigate',
      requestId: 'CCCCCCCCCCCCCCCCCCCCCC',
      binding,
      url: 'http://127.0.0.1/owned',
    }).kind
  ).toBe('navigate');
  for (const url of [
    'file:///owned-fixture',
    'custom-fixture:outside',
    'javascript:void(0)',
    'data:text/html,owned',
    'blob:http://127.0.0.1/owned',
  ])
    expect(() =>
      parseBrowserCommand({ kind: 'navigate', requestId: 'CCCCCCCCCCCCCCCCCCCCCC', binding, url })
    ).toThrow();
});

it('derives exactly one proxy argument omission from own compiler membership; other restrictions remain', async () => {
  const home = await mkdtemp(join(tmpdir(), 'quic-proxy-control-'));
  try {
    const dist = join(home, 'dist');
    await mkdir(join(dist, 'runtime'), { recursive: true });
    const source =
      "'--disable-quic', '--webrtc-ip-handling-policy=disable_non_proxied_udp', `--proxy-server=${options.ownedProxy?.url ?? state.proxy!.url}`, 'about:blank'";
    const emitted = source.replace('state.proxy!.url', 'state.proxy.url');
    const members = ['runtime/darwin-supervisor-browser.js', 'runtime/darwin-supervisor-worker.js'];
    const body = [emitted, 'export const control = true;'];
    const hash = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
    for (const [index, member] of members.entries())
      await writeFile(join(dist, member), body[index]!);
    const stdout = members.map((member) => `TSFILE: ${dist}/${member}`).join('\n') + '\n';
    const manifest = join(home, 'emit.json');
    await writeFile(manifest + '.stdout', stdout);
    await writeFile(
      manifest,
      JSON.stringify({
        kind: 'owned-tsc-emitted-files-v1',
        compilerExit: 0,
        receiptSHA256: hash(stdout),
        files: members.map((path, index) => ({ path, mode: 0o600, sha256: hash(body[index]!) })),
      })
    );
    const policy = join(home, 'policy.ts');
    await writeFile(policy, source);
    const output = join(home, 'derived');
    const derived = await deriveProxyOmission(dist, output, policy, manifest);
    expect(derived.rows.filter((row) => row.before !== row.after).map((row) => row.path)).toEqual([
      members[0],
    ]);
    expect(await readFile(join(output, members[0]!), 'utf8')).toBe(
      emitted.replace('`--proxy-server=${options.ownedProxy?.url ?? state.proxy.url}`,', '')
    );
    expect(await readFile(join(output, members[1]!), 'utf8')).toBe(body[1]);
    await writeFile(join(dist, members[1]!), 'altered official compiler member');
    await expect(
      deriveProxyOmission(dist, join(home, 'refused'), policy, manifest)
    ).rejects.toThrow('QUIC_EMIT_BYTES');
  } finally {
    await rm(home, { recursive: true });
  }
});

it('denied endpoint separately owns real TCP-only arrivals and closes every original without HTTP evidence', async () => {
  const endpoint = ownDeniedQuicEndpoint();
  const clients: Socket[] = [];
  let failed = false,
    primary: unknown;
  try {
    const listening = once(endpoint.server, 'listening');
    endpoint.server.listen(0, '127.0.0.1');
    await listening;
    const address = endpoint.server.address();
    if (!address || typeof address === 'string') throw Error('CONTROL_ADDRESS');
    for (let index = 0; index < 2; index++) {
      const delivered = once(endpoint.server, 'connection');
      const client = connect(address.port, '127.0.0.1');
      clients.push(client);
      await once(client, 'connect');
      await delivered;
    }
    expect(endpoint.snapshot()).toMatchObject({
      connections: 2,
      requests: 0,
      sockets: 2,
      uncertain: false,
    });
    await endpoint.close();
    expect(endpoint.snapshot()).toMatchObject({
      connections: 2,
      requests: 0,
      sockets: 0,
      closed: true,
      uncertain: false,
    });
  } catch (error) {
    failed = true;
    primary = error;
  }
  for (const client of clients) client.destroy();
  try {
    await endpoint.close();
  } catch (error) {
    if (!failed) primary = error;
    failed = true;
  }
  if (failed) throw primary;
});
it('denied endpoint retains the seventeenth actual TCP original before sticky total-admission cutoff', async () => {
  const endpoint = ownDeniedQuicEndpoint();
  const clients: Socket[] = [];
  let sawOriginal = false,
    failed = false,
    primary: unknown;
  endpoint.server.on('connection', () => {
    if (endpoint.snapshot().connections === 17)
      sawOriginal = endpoint.snapshot().sockets === 1 && endpoint.snapshot().uncertain;
  });
  try {
    const listening = once(endpoint.server, 'listening');
    endpoint.server.listen(0, '127.0.0.1');
    await listening;
    const address = endpoint.server.address();
    if (!address || typeof address === 'string') throw Error('CONTROL_ADDRESS');
    for (let index = 0; index < 17; index++) {
      const delivered = once(endpoint.server, 'connection');
      const client = connect(address.port, '127.0.0.1');
      clients.push(client);
      await once(client, 'connect');
      const [original] = (await delivered) as [Socket];
      const returned = once(original, 'close');
      client.destroy();
      await returned;
    }
    expect(sawOriginal).toBe(true);
    expect(endpoint.snapshot().requests).toBe(0);
    await expect(endpoint.close()).rejects.toThrow('QUIC_DENIED_SOCKET_CAP');
    expect(endpoint.snapshot()).toMatchObject({
      connections: 17,
      requests: 0,
      sockets: 0,
      closed: true,
      uncertain: true,
    });
  } catch (error) {
    failed = true;
    primary = error;
  }
  for (const client of clients) client.destroy();
  await endpoint.close().catch(() => {});
  if (failed) throw primary;
});
