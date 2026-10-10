/**
 * The managed remote-access ingress: a loopback-only HTTP listener that the
 * managed ngrok session forwards into, and that hands admitted requests to the
 * main Express app.
 *
 * A listener of its own, rather than forwarding managed traffic straight at the
 * main port, because that is the only way to know for certain which requests
 * came through managed access. Everything that arrives here gets the edge checks
 * below before any other handling — before login, sessions, routing or
 * activity counting — and the main listener stays exactly what it was:
 *
 * 1. **Draining** — once a close has begun, new requests get 503 while the ones
 *    already admitted finish.
 * 2. **Edge proof** — exactly one copy of the proof header, matching in constant
 *    time (see `edge-proof.ts`), then the header is removed so the secret never
 *    reaches the app.
 * 3. **Host** — the `Host` must be one of the hostnames managed access serves
 *    right now, compared without regard to case.
 * 4. **Paths** — `/a2a` and `/.well-known/agent*` are not offered over managed
 *    access (DOR-2085 decides when they are).
 * 5. **Mark** — the request is marked as managed (`ingress-mark.ts`) and
 *    `res.locals.ingress` is `'managed'`, so `isLocalCaller` can never mistake
 *    it for a person at this machine, even though its TCP peer is loopback.
 *
 * WebSocket upgrades take the same checks and are then handed to the main
 * server's one upgrade router, so every stream keeps its own credential gate.
 *
 * @module services/core/remote/managed-ingress
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import type { RemoteEdgeProof } from '@dork-labs/cloud-api';
import { parseHostname } from '../../../lib/trusted-origins.js';
import { logger } from '../../../lib/logger.js';
import {
  checkEdgeProof,
  dropPreviousEdgeProof,
  initialEdgeProofState,
  rotateEdgeProofState,
  stripEdgeProofHeaders,
  type EdgeProofState,
} from './edge-proof.js';
import { markManagedIngress } from './ingress-mark.js';

/** What the ingress hands admitted traffic to. */
export interface ManagedIngressOptions {
  /** The main server's request listener: its front door, which hands on to the Express app. */
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  /**
   * Hand an admitted upgrade to the main server's upgrade router — in
   * production, `(req, socket, head) => mainServer.emit('upgrade', req, socket, head)`.
   */
  forwardUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  /** The clock for the previous proof's deadline. Defaults to `Date.now`. */
  now?: () => number;
}

/** The managed ingress listener. One per process; owned by `TunnelManager`. */
export interface ManagedIngress {
  /**
   * Start listening on `127.0.0.1` at a free port, or reuse the open listener.
   *
   * @returns The URL managed forwarding should target, e.g. `http://127.0.0.1:53123`.
   */
  open(): Promise<string>;
  /** The hostnames requests may name in `Host`; replaces the whole set. */
  setHosts(hosts: readonly string[]): void;
  /**
   * Set the edge proof. The first call sets it; a later call with a different
   * proof keeps the old one acceptable until `confirmedAt` plus the overlap.
   */
  setEdgeProof(proof: RemoteEdgeProof, confirmedAt?: number): void;
  /** Stop accepting the previous proof now, as a revoke of its credential requires. */
  dropPreviousEdgeProof(): void;
  /** Answer 503 to every new request; requests already admitted run on. */
  beginDrain(): void;
  /** Whether new requests are being refused because a close has begun. */
  readonly draining: boolean;
  /** How many admitted HTTP requests have not finished yet. */
  readonly inFlight: number;
  /**
   * Stop listening. `immediate: false` waits for admitted requests to finish
   * first; `immediate: true` cuts every connection now, and also hurries along
   * a gentle close already in progress. Either way every forwarded WebSocket is
   * closed, and the hosts and proof are forgotten.
   */
  close(options: { immediate: boolean }): Promise<void>;
}

