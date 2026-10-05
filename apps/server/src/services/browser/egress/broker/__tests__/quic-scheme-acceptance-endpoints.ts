import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureWait } from '../../../../../../../../packages/browser/src/__tests__/fixture-manager-custody.js';
import { ownWebRtcEndpoints, readOwnedBytes } from './webrtc-acceptance-endpoints.js';

export interface TransportAttempt {
  api: boolean;
  constructed: boolean;
  secureContext: boolean;
  ready: 'returned' | 'rejected' | 'held';
  closedSettled: boolean;
}
/** Only actual Page-origin UDP calibration can distinguish blocked from unexercised. */
export function classifyWebTransport(input: {
  restricted: TransportAttempt;
  calibration: TransportAttempt;
  restrictedPackets: number;
  calibrationPackets: number;
}): 'observed' | 'bypass' | 'unverified' {
  const exercised = (value: TransportAttempt) =>
    value.api && value.constructed && value.secureContext && value.closedSettled;
  if (
    !exercised(input.restricted) ||
    !exercised(input.calibration) ||
    ![input.restrictedPackets, input.calibrationPackets].every(
      (n) => Number.isSafeInteger(n) && n >= 0 && n <= 64
    ) ||
    input.calibrationPackets === 0
  )
    return 'unverified';
  return input.restrictedPackets === 0 ? 'observed' : 'bypass';
}
const retained = new Set<object>();
/** A datagram observer, not a QUIC/TLS server or a successful WebTransport handshake. */
export function ownQuicSchemeEndpoints() {
  const udp = createSocket('udp4');
  const http = ownWebRtcEndpoints(); // Reuse reviewed original HTTP socket/listener custody.
  const owner: {
    udp: typeof udp;
    http: typeof http;
    closeOriginal?: Promise<void>;
    udpOriginal?: Promise<void>;
    httpOriginal?: Promise<void>;
  } = { udp, http };
  retained.add(owner);
  let packets = 0,
    delivered = 0,
    uncertain = false,
    udpClosed = false;
  const counts = new Map<string, number>();
  http.origin.prependListener('request', (request, response) => {
    const path = (request.url ?? '').split('?')[0]!;
    if (counts.size >= 16 && !counts.has(path)) {
      uncertain = true;
      return;
    }
    counts.set(path, (counts.get(path) ?? 0) + 1);
    response.setHeader('access-control-allow-origin', '*');
  });
  udp.on('message', (bytes) => {
    if (
      ++delivered > 64 ||
      bytes.length < 1200 ||
      bytes.length > 65507 ||
      ![1, 0x6b3343cf].includes(bytes.readUInt32BE(1)) ||
      (bytes[0]! & 0xf0) !== (bytes.readUInt32BE(1) === 1 ? 0xc0 : 0xd0)
    ) {
      uncertain = true;
      return;
    }
    packets++;
  });
  udp.on('error', () => {
    uncertain = true;
  });
  udp.once('close', () => {
    udpClosed = true;
  });
  return {
    origin: http.origin,
    async listen() {
      const addresses = await http.listen();
      const ready = once(udp, 'listening');
      udp.bind(0, '127.0.0.1');
      await ready;
      const address = udp.address();
      if (typeof address === 'string') throw Error('QUIC_ENDPOINT_UNKNOWN');
      return { ...addresses, quicPort: address.port };
    },
    snapshot: () => ({
      packets,
      uncertain,
      udpClosed,
      http: http.snapshot(),
      counts: Object.fromEntries(counts),
    }),
    close() {
      return (owner.closeOriginal ??= Promise.resolve().then(async () => {
        // Both original duties begin before waiting for either one.
        owner.httpOriginal = Promise.resolve().then(() => http.close());
        owner.udpOriginal = Promise.resolve().then(
          () =>
            new Promise<void>((resolve, reject) => {
              try {
                udp.close(resolve);
              } catch (error) {
                reject(error);
              }
            })
        );
        const outcomes = await fixtureWait(
          Promise.allSettled([owner.httpOriginal, owner.udpOriginal]),
          5000,
          'QUIC_ENDPOINT_CLOSE_HELD'
        );
        for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
        if (!udpClosed || uncertain) throw Error('QUIC_ENDPOINT_UNVERIFIED');
        retained.delete(owner);
      }));
    },
  };
}
/** Only the exact supervisor proxy argument is omitted; sandbox and disable-quic remain. */
export async function deriveProxyOmission(
  dist: string,
  destination: string,
  policy: string,
  manifestPath: string
) {
  const sourceNeedle = '`--proxy-server=${options.ownedProxy?.url ?? state.proxy!.url}`,';
  const distNeedle = '`--proxy-server=${options.ownedProxy?.url ?? state.proxy.url}`,';
  const source = (await readOwnedBytes(policy, 65536)).toString();
  if (source.split(sourceNeedle).length !== 2 || !source.includes("'--disable-quic'"))
    throw Error('QUIC_POLICY_SOURCE_UNVERIFIED');
  const manifest = JSON.parse((await readOwnedBytes(manifestPath, 256 * 1024)).toString()) as {
    kind: string;
    compilerExit: number;
    receiptSHA256: string;
    files: Array<{ path: string; sha256: string; mode: number }>;
  };
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const receipt = await readOwnedBytes(manifestPath + '.stdout', 256 * 1024);
  if (
    manifest.kind !== 'owned-tsc-emitted-files-v1' ||
    manifest.compilerExit !== 0 ||
    hash(receipt) !== manifest.receiptSHA256 ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length ||
    manifest.files.length > 1024
  )
    throw Error('QUIC_EMIT_UNVERIFIED');
  const members = receipt
    .toString()
    .trimEnd()
    .split('\n')
    .map((line) => {
      const prefix = `TSFILE: ${dist}/`;
      if (!line.startsWith(prefix)) throw Error('QUIC_EMIT_SCOPE');
      return line.slice(prefix.length);
    });
  if (members.length !== manifest.files.length || new Set(members).size !== members.length)
    throw Error('QUIC_EMIT_MEMBERSHIP');
  await mkdir(destination);
  let total = 0,
    changed = 0;
  const rows: Array<{ path: string; before: string; after: string }> = [];
  for (const [index, member] of members.entries()) {
    const row = manifest.files[index]!;
    if (
      row.path !== member ||
      !/^[A-Za-z0-9_/-]+\.(?:js|d\.ts)(?:\.map)?$/.test(member) ||
      member.startsWith('/') ||
      member.split('/').some((s) => !s || s === '.' || s === '..') ||
      !/^[a-f0-9]{64}$/.test(row.sha256) ||
      !Number.isInteger(row.mode) ||
      row.mode < 0 ||
      row.mode > 0o777
    )
      throw Error('QUIC_EMIT_MEMBER');
    const before = await readOwnedBytes(join(dist, member), 8 * 1024 * 1024);
    if (hash(before) !== row.sha256 || (total += before.length) > 64 * 1024 * 1024)
      throw Error('QUIC_EMIT_BYTES');
    let after = before;
    if (member === 'runtime/darwin-supervisor-browser.js') {
      const text = before.toString();
      if (text.split(distNeedle).length !== 2 || !text.includes("'--disable-quic'"))
        throw Error('QUIC_PROXY_LITERAL');
      after = Buffer.from(text.replace(distNeedle, ''));
      changed++;
    }
    const target = join(destination, member);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, after, { flag: 'wx', mode: row.mode });
    if (!(await readOwnedBytes(target, 8 * 1024 * 1024)).equals(after))
      throw Error('QUIC_DERIVATION_CHANGED');
    rows.push({ path: member, before: hash(before), after: hash(after) });
  }
  if (changed !== 1 || rows.filter((r) => r.before !== r.after).length !== 1)
    throw Error('QUIC_MUTANT_SCOPE');
  return { workerPath: join(destination, 'runtime/darwin-supervisor-worker.js'), rows };
}

