import { createServer } from 'node:http';
import { connect as connectTLS } from 'node:tls';
import { Socket } from 'node:net';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import type { DarwinOwnedChild } from '../darwin-owned-child.js';
import { NativeIdentitySchema, type NativeIdentity } from './native-observation.js';

type Original = {
  current(): void;
  argv: readonly string[];
  proxy: Readonly<{ url: string; credentials: Readonly<{ username: string; password: string }> }>;
  withholdFirstIdentityAcknowledgement?: true;
  captureChild(child: DarwinOwnedChild): Promise<void>;
  captureConsumedBaseline(identity: NativeIdentity): void;
  captureShutdown(join: () => Promise<unknown>): void;
  captureWithheld(value: boolean): void;
};
const leases = new WeakMap<object, Original>();
/** Only the actual local TLS peer and constructor-owned fixed proxy mint this private lease.
 * It grants fixture network configuration only, never UA/SDK/metadata/native qualification. */
export function createSupervisorIdentityAcceptance(
  options: Readonly<{
    fixtureURL: string;
    certificateSPKI: string;
    mutant?: 'missing-first-init-ack';
    /** Constructor-private original observer registration, before candidate can close. */
    onOriginalChild?(child: DarwinOwnedChild): Promise<void>;
  }>
) {
  const peer = new URL(options.fixtureURL);
  const pin = options.certificateSPKI;
  if (
    peer.protocol !== 'https:' ||
    peer.hostname !== 'identity-alpha.test' ||
    !peer.port ||
    Number(peer.port) > 65535 ||
    peer.pathname !== '/baseline' ||
    peer.username ||
    peer.password ||
    peer.search ||
    peer.hash ||
    !/^[A-Za-z0-9+/]{43}=$/.test(pin)
  )
    throw new Error('IDENTITY_ACCEPTANCE_PEER_REFUSED');
  const port = Number(peer.port);
  const password = randomBytes(24).toString('hex');
  const expected = 'Basic ' + Buffer.from('dorkos:' + password).toString('base64');
  const duties = new Set<Promise<unknown>>(),
    sockets = new Map<Socket, Promise<void>>();
  let stopped = false,
    first: Readonly<{ value: unknown }> | undefined;
  let opening: Promise<object> | undefined, closing: Promise<void> | undefined;
  let child: DarwinOwnedChild | undefined, joinShutdown: (() => Promise<unknown>) | undefined;
  let withheld = false,
    listening = false;
  let consumedBaseline: NativeIdentity | undefined;
  const closedAdmission = new Error('IDENTITY_ACCEPTANCE_CLOSED');
  const note = (value: unknown) => {
    if (value !== closedAdmission) first ??= { value };
  };
  const current = () => {
    if (first || stopped) throw first ? first.value : closedAdmission;
  };
  const track = <T>(produce: () => Promise<T> | T): Promise<T> => {
    const original = Promise.resolve().then(produce);
    duties.add(original);
    void original.then(
      () => duties.delete(original),
      (value) => {
        note(value);
        duties.delete(original);
      }
    );
    return original;
  };
  const ownSocket = (socket: Socket) => {
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    if (sockets.size >= 32) {
      socket.destroy();
      note(new Error('IDENTITY_ACCEPTANCE_SOCKET_BOUND'));
    }
    sockets.set(socket, closed);
    socket.on('error', note);
    void closed.then(() => sockets.delete(socket));
    return closed;
  };
  const server = createServer((_request, response) => {
    // This proxy carries only fixed CONNECT tunnels; it never serves/fakes identity observations.
    response.writeHead(405, { Connection: 'close' });
    response.end();
  });
  server.maxConnections = 16;
  server.on('error', note);
  server.on('connection', (socket) => {
    ownSocket(socket);
    if (stopped) socket.destroy();
  });
  server.on('connect', (request, socket, head) => {
    try {
      current();
      if (
        head.length ||
        !['identity-alpha.test:' + port, 'identity-beta.test:' + port].includes(request.url ?? '')
      )
        throw new Error('IDENTITY_ACCEPTANCE_TUNNEL_REFUSED');
      if (request.headers['proxy-authorization'] !== expected) {
        socket.end(
          'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="dorkos-identity"\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
        );
        return;
      }
      if (sockets.size >= 32) throw new Error('IDENTITY_ACCEPTANCE_SOCKET_BOUND');
      const upstream = new Socket();
      ownSocket(upstream);
      socket.once('close', () => upstream.destroy());
      upstream.once('close', () => socket.destroy());
      upstream.once('connect', () => {
        try {
          current();
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          socket.pipe(upstream);
          upstream.pipe(socket);
        } catch (value) {
          note(value);
          socket.destroy();
          upstream.destroy();
        }
      });
      upstream.connect(port, '127.0.0.1');
    } catch (value) {
      note(value);
      socket.destroy();
    }
  });
  const owner = Object.freeze({
    open(): Promise<object> {
      if (opening) return opening;
      opening = track(async () => {
        current();
        const probe = connectTLS({
          host: '127.0.0.1',
          port,
          servername: 'identity-alpha.test',
          rejectUnauthorized: false,
        });
        const closed = ownSocket(probe);
        let primary: Readonly<{ value: unknown }> | undefined;
        try {
          await track(
            () =>
              new Promise<void>((resolve, reject) => {
                const timer = setTimeout(
                  () => reject(new Error('IDENTITY_ACCEPTANCE_TLS_DEADLINE')),
                  5000
                );
                const fail = (value: unknown) => {
                  clearTimeout(timer);
                  reject(value);
                };
                probe.once('error', fail);
                probe.once('secureConnect', () => {
                  try {
                    current();
                    const certificate = probe.getPeerCertificate().raw;
                    if (
                      !certificate ||
                      createHash('sha256')
                        .update(
                          new X509Certificate(certificate).publicKey.export({
                            type: 'spki',
                            format: 'der',
                          })
                        )
                        .digest('base64') !== pin
                    )
                      throw new Error('IDENTITY_ACCEPTANCE_TLS_PIN_REFUSED');
                    clearTimeout(timer);
                    probe.off('error', fail);
                    resolve();
                  } catch (value) {
                    fail(value);
                  }
                });
              })
          );
        } catch (value) {
          primary = { value };
          note(value);
        }
        try {
          probe.destroy();
          await closed;
        } catch (value) {
          primary ??= { value };
          note(value);
        }
        if (primary) throw primary.value;
        current();
        await track(
          () =>
            new Promise<void>((resolve, reject) => {
              current();
              server.once('error', reject);
              server.listen(0, '127.0.0.1', () => {
                listening = true;
                resolve();
              });
            })
        );
        current();
        const address = server.address();
        if (!address || typeof address === 'string' || address.address !== '127.0.0.1')
          throw new Error('IDENTITY_ACCEPTANCE_PROXY_UNOBSERVED');
        const proxy = Object.freeze({
          url: 'http://127.0.0.1:' + address.port,
          credentials: Object.freeze({ username: 'dorkos', password }),
        });
        const lease = Object.freeze({});
        leases.set(
          lease,
          Object.freeze({
            current,
            proxy,
            argv: Object.freeze([
              '--site-per-process',
              '--host-resolver-rules=MAP identity-alpha.test 127.0.0.1, MAP identity-beta.test 127.0.0.1',
              '--ignore-certificate-errors-spki-list=' + pin,
            ]),
            ...(options.mutant ? { withholdFirstIdentityAcknowledgement: true as const } : {}),
            captureConsumedBaseline(value: NativeIdentity) {
              if (consumedBaseline) throw new Error('IDENTITY_ACCEPTANCE_BASELINE_REPLACED');
              consumedBaseline = NativeIdentitySchema.parse(structuredClone(value));
            },
            async captureChild(value: DarwinOwnedChild) {
              if (child && child !== value) throw new Error('IDENTITY_ACCEPTANCE_CHILD_REPLACED');
              child = value;
              await options.onOriginalChild?.(value);
            },
            captureShutdown(value: () => Promise<unknown>) {
              if (joinShutdown) throw new Error('IDENTITY_ACCEPTANCE_SHUTDOWN_REPLACED');
              joinShutdown = value;
            },
            captureWithheld(value: boolean) {
              withheld ||= value;
            },
          })
        );
        return lease;
      });
      return opening;
    },
    child: () => child,
    nativeBaseline: () => (consumedBaseline ? structuredClone(consumedBaseline) : undefined),
    identityAcknowledgementWithheld: () => withheld,
    async joinOriginalShutdown() {
      if (joinShutdown) await joinShutdown();
    },
    close(): Promise<void> {
      if (closing) return closing;
      stopped = true;
      closing = Promise.resolve().then(async () => {
        // Stop current sockets before joining a possibly held probe/CONNECT operation.
        const closes = [...sockets.values()];
        for (const socket of sockets.keys())
          try {
            socket.destroy();
          } catch (value) {
            note(value);
          }
        // Join the original open/listen even if its callback returns after stop entered.
        // Admission is already closed and every new connection is destroyed.
        for (const result of await Promise.allSettled([...duties]))
          if (result.status === 'rejected') note(result.reason);
        const lateCloses = [...sockets.values()];
        for (const socket of sockets.keys())
          try {
            socket.destroy();
          } catch (value) {
            note(value);
          }
        const stop = server.listening
          ? new Promise<void>((resolve, reject) => {
              try {
                server.close((value) => (value == null ? resolve() : reject(value)));
              } catch (value) {
                reject(value);
              }
            })
          : Promise.resolve();
        const results = await Promise.allSettled([stop, ...closes, ...lateCloses, ...duties]);
        for (const result of results) if (result.status === 'rejected') note(result.reason);
        if (listening && server.listening) note(new Error('IDENTITY_ACCEPTANCE_LISTENER_HELD'));
        if (first) throw first.value;
      });
      return closing;
    },
  });
  return owner;
}
/** One-use fixture configuration on an actual original peer. No copied DTO grants a launch. */
export function consumeSupervisorIdentityAcceptance(lease: object): Original {
  const original = leases.get(lease);
  if (!original) throw new Error('IDENTITY_ACCEPTANCE_LEASE_REFUSED');
  leases.delete(lease);
  original.current();
  return original;
}