/**
 * Whether a request target is plain origin-form (`/path?query`), the only shape
 * the managed edge forwards. Anything else — absolute-form
 * (`http://host/path`), asterisk-form, or a target carrying a `#` — is refused,
 * because Express would route it by a pathname this check never saw:
 * `parseurl` reads `http://h/a2a` and `/a2a#x` both as `/a2a`.
 */
function isOriginForm(target: string): boolean {
  return target.startsWith('/') && !target.includes('#');
}

/**
 * Paths never served over managed access until DOR-2085 decides otherwise.
 *
 * Takes an origin-form target only (see {@link isOriginForm}), whose pathname
 * is exactly what `parseurl` hands the Express router: everything before the
 * first `?`. The router matches that raw pathname without regard to case, so
 * this does too, and it also refuses the decoded form, which is stricter than
 * the router and never looser.
 */
function isRefusedPath(target: string): boolean {
  const raw = target.split('?')[0]!.toLowerCase();
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw).toLowerCase();
  } catch {
    return true; // A path that does not decode is not one this listener serves.
  }
  return [raw, decoded].some(
    (path) => path === '/a2a' || path.startsWith('/a2a/') || path.startsWith('/.well-known/agent')
  );
}

/** How many copies of a header (lower-case name) a request carries. */
function countHeader(rawHeaders: readonly string[], name: string): number {
  let count = 0;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i]!.toLowerCase() === name) count += 1;
  }
  return count;
}

type Refusal = { status: number; message: string; reason: string };

/**
 * The production managed ingress: requests go to `handler`, the same listener
 * the main server serves, and admitted upgrades go to `server`'s upgrade router.
 *
 * @param handler - The main server's request listener.
 * @param server - The main server, whose `upgrade` listener is the upgrade router.
 */
export function managedIngressFor(
  handler: http.RequestListener,
  server: http.Server
): ManagedIngress {
  return createManagedIngress({
    handler,
    forwardUpgrade: (req, socket, head) => server.emit('upgrade', req, socket, head),
  });
}

/**
 * Create the managed ingress. Nothing listens until {@link ManagedIngress.open}.
 *
 * @param options - Where admitted traffic goes, and the clock.
 */