/** Private denied authority: TCP and HTTP are separate observations, never interchangeable. */
export function ownDeniedQuicEndpoint(): Readonly<{
  server: Server;
  snapshot(): {
    connections: number;
    requests: number;
    sockets: number;
    closed: boolean;
    uncertain: boolean;
  };
  close(): Promise<void>;
}> {
  const sockets = new Map<Socket, Promise<void>>();
  const owner: {
    sockets: typeof sockets;
    server: ReturnType<typeof createServer>;
    listenerOriginal?: Promise<void>;
    closeOriginal?: Promise<void>;
  } = {
    sockets,
    server: createServer((request, response) => {
      if (stopping || requests >= 16) {
        fail(Error('QUIC_DENIED_REQUEST_CAP'));
        stopListener();
        destroy(request.socket);
        return;
      }
      requests++;
      try {
        response.end('owned denied endpoint');
      } catch (error) {
        fail(error);
        destroy(request.socket);
      }
    }),
  };
  retained.add(owner);
  let stopping = false,
    closed = false,
    uncertain = false,
    present = false,
    primary: unknown;
  let connections = 0,
    requests = 0;
  const fail = (error: unknown) => {
    if (!present) primary = error;
    present = true;
    uncertain = true;
  };
  const destroy = (socket: Socket) => {
    try {
      socket.destroy();
    } catch (error) {
      fail(error);
    }
  };
  const stopListener = () => {
    stopping = true;
    // Publish raw original before the actual Server.close producer is entered.
    owner.listenerOriginal ??= Promise.resolve().then(
      () =>
        new Promise<void>((resolve, reject) => {
          try {
            owner.server.close((error) => (error ? reject(error) : resolve()));
          } catch (error) {
            reject(error);
          }
        })
    );
    void owner.listenerOriginal.catch(fail);
    return owner.listenerOriginal;
  };
  owner.server.maxConnections = 8;
  owner.server.maxRequestsPerSocket = 1;
  owner.server.on('error', fail);
  owner.server.once('close', () => {
    closed = true;
  });
  owner.server.on('connection', (socket) => {
    const original = new Promise<void>((resolve) =>
      socket.once('close', () => {
        sockets.delete(socket);
        resolve();
      })
    );
    sockets.set(socket, original); // Own each actual delivered original before cap/effect/callback.
    socket.on('error', fail);
    connections++;
    if (stopping || sockets.size > 8 || connections > 16) {
      fail(Error('QUIC_DENIED_SOCKET_CAP'));
      stopListener();
      destroy(socket);
    }
  });
  return Object.freeze({
    server: owner.server,
    snapshot: () => ({ connections, requests, sockets: sockets.size, closed, uncertain }),
    close() {
      return (owner.closeOriginal ??= Promise.resolve().then(async () => {
        const originalListener = stopListener();
        const originals = [...sockets.values(), originalListener];
        for (const socket of sockets.keys()) destroy(socket); // Every delivered socket attempted independently.
        try {
          const results = await fixtureWait(
            Promise.allSettled(originals),
            3000,
            'QUIC_DENIED_CLOSE_HELD'
          );
          for (const row of results) if (row.status === 'rejected') fail(row.reason);
        } catch (error) {
          fail(error);
        }
        if (!closed || sockets.size) fail(Error('QUIC_DENIED_ORIGINALS_HELD'));
        if (present) throw primary;
        retained.delete(owner);
      }));
    },
  });
}
