import { createSocket } from 'node:dgram';
import { createServer as createTcpServer, type Socket } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { open, lstat, mkdir, writeFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { ownFixtureCustody } from '../../../../../../../../packages/browser/src/__tests__/fixture-custody.js';
import { fixtureWait } from '../../../../../../../../packages/browser/src/__tests__/fixture-manager-custody.js';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export interface IceObservation {
  api: boolean;
  dataChannel: boolean;
  localDescription: boolean;
  candidates: number;
  gatheringComplete: boolean;
  elapsed: number;
}
export type RestrictionVerdict = 'observed' | 'unverified' | 'bypass';
/** Endpoint traffic, not ICE success or a timeout alone, distinguishes restriction from vacuity. */
export function classifyRestriction(input: {
  restricted: IceObservation;
  calibration: IceObservation;
  restrictedPackets: number;
  calibrationPackets: number;
}): RestrictionVerdict {
  const exercised = (row: IceObservation) =>
    row.api &&
    row.dataChannel &&
    row.localDescription &&
    Number.isFinite(row.elapsed) &&
    row.elapsed >= 0;
  if (
    ![input.restrictedPackets, input.calibrationPackets].every(
      (count) => Number.isSafeInteger(count) && count >= 0 && count <= 64
    )
  )
    return 'unverified';
  if (!exercised(input.restricted) || !exercised(input.calibration) || input.calibrationPackets < 1)
    return 'unverified';
  return input.restrictedPackets === 0 ? 'observed' : 'bypass';
}

const retainedEndpoints = new Set<object>();
/** Every delivered socket is retained before cap enforcement or any destruction attempt. */
export function ownWebRtcEndpoints() {
  const udp = createSocket('udp4');
  const tcp = createTcpServer();
  let originRequests = 0,
    leakedCredentials = 0;
  const origin = createHttpServer((request, response) => {
    try {
      if (stopping || originRequests >= 64) {
        fail(new Error('FIXTURE_ORIGIN_REQUEST_CAP'));
        stopListeners();
        destroy(request.socket);
        return;
      }
      originRequests++;
      if (request.headers.authorization || request.headers['proxy-authorization'])
        leakedCredentials++;
      response.setHeader('content-type', 'text/html');
      response.setHeader('cache-control', 'no-store');
      response.end('<title>Owned WebRTC fixture</title><link rel="icon" href="data:,">');
    } catch (error) {
      fail(error);
      destroy(request.socket);
    }
  });
  origin.maxRequestsPerSocket = 1;
  const sockets = new Map<Socket, Promise<void>>();
  const identity = { udp, tcp, origin, sockets };
  retainedEndpoints.add(identity);
  let packets = 0,
    accepts = 0,
    malformed = 0,
    datagrams = 0,
    delivered = 0;
  let uncertain = false,
    failed = false,
    first: unknown,
    stopping = false;
  let udpClosed = false,
    tcpClosed = false,
    originClosed = false;
  let closing: Promise<void> | undefined;
  const fail = (error: unknown) => {
    if (!failed) first = error;
    failed = true;
    uncertain = true;
  };
  udp.once('close', () => {
    udpClosed = true;
  });
  tcp.once('close', () => {
    tcpClosed = true;
  });
  origin.once('close', () => {
    originClosed = true;
  });
  // Node limits accepted connections per listener before delivery; combined live bank <=32.
  tcp.maxConnections = origin.maxConnections = 16;
  const listenerClosures = new Map<object, Promise<void>>();
  const stopListeners = () => {
    stopping = true;
    for (const server of [tcp, origin]) {
      if (listenerClosures.has(server)) continue;
      const original = new Promise<void>((resolve, reject) => {
        try {
          server.close((error) => {
            if (error) {
              fail(error);
              reject(error);
            } else resolve();
          });
        } catch (error) {
          fail(error);
          reject(error);
        }
      });
      listenerClosures.set(server, original);
      void original.catch(() => {});
    }
  };
  const destroy = (socket: Socket) => {
    try {
      socket.destroy();
    } catch (error) {
      fail(error);
    }
  };
  const retain = (socket: Socket, kind: 'tcp' | 'http') => {
    // No cap, resume, destroy or test observer runs before original close/error registration.
    const original = new Promise<void>((resolve) =>
      socket.once('close', () => {
        sockets.delete(socket);
        resolve();
      })
    );
    sockets.set(socket, original);
    socket.on('error', fail);
    delivered++;
    if (kind === 'tcp') accepts++;
    if (stopping || sockets.size > 16 || delivered > 64) {
      fail(new Error('FIXTURE_ENDPOINT_CAP'));
      stopListeners();
      destroy(socket);
      return;
    }
    if (kind === 'tcp') {
      try {
        socket.resume();
      } catch (error) {
        fail(error);
        stopListeners();
        destroy(socket);
      }
    }
  };
  tcp.on('connection', (socket) => retain(socket, 'tcp'));
  origin.on('connection', (socket) => retain(socket, 'http'));
  udp.on('message', (bytes) => {
    if (++datagrams > 64) {
      fail(new Error('FIXTURE_DATAGRAM_CAP'));
      return;
    }
    if (bytes.length < 20 || bytes.length > 4096 || bytes.readUInt32BE(4) !== 0x2112a442) {
      malformed++;
      return;
    }
    packets++;
  });
  for (const endpoint of [udp, tcp, origin]) endpoint.on('error', fail);
  const port = (value: ReturnType<typeof tcp.address>) => {
    if (!value || typeof value === 'string') throw new Error('FIXTURE_LISTENER_UNBOUND');
    return value.port;
  };
  return Object.freeze({
    origin,
    tcp,
    async listen() {
      for (const server of [tcp, origin]) {
        const ready = once(server, 'listening');
        server.listen(0, '127.0.0.1');
        await ready;
      }
      const ready = once(udp, 'listening');
      udp.bind(0, '127.0.0.1');
      await ready;
      return {
        udpPort: port(udp.address()),
        tcpPort: port(tcp.address()),
        originPort: port(origin.address()),
      };
    },
    snapshot: () => ({
      packets,
      accepts,
      malformed,
      uncertain,
      sockets: sockets.size,
      originRequests,
      leakedCredentials,
      udpClosed,
      tcpClosed,
      originClosed,
    }),
    close() {
      return (closing ??= (async () => {
        stopListeners();
        // Initiate each original independently before waiting on any held socket or listener.
        const originals = [...sockets.values(), ...listenerClosures.values()];
        for (const socket of sockets.keys()) destroy(socket);
        const originalUdp = new Promise<void>((resolve, reject) => {
          try {
            udp.close(() => resolve());
          } catch (error) {
            fail(error);
            reject(error);
          }
        });
        originals.push(originalUdp);
        void originalUdp.catch(() => {});
        try {
          await fixtureWait(Promise.allSettled(originals), 5000, 'FIXTURE_ENDPOINT_CLOSE_EXPIRED');
        } catch (error) {
          fail(error);
        }
        if (sockets.size || !udpClosed || !tcpClosed || !originClosed)
          fail(new Error('FIXTURE_ENDPOINT_CLOSURE_HELD'));
        if (failed) throw first;
        retainedEndpoints.delete(identity);
      })());
    },
  });
}

const retainedHomes = new Set<object>();
/** The named home is owned before canonicalization, including a late mkdtemp result. */
export function ownWebRtcPreflight() {
  const custody = ownFixtureCustody();
  const homes = new Set<string>();
  let failed = false,
    cleanupObserved = false;
  const removal = {
    issued: null as Promise<void> | null,
    original: null as Promise<void> | null,
    returned: false,
  };
  const identity = { homes, removal };
  retainedHomes.add(identity); // Strong ownership exists before acquisition and outlives outer.finish.
  let removalWait: Promise<void> | undefined;
  return Object.freeze({
    operation: custody.operation,
    acquire: custody.acquire,
    adopt: custody.adopt,
    async acquireHome(produce: () => Promise<string>, milliseconds = 5000) {
      try {
        const original = await custody.acquire(
          'named home',
          async () => {
            const named = await produce();
            homes.add(named); // Retain actual returned name before any realpath/read/write.
            return { named };
          },
          async () => {},
          milliseconds
        );
        return original.named;
      } catch (error) {
        failed = true;
        throw error;
      }
    },
    homes: () => [...homes],
    removalSnapshot: () => ({
      started: removal.original !== null,
      returned: removal.returned,
      held: retainedHomes.has(identity),
    }),
    removeHome(
      named: string,
      milliseconds = 5000,
      remove: (path: string) => Promise<void> = (path) => rm(path, { recursive: true })
    ) {
      if (removalWait) return removalWait; // One original attempt, including after a failed/expired wait.
      if (!cleanupObserved || failed || homes.size !== 1 || !homes.has(named))
        return Promise.reject(new Error('FIXTURE_HOME_REMOVAL_REFUSED'));
      // Register the original duty before entering the fallible producer.
      const original = Promise.resolve().then(() => {
        removal.issued = remove(named);
        return removal.issued;
      });
      removal.original = original;
      void original.then(
        () => {
          removal.returned = true;
          if (!failed) {
            homes.delete(named);
            retainedHomes.delete(identity);
          }
        },
        () => {
          failed = true;
        }
      );
      removalWait = fixtureWait(original, milliseconds, 'FIXTURE_HOME_REMOVAL_EXPIRED').catch(
        (error) => {
          failed = true; // Late return never heals uncertainty or releases original ownership.
          throw error;
        }
      );
      return removalWait;
    },
    async finish(milliseconds = 5000) {
      const result = await custody.finish(milliseconds);
      if (!result.observed) failed = true;
      cleanupObserved = result.observed && !failed;
      if (cleanupObserved && homes.size === 0 && removal.original === null)
        retainedHomes.delete(identity);
      return { ...result, observed: cleanupObserved };
    },
  });
}

/** Bounded no-follow source reads retain the original descriptor until close. */
const retainedReads = new Set<Awaited<ReturnType<typeof open>>>();
let readsUncertain = false;
export async function readOwnedBytes(path: string, cap: number): Promise<Buffer> {
  if (readsUncertain) throw new Error('FIXTURE_READ_CUSTODY_UNKNOWN');
  const named = await lstat(path, { bigint: true });
  if (!named.isFile() || named.size > BigInt(cap)) throw new Error('FIXTURE_INPUT_INVALID');
  const original = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  retainedReads.add(original);
  let failed = false,
    first: unknown,
    result: Buffer | undefined;
  try {
    const before = await original.stat({ bigint: true });
    if (!before.isFile() || before.size < 0n || before.size > BigInt(cap))
      throw new Error('FIXTURE_INPUT_INVALID');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await original.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const after = await original.stat({ bigint: true }),
      current = await lstat(path, { bigint: true });
    for (const stat of [named, after, current])
      for (const field of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const)
        if (stat[field] !== before[field]) throw new Error('FIXTURE_INPUT_CHANGED');
    if (count > cap || BigInt(count) !== before.size) throw new Error('FIXTURE_INPUT_CAP');
    result = bytes.subarray(0, count);
  } catch (error) {
    failed = true;
    first = error;
  }
  try {
    await original.close();
    retainedReads.delete(original);
  } catch (error) {
    if (!failed) first = error;
    failed = true;
    readsUncertain = true;
  }
  if (failed) throw first;
  return result!;
}

/** Own built-output mutation only. Every copied byte except the one native policy switch is exact. */
export async function deriveOmittedWebRtcFlag(
  sourceDist: string,
  destination: string,
  sourcePolicy: string,
  emittedManifest: string
) {
  const needle = "'--webrtc-ip-handling-policy=disable_non_proxied_udp',";
  if ((await readOwnedBytes(sourcePolicy, 65536)).toString('utf8').split(needle).length !== 2)
    throw new Error('FIXTURE_SOURCE_FLAG_NOT_UNIQUE');
  const manifest = JSON.parse(
    (await readOwnedBytes(emittedManifest, 256 * 1024)).toString('utf8')
  ) as {
    kind: string;
    compilerExit: number;
    receiptSHA256: string;
    files: Array<{ path: string; sha256: string; mode: number }>;
  };
  if (
    manifest.kind !== 'owned-tsc-emitted-files-v1' ||
    manifest.compilerExit !== 0 ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length ||
    manifest.files.length > 1024
  )
    throw new Error('FIXTURE_EMITTED_MANIFEST_INVALID');
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const receipt = await readOwnedBytes(emittedManifest + '.stdout', 256 * 1024);
  if (digest(receipt) !== manifest.receiptSHA256)
    throw new Error('FIXTURE_COMPILER_RECEIPT_CHANGED');
  const emitted = receipt
    .toString('utf8')
    .trimEnd()
    .split('\n')
    .map((line) => {
      const prefix = `TSFILE: ${sourceDist}/`;
      if (!line.startsWith(prefix)) throw new Error('FIXTURE_COMPILER_SCOPE');
      return line.slice(prefix.length);
    });
  if (emitted.length !== manifest.files.length || new Set(emitted).size !== emitted.length)
    throw new Error('FIXTURE_COMPILER_MEMBERSHIP');
  const rows: Array<{ path: string; beforeSHA256: string; afterSHA256: string }> = [];
  let total = 0,
    changed = 0;
  await mkdir(destination);
  for (let index = 0; index < emitted.length; index++) {
    const member = emitted[index]!,
      row = manifest.files[index]!;
    if (
      row.path !== member ||
      !/^[A-Za-z0-9_/-]+\.(?:js|d\.ts)(?:\.map)?$/.test(member) ||
      member.startsWith('/') ||
      member.split('/').some((part) => !part || part === '.' || part === '..') ||
      !/^[a-f0-9]{64}$/.test(row.sha256) ||
      !Number.isInteger(row.mode) ||
      row.mode < 0 ||
      row.mode > 0o777
    )
      throw new Error('FIXTURE_MANIFEST_MEMBER_INVALID');
    const before = await readOwnedBytes(join(sourceDist, member), 8 * 1024 * 1024);
    if (digest(before) !== row.sha256) throw new Error('FIXTURE_EMITTED_BYTES_CHANGED');
    if ((total += before.length) > 64 * 1024 * 1024) throw new Error('FIXTURE_DIST_BYTE_CAP');
    let after = before;
    if (member === 'runtime/darwin-supervisor-browser.js') {
      const text = before.toString('utf8');
      if (text.split(needle).length !== 2) throw new Error('FIXTURE_FLAG_LITERAL_NOT_UNIQUE');
      after = Buffer.from(text.replace(needle, ''));
      changed++;
    }
    const target = join(destination, member);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, after, { mode: row.mode, flag: 'wx' });
    if (!after.equals(await readOwnedBytes(target, 8 * 1024 * 1024)))
      throw new Error('FIXTURE_DERIVATION_CHANGED');
    rows.push({ path: member, beforeSHA256: digest(before), afterSHA256: digest(after) });
  }
  if (changed !== 1 || rows.filter((row) => row.beforeSHA256 !== row.afterSHA256).length !== 1)
    throw new Error('FIXTURE_MUTATION_SCOPE');
  return Object.freeze({
    workerPath: join(destination, 'runtime/darwin-supervisor-worker.js'),
    entries: emitted.length,
    bytes: total,
    rows,
  });
}
