import { ownOriginalBackgroundResponseGate } from './original-background-response-gate.fixture.js';
import {
  originalOwnedAlternativeService,
  writeOriginalOwnedAlternativeService,
} from './controlled-alt-svc.fixture.js';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { Resolver } from 'node:dns/promises';
import type { RecordWithTtl } from 'node:dns';
import { mkdir, realpath, readFile, lstat, writeFile } from 'node:fs/promises';
import { openSync, writeSync, closeSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { connect, type ClientHttp2Session } from 'node:http2';
import { connect as tlsConnect, checkServerIdentity, type TLSSocket } from 'node:tls';
import { join, isAbsolute } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { classifyAddress } from '../../addresses.js';
import {
  createDarwinProcessObserver,
  darwinBirth,
} from '../../../../../../../../packages/browser/src/runtime/darwin-process-observer.js';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Row = Readonly<{
  event: 'request' | 'response-close';
  role: 'allowed' | 'denied';
  phase: 'calibration' | 'matrix';
  method: string;
  host: string;
  path: string;
}>;
type Birth = Readonly<{ pid: number; birth: string }>;
export interface OriginalQuickTunnelReply {
  readonly status: 200 | 302;
  readonly contentType: 'text/html; charset=utf-8' | 'application/javascript' | 'text/plain';
  readonly body: string;
  readonly location?: string;
  /** Fixed h2 alternative naming only an exact owned HTTPS route; no arbitrary headers. */
  readonly alternativeService?: string;
}
export interface OriginalQuickTunnelPort {
  readonly allowedOrigin: string;
  readonly deniedOrigin: string;
  readonly sharedAuthorityCampaign: 'required' | 'deferred';
  readonly allowedAddresses: readonly string[];
  readonly commonAddresses: readonly string[];
  readonly leafSHA256: string;
  readonly proof: Readonly<Record<string, unknown>>;
  assertCurrent(): void;
  observations(): readonly Row[];
  awaitOriginalResponseClose(role: 'allowed' | 'denied', path: string): Promise<void>;
  awaitOriginalBackgroundRequest(
    role: 'allowed' | 'denied',
    path: string,
    after: number,
    signal: AbortSignal
  ): Promise<void>;
  originalBackgroundGateTerminal(
    role: 'allowed' | 'denied',
    path: string
  ): Readonly<{ returned: Promise<void>; closed(): boolean }>;
  releaseOriginalBackgroundGate(role: 'allowed' | 'denied', path: string): Promise<void>;
  originalUpdateRedirectResponse(
    path: string
  ): Readonly<{ status: 302; location: string; returned: Promise<void> }>;
  close(): Promise<unknown>;
}
const originalPorts = new WeakMap<object, () => OriginalQuickTunnelPort>();
/** JSON, copied DTOs and arbitrary getters never establish original route custody. */
export function readOriginalQuickTunnelPort(value: unknown): OriginalQuickTunnelPort {
  if (typeof value !== 'object' || value === null) throw new Error('ORIGINAL_TUNNEL_PORT_REQUIRED');
  const read = originalPorts.get(value);
  if (!read) throw new Error('ORIGINAL_TUNNEL_PORT_REQUIRED');
  return read();
}

/** Caller owns the existing180s deadline; no installation, account or retry is performed here. */
export async function openOriginalQuickTunnelPreflight(options: {
  artifacts: string;
  /** Only the user-deferred shared-IP/shared-SAN campaign; all other origin checks remain strict. */
  sharedAuthorityCampaign?: 'required' | 'deferred';
  binary: Readonly<{
    path: string;
    sha256: string;
    size: number;
    receiptPath: string;
    receiptSHA256: string;
  }>;
  observer: Readonly<{ path: string; sha256: string }>;
  signal: AbortSignal;
  current(): void;
  /** Fixture-only response content; no incoming headers or bodies are passed to this producer. */
  reply?(
    role: 'allowed' | 'denied',
    path: string,
    origins: readonly string[]
  ): OriginalQuickTunnelReply;
  body?(role: 'allowed' | 'denied', path: string, origins: readonly string[]): string;
}) {
  const sharedAuthorityCampaign = options.sharedAuthorityCampaign ?? 'required';
  if (sharedAuthorityCampaign !== 'required' && sharedAuthorityCampaign !== 'deferred')
    throw new Error('ORIGINAL_TUNNEL_CAMPAIGN_REQUIRED');
  const suppliedBinary = options.binary;
  const originalBinary = Object.freeze({
    path: suppliedBinary.path,
    sha256: suppliedBinary.sha256,
    size: suppliedBinary.size,
    receiptPath: suppliedBinary.receiptPath,
    receiptSHA256: suppliedBinary.receiptSHA256,
  });
  if (
    !isAbsolute(originalBinary.path) ||
    !isAbsolute(originalBinary.receiptPath) ||
    !/^[a-f0-9]{64}$/.test(originalBinary.sha256) ||
    !/^[a-f0-9]{64}$/.test(originalBinary.receiptSHA256) ||
    !Number.isSafeInteger(originalBinary.size) ||
    originalBinary.size <= 0 ||
    originalBinary.size > 64 * 1024 * 1024
  )
    throw new Error('ORIGINAL_TUNNEL_BINARY_DESCRIPTOR');
  const binary = originalBinary.path,
    binarySHA256 = originalBinary.sha256,
    receiptPath = originalBinary.receiptPath,
    receiptSHA256 = originalBinary.receiptSHA256;
  const originalCurrent = options.current.bind(options);
  const replyMethod = options.reply;
  const originalReply = replyMethod?.bind(options);
  const bodyMethod = options.body;
  const originalBody = bodyMethod?.bind(options);
  let created = false;
  let first: { value: unknown } | undefined;
  let closing: Promise<unknown> | undefined;
  let retired = false;
  let phase: Row['phase'] = 'calibration';
  const nonce = randomUUID(),
    rows: Row[] = [],
    known = new Map<string, Birth>();
  const children: Array<{
    child: ChildProcess;
    returned: Promise<void>;
    closed: Promise<void>;
    pipes: Promise<void>[];
    terminal: { code?: number | null; signal?: string | null };
    pipeFacts: Array<{
      name: string;
      path: string;
      bytes: number;
      eof: boolean;
    }>;
  }> = [];
  const servers: Server[] = [],
    sockets = new Set<import('node:net').Socket>();
  const sessions: ClientHttp2Session[] = [],
    tlsSockets: TLSSocket[] = [];
  const websocketServers: WebSocketServer[] = [];
  const websocketPeers = new Set<WebSocket>();
  const websocketRetirements = new Map<WebSocket, () => void>();
  const websocketServerCloses = new Map<WebSocketServer, Promise<void>>();
  let acceptedUpgrades = 0;
  const terminals: Promise<void>[] = [];
  let resolver: Resolver | undefined;
  const origins: string[] = [];
  const rawDescriptors = new Set<number>();
  const jobs = new Set<Promise<unknown>>();
  const backgroundGates = new Map<string, ReturnType<typeof ownOriginalBackgroundResponseGate>>();
  const backgroundWaits = new Map<
    string,
    {
      role: 'allowed' | 'denied';
      path: string;
      after: number;
      done(): void;
      refuse(value: unknown): void;
    }
  >();
  const updateRedirectResponses = new Map<
    string,
    Readonly<{ status: 302; location: string; returned: Promise<void> }>
  >();
  const heldResponses = new Map<string, Promise<void>>();
  const fail = (value: unknown) => {
    first ??= { value };
  };
  const throwFirst = () => {
    if (first) throw first.value;
  };
  const own = <T>(original: Promise<T>): Promise<T> => {
    jobs.add(original);
    void original.then(
      () => jobs.delete(original),
      (value) => {
        fail(value);
        jobs.delete(original);
      }
    );
    return original;
  };
  const current = () => {
    throwFirst();
    if (retired) throw new Error('ORIGINAL_TUNNEL_RETIRED');
    options.signal.throwIfAborted();
    originalCurrent();
    throwFirst();
  };
  const serverCloses = new Map<Server, Promise<void>>();
  const fenceServers = () =>
    servers.map((server) => {
      const retained = serverCloses.get(server);
      if (retained) return retained;
      let resolve!: () => void, reject!: (value: unknown) => void;
      const original = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      // Publish the original close owner before entering the synchronous listener fence.
      serverCloses.set(server, original);
      void original.catch(fail);
      try {
        server.close((value) => (value ? reject(value) : resolve()));
      } catch (value) {
        reject(value);
      }
      return original;
    });
  const fenceWebsockets = () =>
    websocketServers.map((server) => {
      const retained = websocketServerCloses.get(server);
      if (retained) return retained;
      let resolve!: () => void, reject!: (value: unknown) => void;
      const original = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      websocketServerCloses.set(server, original);
      void original.catch(fail);
      try {
        server.close((value) => (value ? reject(value) : resolve()));
      } catch (value) {
        reject(value);
      }
      return original;
    });
  const stop = () => {
    for (const waiting of backgroundWaits.values())
      waiting.refuse(new Error('ORIGINAL_BACKGROUND_WAIT_CLOSED'));
    for (const gate of backgroundGates.values()) own(gate.close());
    fenceServers();
    fenceWebsockets();
    for (const retire of websocketRetirements.values()) {
      try {
        retire();
      } catch (value) {
        fail(value);
      }
    }
    try {
      resolver?.cancel();
    } catch (value) {
      fail(value);
    }
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGTERM');
        } catch (value) {
          fail(value);
        }
      }
    }
    for (const socket of [...tlsSockets, ...sockets]) {
      try {
        socket.destroy();
      } catch (value) {
        fail(value);
      }
    }
    for (const session of sessions) {
      try {
        session.destroy();
      } catch (value) {
        fail(value);
      }
    }
  };
  const abort = () => {
    fail(options.signal.reason);
    stop();
  };
  const observer = createDarwinProcessObserver(Object.freeze({ ...options.observer }));
  options.signal.addEventListener('abort', abort, { once: true });
  const addBirth = (row: Birth) => known.set(row.pid + ':' + row.birth, Object.freeze({ ...row }));
  const retainTree = async (root: Birth) => {
    const queue = [root];
    for (let at = 0; at < queue.length; at++) {
      if (queue.length > 64) throw new Error('ORIGINAL_TUNNEL_TREE_BOUND');
      const batch = await own(observer.children!(queue[at]!));
      if (!batch.complete) throw new Error('ORIGINAL_TUNNEL_TREE_UNVERIFIED');
      for (const fact of batch.processes) {
        if (fact.kind !== 'present') throw new Error('ORIGINAL_TUNNEL_TREE_UNVERIFIED');
        const birth = darwinBirth(fact.identity);
        if (known.has(birth.pid + ':' + birth.birth))
          throw new Error('ORIGINAL_TUNNEL_TREE_DUPLICATE');
        addBirth(birth);
        queue.push(birth);
      }
    }
  };
  const close = () => {
    retired = true;
    closing ??= Promise.resolve().then(async () => {
      // Fence every original listener before awaiting a producer that needs socket retirement.
      const serverReturns = [...fenceServers(), ...fenceWebsockets()];
      stop();
      await Promise.allSettled([
        ...serverReturns,
        ...terminals,
        ...jobs,
        ...children.flatMap((child) => [child.returned, child.closed, ...child.pipes]),
      ]);
      for (const descriptor of rawDescriptors) {
        try {
          closeSync(descriptor);
        } catch (value) {
          fail(value);
        }
      }
      rawDescriptors.clear();
      const facts: unknown[] = [];
      for (const row of known.values()) {
        try {
          const batch = await observer.inspect([row.pid]);
          const fact = batch.processes[0]!;
          const dead =
            fact.kind === 'absent' ||
            (fact.kind === 'present' && darwinBirth(fact.identity).birth !== row.birth);
          facts.push({
            ...row,
            status: dead ? 'dead' : fact.kind === 'unknown' ? 'unknown' : 'alive',
            fact,
          });
          if (!dead) fail(new Error('ORIGINAL_TUNNEL_BIRTH_NOT_DEAD'));
        } catch (value) {
          fail(value);
          facts.push({ ...row, status: 'unverified' });
        }
      }
      options.signal.removeEventListener('abort', abort);
      const report = {
        version: 1,
        nonce,
        returned: first ? 'FAIL' : 'PASS',
        matrixDeniedRequests: rows.filter(
          (row) => row.event === 'request' && row.role === 'denied' && row.phase === 'matrix'
        ).length,
        rows,
        knownBirths: [...known.values()],
        originalReturns: children.map(({ child, terminal, pipeFacts }) => ({
          pid: child.pid,
          ...terminal,
          pipes: pipeFacts,
        })),
        physical: facts,
        managerExcluded: 'This original preflight caller remains live; no caller death is claimed.',
      };
      try {
        if (created)
          await writeFile(join(options.artifacts, 'TERMINAL.json'), JSON.stringify(report) + '\n', {
            flag: 'wx',
            mode: 0o600,
          });
      } catch (value) {
        fail(value);
      }
      if (first) throw first.value;
      return Object.freeze(report);
    });
    void closing.catch(() => {});
    return closing;
  };
  try {
    current();
    if (!isAbsolute(options.artifacts)) throw new Error('ORIGINAL_TUNNEL_ARTIFACT_PATH');
    await mkdir(options.artifacts, { mode: 0o700 });
    created = true;
    current();
    if ((await realpath(options.artifacts)) !== options.artifacts)
      throw new Error('ORIGINAL_TUNNEL_ARTIFACT_PATH');
    const stat = await lstat(binary);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size !== originalBinary.size ||
      (await realpath(binary)) !== binary ||
      sha(await readFile(binary)) !== binarySHA256 ||
      sha(await readFile(receiptPath)) !== receiptSHA256
    )
      throw new Error('ORIGINAL_TUNNEL_BINARY_PIN');
    current();
    for (const role of ['allowed', 'denied'] as const) {
      current();
      const websocketServer = new WebSocketServer({
        noServer: true,
        clientTracking: false,
        maxPayload: 65536,
      });
      websocketServers.push(websocketServer);
      websocketServer.on('error', fail);
      const server = createServer((request, response) => {
        try {
          if (retired) {
            response.destroy();
            return;
          }
          if (rows.length >= 512) throw new Error('ORIGINAL_TUNNEL_REQUEST_BOUND');
          const originalPath = request.url ?? '';
          if (originalPath.length > 4096) throw new Error('ORIGINAL_TUNNEL_REQUEST_PATH');
          const path = new URL(originalPath, 'http://owned-fixture.invalid').pathname;
          if (path.length > 4096) throw new Error('ORIGINAL_TUNNEL_REQUEST_PATH');
          const row = Object.freeze({
            event: 'request' as const,
            role,
            phase,
            method: request.method ?? '',
            host: request.headers.host ?? '',
            path,
          });
          rows.push(row);
          for (const waiting of backgroundWaits.values())
            if (waiting.role === role && waiting.path === path && rows.length - 1 >= waiting.after)
              waiting.done();
          if (/^\/background-gate\/[a-f0-9-]{36}$/.test(path)) {
            const key = role + ':' + path;
            if (backgroundGates.has(key) || backgroundGates.size >= 32)
              throw new Error('ORIGINAL_BACKGROUND_GATE_BOUND');
            const gate = ownOriginalBackgroundResponseGate(response, current);
            backgroundGates.set(key, gate);
            own(gate.originalClose);
            return;
          }
          if (/^\/hold(?:\/[a-f0-9-]{36})?$/.test(path)) {
            const key = role + ':' + path;
            if (heldResponses.has(key)) throw new Error('ORIGINAL_TUNNEL_HELD_RESPONSE_DUPLICATE');
            let closed!: () => void;
            const originalClose = new Promise<void>((resolve) => {
              closed = resolve;
            });
            heldResponses.set(key, own(originalClose));
            // Retain the same original close before the first held-response write.
            response.once('close', () => {
              if (rows.length >= 512) fail(new Error('ORIGINAL_TUNNEL_REQUEST_BOUND'));
              else rows.push(Object.freeze({ ...row, event: 'response-close' as const }));
              closed();
            });
            response.setHeader('content-type', 'text/plain');
            response.write('Owned held response\n');
            return;
          }
          const calibration = path === '/calibrate/' + nonce || path === '/warm/' + nonce;
          const routeOrigins = Object.freeze([...origins]);
          const redirect = /^\/redirect\/([a-f0-9-]{36})$/.exec(path);
          const scripted = /^\/(?:worker|service-worker)\/[a-f0-9-]{36}\.js$/.test(path);
          const supplied = calibration ? undefined : originalReply?.(role, path, routeOrigins);
          const reply = supplied ?? {
            status: redirect ? (302 as const) : (200 as const),
            contentType: calibration
              ? ('text/plain' as const)
              : scripted
                ? ('application/javascript' as const)
                : ('text/html; charset=utf-8' as const),
            body: calibration
              ? role + ':' + nonce
              : (originalBody?.(role, path, routeOrigins) ??
                '<!doctype html><title>Owned tunnel fixture</title>'),
            location: redirect ? origins[1] + '/forbidden/' + redirect[1] : undefined,
          };
          // Capture bounded response fields once; no arbitrary headers or credentials accepted.
          const status = reply.status,
            contentType = reply.contentType,
            body = reply.body,
            location = reply.location,
            alternativeService = reply.alternativeService;
          if (
            ![200, 302].includes(status) ||
            !['text/plain', 'application/javascript', 'text/html; charset=utf-8'].includes(
              contentType
            ) ||
            typeof body !== 'string' ||
            Buffer.byteLength(body) > 65536
          )
            throw new Error('ORIGINAL_TUNNEL_REPLY_INVALID');
          if (status === 302) {
            if (typeof location !== 'string' || location.length > 4096)
              throw new Error('ORIGINAL_TUNNEL_REDIRECT_INVALID');
            const destination = new URL(location);
            if (
              destination.username ||
              destination.password ||
              destination.search ||
              destination.hash ||
              !origins.some((origin) => new URL(origin).origin === destination.origin)
            )
              throw new Error('ORIGINAL_TUNNEL_REDIRECT_INVALID');
          } else if (location !== undefined) throw new Error('ORIGINAL_TUNNEL_REDIRECT_INVALID');
          const advertisement =
            alternativeService === undefined
              ? undefined
              : originalOwnedAlternativeService(alternativeService, origins);
          current();
          response.statusCode = status;
          response.setHeader('content-type', contentType);
          if (location !== undefined) response.setHeader('location', location);
          if (advertisement !== undefined && alternativeService !== undefined)
            writeOriginalOwnedAlternativeService(response, alternativeService, origins);
          if (
            role === 'allowed' &&
            /^\/update-redirect\/[a-f0-9-]{36}\.js$/.test(path) &&
            status === 302 &&
            location !== undefined
          ) {
            if (updateRedirectResponses.has(path) || updateRedirectResponses.size >= 32)
              throw new Error('ORIGINAL_UPDATE_REDIRECT_RESPONSE_BOUND');
            let complete!: () => void, refuse!: (value: unknown) => void;
            const returned = new Promise<void>((yes, no) => {
              complete = yes;
              refuse = no;
            });
            own(returned);
            updateRedirectResponses.set(path, Object.freeze({ status, location, returned }));
            response.once('close', complete);
            response.once('error', (value: unknown) => {
              fail(value);
              refuse(value);
            });
          }
          response.end(body);
        } catch (value) {
          fail(value);
          response.destroy();
        }
      });
      servers.push(server);
      server.on('upgrade', (request, socket, head) => {
        try {
          current();
          const originalPath = request.url ?? '';
          if (originalPath.length > 4096) throw new Error('ORIGINAL_TUNNEL_REQUEST_PATH');
          const path = new URL(originalPath, 'http://owned-fixture.invalid').pathname;
          if (
            !/^\/socket\/[a-f0-9-]{36}$/.test(path) ||
            ++acceptedUpgrades > 64 ||
            rows.length >= 512
          )
            throw new Error('ORIGINAL_TUNNEL_UPGRADE_BOUND');
          const row = Object.freeze({
            event: 'request' as const,
            role,
            phase,
            method: request.method ?? '',
            host: request.headers.host ?? '',
            path,
          });
          rows.push(row);
          websocketServer.handleUpgrade(request, socket, head, (peer) => {
            const terminate = peer.terminate.bind(peer),
              send = peer.send.bind(peer);
            websocketPeers.add(peer);
            websocketRetirements.set(peer, terminate);
            terminals.push(
              new Promise<void>((resolve) =>
                peer.once('close', () => {
                  websocketPeers.delete(peer);
                  websocketRetirements.delete(peer);
                  if (rows.length < 512)
                    rows.push(
                      Object.freeze({
                        ...row,
                        event: 'response-close' as const,
                      })
                    );
                  else fail(new Error('ORIGINAL_TUNNEL_REQUEST_BOUND'));
                  resolve();
                })
              )
            );
            peer.on('error', fail);
            let received = 0;
            peer.on('message', (bytes, binary) => {
              try {
                current();
                const size = Array.isArray(bytes)
                  ? bytes.reduce((sum, part) => sum + part.length, 0)
                  : bytes instanceof ArrayBuffer
                    ? bytes.byteLength
                    : bytes.length;
                received += size;
                if (size > 65536 || received > 262144)
                  throw new Error('ORIGINAL_TUNNEL_WEBSOCKET_BOUND');
                let resolve!: () => void, reject!: (value: unknown) => void;
                const originalSend = new Promise<void>((yes, no) => {
                  resolve = yes;
                  reject = no;
                });
                own(originalSend);
                try {
                  send(bytes, { binary }, (value) => {
                    if (value) {
                      fail(value);
                      reject(value);
                      stop();
                    } else resolve();
                  });
                } catch (value) {
                  reject(value);
                  throw value;
                }
              } catch (value) {
                fail(value);
                stop();
              }
            });
            try {
              current();
            } catch (value) {
              fail(value);
              stop();
            }
          });
        } catch (value) {
          fail(value);
          try {
            socket.destroy();
          } catch (cause) {
            fail(cause);
          }
          stop();
        }
      });
      server.on('connection', (socket) => {
        socket.on('error', fail);
        sockets.add(socket);
        terminals.push(
          new Promise<void>((resolve) =>
            socket.once('close', () => {
              sockets.delete(socket);
              resolve();
            })
          )
        );
        // Bound accepted originals independently of requests, retaining excess close first.
        if (terminals.length > 512) {
          fail(new Error('ORIGINAL_TUNNEL_CONNECTION_BOUND'));
          try {
            socket.destroy();
          } catch (value) {
            fail(value);
          }
          stop();
        }
      });
      server.on('error', fail);
      current();
      await own(
        new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', () => {
            server.removeListener('error', reject);
            resolve();
          });
        })
      );
      current();
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('ORIGINAL_TUNNEL_ENDPOINT');
      const home = join(options.artifacts, role),
        tmp = join(home, 'tmp'),
        config = join(home, 'config.yml');
      await mkdir(home, { mode: 0o700 });
      current();
      await mkdir(tmp, { mode: 0o700 });
      current();
      await writeFile(config, '{}\n', { flag: 'wx', mode: 0o600 });
      current();
      const args = [
        'tunnel',
        '--config',
        config,
        '--no-autoupdate',
        '--url',
        'http://127.0.0.1:' + address.port,
        '--metrics',
        '127.0.0.1:0',
        '--grace-period',
        '5s',
        '--loglevel',
        'info',
      ];
      const descriptors = new Map<string, number>();
      for (const name of ['stdout', 'stderr']) {
        const descriptor = openSync(join(home, name + '.raw'), 'wx', 0o600);
        rawDescriptors.add(descriptor);
        descriptors.set(name, descriptor);
      }
      current();
      const child = spawn(binary, args, {
        cwd: home,
        env: {
          HOME: home,
          TMPDIR: tmp,
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          LANG: 'C',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const terminal: { code?: number | null; signal?: string | null } = {};
      const pipeFacts: Array<{
        name: string;
        path: string;
        bytes: number;
        eof: boolean;
      }> = [];
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      const returned = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => {
          terminal.code = code;
          terminal.signal = signal;
          if (!retired && !options.signal.aborted)
            reject(new Error('ORIGINAL_TUNNEL_PREMATURE_RETURN'));
          else if (code === 0 || signal === 'SIGTERM') resolve();
          else reject(new Error('ORIGINAL_TUNNEL_BAD_RETURN'));
        });
      });
      const pipes: Promise<void>[] = [];
      children.push({
        child,
        returned: own(returned),
        closed,
        pipes,
        terminal,
        pipeFacts,
      });
      let found: string | undefined,
        text = '';
      let publish!: (host: string) => void, rejectHost!: (cause: unknown) => void;
      const announced = own(
        new Promise<string>((resolve, reject) => {
          publish = resolve;
          rejectHost = reject;
        })
      );
      void returned.then(() => rejectHost(new Error('ORIGINAL_TUNNEL_NO_ROUTE')), rejectHost);
      for (const [name, stream] of [
        ['stdout', child.stdout],
        ['stderr', child.stderr],
      ] as const) {
        if (!stream) throw new Error('ORIGINAL_TUNNEL_PIPE');
        const fd = descriptors.get(name)!;
        const pipeFact = {
          name,
          path: join(home, name + '.raw'),
          bytes: 0,
          eof: false,
        };
        pipeFacts.push(pipeFact);
        let bytes = 0;
        const pipe = new Promise<void>((resolve, reject) => {
          stream.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            try {
              if (bytes > 8 * 1024 * 1024) throw new Error('ORIGINAL_TUNNEL_LOG_BOUND');
              let offset = 0;
              while (offset < chunk.length) {
                const written = writeSync(fd, chunk, offset, chunk.length - offset);
                if (written <= 0) throw new Error('ORIGINAL_TUNNEL_LOG_WRITE');
                offset += written;
                pipeFact.bytes += written;
              }
            } catch (value) {
              fail(value);
              stop();
            }
            text = (text + chunk.toString('utf8')).slice(-16384);
            for (const match of text.matchAll(
              /https:\/\/([a-z0-9-]+\.trycloudflare\.com)(?=[\s|/]|$)/g
            )) {
              if (found && found !== match[1]) {
                fail(new Error('ORIGINAL_TUNNEL_CONFLICTING_ROUTE'));
                stop();
              }
              found = match[1];
              publish(found!);
            }
          });
          let ended = false;
          stream.once('end', () => {
            ended = true;
            pipeFact.eof = true;
          });
          stream.once('error', (value) => {
            fail(value);
            stop();
          });
          stream.once('close', () => {
            rawDescriptors.delete(fd);
            try {
              closeSync(fd);
            } catch (value) {
              fail(value);
            }
            if (ended) resolve();
            else reject(new Error('ORIGINAL_TUNNEL_PIPE_EOF_UNVERIFIED'));
          });
        });
        pipes.push(own(pipe));
      }
      if (!child.pid) throw new Error('ORIGINAL_TUNNEL_PID');
      const batch = await own(observer.inspect([child.pid]));
      const fact = batch.processes[0]!;
      if (fact.kind !== 'present' || fact.zombie || fact.parentPid !== process.pid)
        throw new Error('ORIGINAL_TUNNEL_BIRTH_UNVERIFIED');
      const birth = darwinBirth(fact.identity);
      addBirth(birth);
      const host = await announced;
      current();
      origins.push('https://' + host + ':443');
      await retainTree(birth);
      await writeFile(
        join(home, 'OWNER.json'),
        JSON.stringify({
          pid: child.pid,
          birth,
          args,
          endpoint: 'http://127.0.0.1:' + address.port,
          origin: origins.at(-1),
        }) + '\n',
        { flag: 'wx', mode: 0o600 }
      );
    }
    if (origins[0] === origins[1]) throw new Error('ORIGINAL_TUNNEL_DISTINCT_ROUTES');
    resolver = new Resolver({ tries: 1 });
    const dns = [];
    for (const origin of origins) {
      const hostname = new URL(origin).hostname;
      const query = async (kind: 'A' | 'AAAA' | 'CNAME') => {
        current();
        // A genuine missing RR is an observed empty result, not a swallowed producer failure.
        const original =
          kind === 'A'
            ? resolver!.resolve4(hostname, { ttl: true })
            : kind === 'AAAA'
              ? resolver!.resolve6(hostname, { ttl: true })
              : resolver!.resolveCname(hostname);
        return await own<string[] | RecordWithTtl[]>(
          original.catch((value) => {
            if (
              typeof value === 'object' &&
              value !== null &&
              'code' in value &&
              (value.code === 'ENODATA' || value.code === 'ENOTFOUND')
            )
              return [];
            throw value;
          })
        );
      };
      dns.push({
        hostname,
        A: await query('A'),
        AAAA: await query('AAAA'),
        CNAME: await query('CNAME'),
      });
    }
    const addresses = dns.map((row) =>
      [...row.A, ...row.AAAA]
        .map((row) => (typeof row === 'string' ? row : row.address))
        .filter((address) => classifyAddress(address).kind === 'global')
    );
    const commonAddresses = addresses[0]!.filter((address) => addresses[1]!.includes(address));
    if (addresses.some((rows) => !rows.length))
      throw new Error('ORIGINAL_TUNNEL_PUBLIC_IP_REQUIRED');
    if (sharedAuthorityCampaign === 'required' && !commonAddresses.length)
      throw new Error('ORIGINAL_TUNNEL_NO_COMMON_PUBLIC_IP');
    const selected = sharedAuthorityCampaign === 'required' ? commonAddresses[0]! : undefined,
      tlsProof: unknown[] = [],
      warm: unknown[] = [];
    let leafSHA256: string | undefined;
    for (let at = 0; at < origins.length; at++) {
      current();
      const origin = origins[at]!,
        hostname = new URL(origin).hostname;
      const socket = tlsConnect({
        host: selected ?? addresses[at]![0]!,
        servername: hostname,
        port: 443,
        ALPNProtocols: ['h2'],
        rejectUnauthorized: true,
      });
      tlsSockets.push(socket);
      terminals.push(new Promise<void>((resolve) => socket.once('close', () => resolve())));
      socket.on('error', fail);
      await own(
        new Promise<void>((resolve, reject) => {
          socket.once('secureConnect', resolve);
          socket.once('error', reject);
        })
      );
      current();
      if (!socket.authorized || socket.alpnProtocol !== 'h2')
        throw new Error('ORIGINAL_TUNNEL_TLS_H2_UNVERIFIED');
      const certificate = socket.getPeerCertificate();
      if (!certificate.raw) throw new Error('ORIGINAL_TUNNEL_SHARED_SAN_UNVERIFIED');
      const originalLeaf = new X509Certificate(certificate.raw);
      if (
        typeof certificate.subjectaltname !== 'string' ||
        !certificate.subjectaltname.length ||
        (sharedAuthorityCampaign === 'required' ? origins : [origin]).some(
          (origin) =>
            checkServerIdentity(new URL(origin).hostname, certificate) ||
            !originalLeaf.checkHost(new URL(origin).hostname, {
              subject: 'never',
            })
        )
      )
        throw new Error('ORIGINAL_TUNNEL_SHARED_SAN_UNVERIFIED');
      const leaf = sha(certificate.raw);
      if (sharedAuthorityCampaign === 'required' && leafSHA256 && leafSHA256 !== leaf)
        throw new Error('ORIGINAL_TUNNEL_DIFFERENT_LEAF');
      leafSHA256 ??= leaf;
      tlsProof.push({
        hostname,
        selectedAddress: selected ?? addresses[at]![0]!,
        addressFamily: classifyAddress(selected ?? addresses[at]![0]!).family,
        leafSHA256: leaf,
        subjectaltname: certificate.subjectaltname,
        chainAuthorized: socket.authorized,
        alpn: socket.alpnProtocol,
        localAddress: socket.localAddress,
        localPort: socket.localPort,
        remoteAddress: socket.remoteAddress,
        remotePort: socket.remotePort,
      });
      current();
      const session = connect(origin, { createConnection: () => socket });
      sessions.push(session);
      terminals.push(new Promise<void>((resolve) => session.once('close', resolve)));
      session.on('error', fail);
      const sessionId = nonce + ':' + at;
      for (const name of ['calibrate', 'warm']) {
        current();
        const path = '/' + name + '/' + nonce;
        const request = session.request({
          ':method': 'GET',
          ':authority': hostname,
          ':path': path,
        });
        let status: number | undefined,
          body = '';
        request.on('response', (headers) => {
          status = Number(headers[':status']);
        });
        request.on('data', (chunk) => {
          body += chunk.toString();
          if (body.length > 4096) {
            fail(new Error('ORIGINAL_TUNNEL_CALIBRATION_BOUND'));
            request.destroy();
          }
        });
        await own(
          new Promise<void>((resolve, reject) => {
            request.once('error', reject);
            request.once('end', resolve);
            request.end();
          })
        );
        current();
        if (status !== 200 || body !== (at === 0 ? 'allowed' : 'denied') + ':' + nonce)
          throw new Error('ORIGINAL_TUNNEL_CALIBRATION_FAILED');
        warm.push({
          sessionId,
          hostname,
          authority: hostname,
          path,
          status,
          originalStreamId: request.id,
        });
      }
    }
    current();
    if (
      rows.length !== 4 ||
      rows.some(
        (row) =>
          row.phase !== 'calibration' ||
          row.event !== 'request' ||
          !['/calibrate/' + nonce, '/warm/' + nonce].includes(row.path)
      )
    )
      throw new Error('ORIGINAL_TUNNEL_CALIBRATION_INTERFERENCE');
    phase = 'matrix';
    const freeze = <T>(value: T): T => {
      if (typeof value === 'object' && value !== null) {
        for (const nested of Object.values(value)) freeze(nested);
        Object.freeze(value);
      }
      return value;
    };
    const proof = freeze({
      version: 1,
      nonce,
      observedAt: Date.now(),
      origins: Object.freeze([...origins]),
      dns,
      sharedAuthorityCampaign,
      sharedIPSharedSANH2:
        sharedAuthorityCampaign === 'deferred'
          ? 'DEFERRED_UNVERIFIED'
          : 'TOPOLOGY_OBSERVED_BROWSER_CASE_REQUIRED',
      selectedAddress: selected ?? null,
      commonAddresses: Object.freeze([...commonAddresses]),
      leafSHA256,
      tls: tlsProof,
      warm,
      scope:
        sharedAuthorityCampaign === 'required'
          ? 'Observed Node TLS/H2 shared topology and positive origins. Chromium coalescing is not established here.'
          : 'Observed independent original public TLS/H2 origins. Shared-IP/shared-SAN campaign is deferred/unverified; no shared topology or coalescing claim.',
    });
    await writeFile(join(options.artifacts, 'PREFLIGHT.json'), JSON.stringify(proof) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    current();
    const port: OriginalQuickTunnelPort = Object.freeze({
      allowedOrigin: origins[0]!,
      deniedOrigin: origins[1]!,
      sharedAuthorityCampaign,
      allowedAddresses: Object.freeze([...addresses[0]!]),
      commonAddresses: Object.freeze([...commonAddresses]),
      leafSHA256: leafSHA256!,
      proof,
      assertCurrent: current,
      observations: () => {
        current();
        return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
      },
      awaitOriginalResponseClose(role: 'allowed' | 'denied', path: string) {
        current();
        const retained = heldResponses.get(role + ':' + path);
        if (!retained) throw new Error('ORIGINAL_TUNNEL_HELD_RESPONSE_UNOBSERVED');
        return retained;
      },
      awaitOriginalBackgroundRequest(
        role: 'allowed' | 'denied',
        path: string,
        after: number,
        signal: AbortSignal
      ) {
        current();
        if (
          !/^\/(?:background-gate|background-worker|background-positive|background-completed)\/[a-f0-9-]{36}(?:\.js|\/(?:denied|accepted))?$/.test(
            path
          ) ||
          !Number.isSafeInteger(after) ||
          after < 0 ||
          after > rows.length
        )
          throw new Error('ORIGINAL_BACKGROUND_WAIT_SCOPE');
        signal.throwIfAborted();
        if (
          rows
            .slice(after)
            .some((row) => row.event === 'request' && row.role === role && row.path === path)
        )
          return Promise.resolve();
        const key = role + ':' + path + ':' + after;
        if (backgroundWaits.has(key) || backgroundWaits.size >= 32)
          throw new Error('ORIGINAL_BACKGROUND_WAIT_BOUND');
        let done!: () => void, refuse!: (value: unknown) => void;
        const returned = new Promise<void>((yes, no) => {
          done = yes;
          refuse = no;
        });
        const abort = () => refuse(signal.reason);
        backgroundWaits.set(key, { role, path, after, done, refuse });
        jobs.add(returned);
        const release = () => {
          signal.removeEventListener('abort', abort);
          backgroundWaits.delete(key);
          jobs.delete(returned);
        };
        void returned.then(release, release);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        return returned;
      },
      originalUpdateRedirectResponse(path: string) {
        current();
        const retained = updateRedirectResponses.get(path);
        if (!retained) throw new Error('ORIGINAL_UPDATE_REDIRECT_RESPONSE_UNOBSERVED');
        return retained;
      },
      originalBackgroundGateTerminal(role: 'allowed' | 'denied', path: string) {
        current();
        const gate = backgroundGates.get(role + ':' + path);
        if (!gate) throw new Error('ORIGINAL_BACKGROUND_GATE_UNOBSERVED');
        return Object.freeze({ returned: gate.originalClose, closed: gate.isOriginalClosed });
      },
      releaseOriginalBackgroundGate(role: 'allowed' | 'denied', path: string) {
        current();
        const gate = backgroundGates.get(role + ':' + path);
        if (!gate) throw new Error('ORIGINAL_BACKGROUND_GATE_UNOBSERVED');
        return gate.releaseOriginalResponse();
      },
      close,
    });
    originalPorts.set(port, () => {
      current();
      return port;
    });
    return Object.freeze({
      port: () => readOriginalQuickTunnelPort(port),
      close,
    });
  } catch (value) {
    fail(value);
    try {
      await close();
    } catch {
      /* Same boxed original first failure remains. */
    }
    throw first!.value;
  }
}