export function createManagedIngress(options: ManagedIngressOptions): ManagedIngress {
  const now = options.now ?? Date.now;
  let server: http.Server | null = null;
  let url: string | null = null;
  let opening: Promise<string> | null = null;
  let closing: Promise<void> | null = null;
  let hosts = new Set<string>();
  let proof: EdgeProofState | null = null;
  let draining = false;
  let inFlight = 0;
  let idleWaiters: (() => void)[] = [];
  const upgraded = new Set<Duplex>();

  /** The edge checks every request and upgrade passes, in order; `null` admits. */
  function refusalFor(req: IncomingMessage): Refusal | null {
    if (draining || !proof) {
      return { status: 503, message: 'Remote access is closing.', reason: 'draining' };
    }
    const check = checkEdgeProof(req.rawHeaders, proof, now());
    if (!check.ok) {
      return { status: 403, message: 'Forbidden.', reason: `edge_proof_${check.reason}` };
    }
    stripEdgeProofHeaders(req, proof);
    // Node keeps the first of two `Host` headers; refuse rather than guess.
    if (countHeader(req.rawHeaders, 'host') !== 1) {
      return { status: 400, message: 'Bad request.', reason: 'host_not_single' };
    }
    const hostname = parseHostname(req.headers.host);
    if (!hostname || !hosts.has(hostname)) {
      return { status: 421, message: 'Misdirected request.', reason: 'host_not_served' };
    }
    const target = req.url ?? '';
    if (!isOriginForm(target)) {
      return { status: 400, message: 'Bad request.', reason: 'target_not_origin_form' };
    }
    if (isRefusedPath(target)) {
      return { status: 404, message: 'Not found.', reason: 'path_not_served' };
    }
    return null;
  }

  function logRefusal(req: IncomingMessage, refusal: Refusal, kind: 'request' | 'upgrade'): void {
    // Never the proof header or its value: only why, and where it was going.
    logger.warn('[ManagedIngress] Refused a managed request', {
      kind,
      reason: refusal.reason,
      method: req.method,
    });
  }

  function settle(): void {
    inFlight -= 1;
    if (inFlight === 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  /**
   * Admit or refuse one request. `expectsContinue` is set for a request that
   * sent `Expect: 100-continue`: Node would otherwise answer `100 Continue`
   * before any check ran, inviting the body of a request about to be refused.
   */
  function onRequest(req: IncomingMessage, res: ServerResponse, expectsContinue = false): void {
    const refusal = refusalFor(req);
    if (refusal) {
      logRefusal(req, refusal, 'request');
      res.writeHead(refusal.status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: refusal.message }));
      return;
    }
    markManagedIngress(req);
    // Express keeps a `res.locals` it finds already set, so this survives into
    // every middleware and route.
    (res as ServerResponse & { locals?: Record<string, unknown> }).locals = { ingress: 'managed' };
    inFlight += 1;
    res.once('close', settle);
    if (expectsContinue) res.writeContinue();
    options.handler(req, res);
  }

  function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const refusal = refusalFor(req);
    if (refusal) {
      logRefusal(req, refusal, 'upgrade');
      if (!socket.destroyed) {
        socket.write(`HTTP/1.1 ${refusal.status} ${refusal.message}\r\nConnection: close\r\n\r\n`);
      }
      socket.destroy();
      return;
    }
    markManagedIngress(req);
    upgraded.add(socket);
    socket.once('close', () => upgraded.delete(socket));
    options.forwardUpgrade(req, socket, head);
  }

  function waitForIdle(): Promise<void> {
    if (inFlight === 0) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
  }

  function forceClose(target: http.Server): void {
    target.closeAllConnections();
    for (const socket of upgraded) socket.destroy();
    upgraded.clear();
  }

  async function doClose(target: http.Server, immediate: boolean): Promise<void> {
    if (!immediate) await waitForIdle();
    await new Promise<void>((resolve) => {
      target.close(() => resolve());
      forceClose(target);
    });
    if (server === target) {
      server = null;
      url = null;
      hosts = new Set();
      proof = null;
      draining = false;
    }
  }

  return {
    async open() {
      if (closing) await closing;
      if (url) return url;
      if (opening) return opening;
      opening = new Promise<string>((resolve, reject) => {
        const created = http.createServer(onRequest);
        created.on('upgrade', onUpgrade);
        created.on('checkContinue', (req, res) => onRequest(req, res, true));
        created.once('error', reject);
        // Loopback only: the ngrok agent is the one thing that should reach it.
        created.listen(0, '127.0.0.1', () => {
          created.off('error', reject);
          const { port } = created.address() as AddressInfo;
          server = created;
          url = `http://127.0.0.1:${port}`;
          draining = false;
          resolve(url);
        });
      }).finally(() => {
        opening = null;
      });
      return opening;
    },

    setHosts(next) {
      hosts = new Set(next.map((host) => host.trim().toLowerCase()).filter(Boolean));
    },

    setEdgeProof(next, confirmedAt) {
      proof = proof
        ? rotateEdgeProofState(proof, next, confirmedAt ?? now())
        : initialEdgeProofState(next);
    },

    dropPreviousEdgeProof() {
      if (proof) proof = dropPreviousEdgeProof(proof);
    },

    beginDrain() {
      draining = true;
    },

    get draining() {
      return draining;
    },

    get inFlight() {
      return inFlight;
    },

    async close({ immediate }) {
      draining = true;
      if (closing) {
        // Hurry a gentle close along: cutting the connections closes every
        // admitted response, which settles them and lets the close finish.
        if (immediate && server) forceClose(server);
        return closing;
      }
      if (opening) await opening.catch(() => undefined);
      const target = server;
      if (!target) {
        hosts = new Set();
        proof = null;
        draining = false;
        return;
      }
      closing = doClose(target, immediate).finally(() => {
        closing = null;
      });
      return closing;
    },
  };
}
