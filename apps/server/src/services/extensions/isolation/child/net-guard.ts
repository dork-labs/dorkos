/**
 * NetGuard: the `allow.net` rule inside an isolated extension's own process
 * (DOR-2686, spec §4, design decision D2).
 *
 * Node 22/24 has no network permission, so the host list is kept by this
 * guard, installed by the bootstrap before any extension code runs. What it is
 * and is not:
 *
 * - It is real against ordinary code and code compromised through its input:
 *   every public way to open a connection or ask DNS goes through it, and the
 *   ways around it (`process.binding`, native addons, child processes,
 *   workers, WASI, the inspector) are closed by Node's permission model, which
 *   the host confirmed before sending `init`.
 * - It is not an OS firewall. A bug in Node or V8 defeats it, and Node says
 *   its permission model is no guarantee against deliberately malicious code.
 *   Nothing in the UI calls this a sandbox.
 *
 * ## Layers
 *
 * 1. **`net.Socket.prototype.connect`** — the one path `net.connect`,
 *    `tls.connect`, `http`, `https`, `http2`, `fetch` and `WebSocket` all
 *    reach. The arguments are read ONCE into a fresh options object (a getter
 *    or Proxy cannot answer one value to the guard and another to Node), the
 *    host and port must match `allow.net`, a Unix socket or named pipe is
 *    always refused, and the caller's own `lookup` is replaced by the guard's.
 * 2. **The guard's `lookup`** re-checks every RESOLVED address: a name that is
 *    not itself a local entry may not resolve to a loopback, private or
 *    link-local address unless that address is declared too. This is what
 *    keeps `*.nip.io` or `localtest.me` from reaching `127.0.0.1` or the LAN
 *    on a port nobody listed (DNS rebinding included: the check runs on the
 *    answer actually used, at connect time).
 * 3. **The native handle prototypes** (`TCP.prototype.connect/connect6/bind/
 *    bind6/listen`, `Pipe.prototype.connect/bind/listen`, the DNS
 *    `ChannelWrap` queries). A handle constructor can be reached from an
 *    allowed socket (`socket._handle.constructor`) and a request object from
 *    `async_hooks`, which together would open a raw connection that never
 *    passes layer 1. So the handle's own `connect` only proceeds for an
 *    address and port layer 1 or 2 approved in the last few minutes, and
 *    binding or listening is refused outright.
 * 4. **DNS** (`dns.*`, `dns.promises.*`, both `Resolver` classes): only names
 *    matching `allow.net` (on any port) are looked up or resolved, which
 *    closes DNS-query exfiltration; `reverse`, `lookupService`, `setServers`
 *    and `setLocalAddress` are refused.
 * 5. **No UDP and no inbound**: `dgram` cannot create a socket, and
 *    `net.Server.prototype.listen` refuses.
 *
 * DorkOS's own port is refused on any loopback address and on any address of
 * this computer, declared or not, so the child cannot reach DorkOS's HTTP API,
 * its MCP endpoint, or its tunnel.
 *
 * Every decision after install runs on the captured built-ins in
 * `intrinsics.ts` (see its rules), so a tampered prototype cannot flip one.
 *
 * @module services/extensions/isolation/child/net-guard
 */
import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';
import { getSystemErrorMap } from 'node:util';
import { NET_DENIED_CODE } from '../ipc-protocol.js';
import {
  apply,
  charCodeAt,
  codedError,
  createObject,
  defineProperty,
  endsWith,
  getOwnPropertyDescriptor,
  getPrototypeOf,
  isArray,
  isSafeInteger,
  MapCtor,
  mapGet,
  mapSet,
  now,
} from './intrinsics.js';
import {
  addressKey,
  displayHostPort,
  isLocalTarget,
  isLoopbackTarget,
  isOneOf,
  matchTarget,
  normalizeTarget,
  prepareEntries,
  type GuardEntry,
  type NetTarget,
} from './net-match.js';

/** What the guard needs to know. */
export interface NetGuardOptions {
  /** The `allow.net` list as declared. */
  allowNet: readonly string[];
  /** DorkOS's own HTTP port: always refused on this computer's addresses. */
  dorkosPort: number;
  /** This computer's own interface addresses (from the host). */
  ownAddresses?: readonly string[];
}

/** How long an approved address and port stays usable by a native handle. */
const APPROVAL_TTL_MS = 5 * 60_000;

/** Refusal for `listen`. */
export const LISTEN_REFUSAL = "Isolated extensions can't accept connections.";

/** Refusal for UDP. */
export const UDP_REFUSAL = "Isolated extensions can't use UDP.";

/** The keys of a connect options object Node's net layer reads. */
const CONNECT_KEYS = [
  'host',
  'port',
  'family',
  'hints',
  'localAddress',
  'localPort',
  'autoSelectFamily',
  'autoSelectFamilyAttemptTimeout',
  'timeout',
  'noDelay',
  'keepAlive',
  'keepAliveInitialDelay',
] as const;

let installed = false;

/**
 * The refusal a connection gets.
 *
 * @param what - `host:port` or a path.
 */
function netDenied(what: string): Error {
  return codedError(NET_DENIED_CODE, `${what} isn't in this extension's allow.net list.`);
}

/**
 * Replace a property for good: not writable, not configurable, so the
 * extension cannot swap the guard out (it never had the original to swap in).
 *
 * @param target - The object.
 * @param key - The property.
 * @param value - The replacement.
 */
function lock(target: object, key: PropertyKey, value: unknown): void {
  defineProperty(target, key, { value, writable: false, configurable: false, enumerable: false });
}

/**
 * The uv error number for `EACCES` on this platform (negative), which a native
 * handle method returns so Node reports a refused raw call as a normal socket
 * error instead of throwing inside its own tick.
 */
function eaccesErrno(): number {
  for (const [errno, [name]] of getSystemErrorMap()) {
    if (name === 'EACCES') return errno;
  }
  return -13;
}

/**
 * Install the guard. Idempotent; the second call does nothing. Must run
 * before any extension code is evaluated.
 *
 * @param options - The list, DorkOS's port, and this computer's addresses.
 */
export function installNetGuard(options: NetGuardOptions): void {
  if (installed) return;
  installed = true;

  const entries: readonly GuardEntry[] = prepareEntries(options.allowNet);
  const dorkosPort = options.dorkosPort;
  const own: NetTarget[] = [];
  for (const address of options.ownAddresses ?? []) {
    const target = normalizeTarget(address);
    if (target && target.kind !== 'name') own.push(target);
  }
  const EACCES = eaccesErrno();
  /** Addresses and ports layer 1 or 2 approved, with their expiry. */
  const approved = new MapCtor<string, number>();

  const originalConnect = net.Socket.prototype.connect;
  const originalLookup = dns.lookup;

  /**
   * Whether a resolved or literal address on a port is DorkOS itself.
   *
   * @param target - An IP target.
   * @param port - The port.
   */
  const isDorkos = (target: NetTarget, port: number): boolean =>
    port === dorkosPort && (isLoopbackTarget(target) || isOneOf(target, own));

  /**
   * Note that a native handle may connect to an address and port.
   *
   * @param target - An IP target.
   * @param port - The port.
   */
  const approve = (target: NetTarget, port: number): void => {
    mapSet(approved, addressKey(target, port), now() + APPROVAL_TTL_MS);
  };

  /**
   * Whether a native handle may connect now.
   *
   * @param address - What the handle was given.
   * @param port - The port.
   */
  const isApproved = (address: unknown, port: unknown): boolean => {
    if (typeof address !== 'string' || typeof port !== 'number') return false;
    const target = normalizeTarget(address);
    if (!target || target.kind === 'name') return false;
    const expiry = mapGet(approved, addressKey(target, port));
    return expiry !== undefined && expiry > now();
  };

  /**
   * Check one resolved address for a name that matched `allow.net`.
   *
   * @param address - The resolved address.
   * @param port - The port, or `null` for a bare DNS question.
   * @param nameIsLocal - Whether a matching entry itself names a local place.
   * @returns The refusal, or `null` when allowed.
   */
  const checkResolved = (
    address: unknown,
    port: number | null,
    nameIsLocal: boolean,
    shown: string
  ): Error | null => {
    if (typeof address !== 'string') return netDenied(shown);
    const target = normalizeTarget(address);
    if (!target || target.kind === 'name') return netDenied(shown);
    if (port !== null && isDorkos(target, port)) return netDenied(shown);
    if (isLocalTarget(target) && !nameIsLocal && !matchTarget(entries, target, port).matched) {
      return netDenied(shown);
    }
    return null;
  };

  /**
   * The lookup the guard hands Node for one connection: the real lookup, then
   * every answer re-checked and approved for the native handle.
   *
   * @param host - The name that passed layer 1.
   * @param port - Its port.
   * @param nameIsLocal - Whether a matching entry names a local place.
   */
  const lookupFor =
    (host: string, port: number, nameIsLocal: boolean) =>
    (hostname: unknown, lookupOptions: unknown, callback: unknown): void => {
      const cb = (typeof lookupOptions === 'function' ? lookupOptions : callback) as (
        err: Error | null,
        address?: unknown,
        family?: unknown
      ) => void;
      const shown = displayHostPort(host, port);
      if (hostname !== host) {
        cb(netDenied(shown));
        return;
      }
      const opts = typeof lookupOptions === 'function' ? {} : lookupOptions;
      apply(originalLookup, dns, [
        host,
        opts,
        (err: Error | null, address: unknown, family: unknown) => {
          if (err) return cb(err);
          if (isArray(address)) {
            for (let i = 0; i < address.length; i++) {
              const entry = address[i] as { address?: unknown } | null;
              const problem = checkResolved(entry?.address, port, nameIsLocal, shown);
              if (problem) return cb(problem);
            }
            for (let i = 0; i < address.length; i++) {
              const target = normalizeTarget((address[i] as { address: string }).address);
              if (target) approve(target, port);
            }
            return cb(null, address);
          }
          const problem = checkResolved(address, port, nameIsLocal, shown);
          if (problem) return cb(problem);
          const target = normalizeTarget(address as string);
          if (target) approve(target, port);
          return cb(null, address, family);
        },
      ]);
    };

  /**
   * Read a port the way Node accepts one: an integer 0..65535, or a string of
   * digits. Returns -1 otherwise.
   *
   * @param value - What the caller passed.
   */
  const readPort = (value: unknown): number => {
    if (typeof value === 'number') {
      return isSafeInteger(value) && value >= 0 && value <= 65535 ? value : -1;
    }
    if (typeof value !== 'string' || value.length === 0 || value.length > 5) return -1;
    let n = 0;
    for (let i = 0; i < value.length; i++) {
      const c = charCodeAt(value, i);
      if (c < 48 || c > 57) return -1;
      n = n * 10 + (c - 48);
    }
    return n <= 65535 ? n : -1;
  };

  let tcpPrototypeGuarded = false;

  /**
   * Guard the native TCP handle's prototype, the first time one is seen (the
   * first connection creates the first TCP handle, synchronously, before
   * any extension code can hold it).
   *
   * @param handle - A socket's `_handle`.
   */
  const guardTcpPrototype = (handle: unknown): void => {
    if (tcpPrototypeGuarded || typeof handle !== 'object' || handle === null) return;
    const proto = getPrototypeOf(handle) as Record<string, unknown> | null;
    if (!proto || typeof proto.connect !== 'function' || typeof proto.connect6 !== 'function') {
      return;
    }
    tcpPrototypeGuarded = true;
    for (const key of ['connect', 'connect6'] as const) {
      const original = proto[key] as (...a: unknown[]) => unknown;
      lock(proto, key, function guardedHandleConnect(this: unknown, ...args: unknown[]) {
        if (!isApproved(args[1], args[2])) return EACCES;
        return apply(original, this, args);
      });
    }
    for (const key of ['bind', 'bind6', 'listen'] as const) {
      if (typeof proto[key] === 'function') lock(proto, key, () => EACCES);
    }
  };

  // Layer 1: every outbound TCP connection.
  lock(
    net.Socket.prototype,
    'connect',
    function guardedConnect(this: net.Socket, ...args: unknown[]) {
      let opts: Record<string, unknown> | null = null;
      let cb: unknown;
      let host: unknown;
      let portValue: unknown;
      let path: unknown;
      const first = args[0];
      if (isArray(first)) {
        // Node's own normalized form, from net.connect / net.createConnection.
        opts = (typeof first[0] === 'object' && first[0] !== null ? first[0] : {}) as Record<
          string,
          unknown
        >;
        cb = first[1];
      } else if (typeof first === 'object' && first !== null) {
        opts = first as Record<string, unknown>;
        cb = args[1];
      } else if (typeof first === 'string' && readPort(first) < 0) {
        path = first;
      } else {
        portValue = first;
        host = typeof args[1] === 'string' ? args[1] : undefined;
        cb = typeof args[1] === 'function' ? args[1] : args[2];
      }

      // No prototype: a key the guard did not set must not be inherited from a
      // tampered Object.prototype (an inherited `path` would make Node open a
      // Unix socket).
      const safe = createObject(null) as Record<string, unknown>;
      if (opts) {
        // Read each key exactly once.
        path = opts.path;
        for (let i = 0; i < CONNECT_KEYS.length; i++) {
          const key = CONNECT_KEYS[i]!;
          const value = opts[key];
          if (value !== undefined)
            defineProperty(safe, key, {
              value,
              enumerable: true,
              writable: true,
              configurable: true,
            });
        }
        host = safe.host;
        portValue = safe.port;
      }
      if (path !== undefined && path !== null) {
        throw netDenied(typeof path === 'string' ? path : 'A local socket');
      }

      const hostName = host === undefined || host === null || host === '' ? 'localhost' : host;
      if (typeof hostName !== 'string') throw netDenied('That host');
      const port = readPort(portValue);
      if (port <= 0)
        throw netDenied(`${hostName}:${typeof portValue === 'number' ? portValue : '?'}`);
      const shown = displayHostPort(hostName, port);
      const target = normalizeTarget(hostName);
      if (!target) throw netDenied(shown);
      const match = matchTarget(entries, target, port);
      if (!match.matched) throw netDenied(shown);

      if (target.kind === 'name') {
        const loopbackName = target.name === 'localhost' || endsWith(target.name, '.localhost');
        if (loopbackName && port === dorkosPort) throw netDenied(shown);
        defineProperty(safe, 'lookup', {
          value: lookupFor(hostName, port, match.local),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      } else {
        if (isDorkos(target, port)) throw netDenied(shown);
        approve(target, port);
      }
      defineProperty(safe, 'host', {
        value: hostName,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      defineProperty(safe, 'port', {
        value: port,
        enumerable: true,
        writable: true,
        configurable: true,
      });

      const result = apply(
        originalConnect,
        this,
        typeof cb === 'function' ? [safe, cb] : [safe]
      ) as net.Socket;
      guardTcpPrototype((this as unknown as { _handle?: unknown })._handle);
      return result;
    }
  );

  // Layer 3 for pipes: a Unix socket or named pipe is never a destination.
  // The child's stdio and IPC channel are pipes, so the prototype is
  // reachable from the start.
  guardPipePrototype(EACCES);

  // Layer 4: DNS.
  installDnsGuard(entries);

  // Layer 5: no UDP, no inbound.
  const refuseUdp = (): never => {
    throw codedError(NET_DENIED_CODE, UDP_REFUSAL);
  };
  lock(dgram, 'createSocket', refuseUdp);
  lock(dgram, 'Socket', refuseUdp);
  if (typeof (dgram as unknown as Record<string, unknown>)._createSocketHandle === 'function') {
    lock(dgram, '_createSocketHandle', refuseUdp);
  }
  const refuseListen = (): never => {
    throw codedError(NET_DENIED_CODE, LISTEN_REFUSAL);
  };
  lock(net.Server.prototype, 'listen', refuseListen);
  if (typeof (net as unknown as Record<string, unknown>)._createServerHandle === 'function') {
    lock(net, '_createServerHandle', refuseListen);
  }
}

/**
 * Refuse `connect`, `bind` and `listen` on the native pipe handle, found
 * through the child's own stdio or IPC channel.
 *
 * @param EACCES - The errno a refused handle call returns.
 */
function guardPipePrototype(EACCES: number): void {
  const candidates: unknown[] = [];
  for (const stream of [process.stdout, process.stderr] as unknown[]) {
    const handle = (stream as { _handle?: unknown } | undefined)?._handle;
    if (handle) candidates.push(handle);
  }
  const channel = process.channel as unknown;
  if (channel && typeof channel === 'object') {
    for (const symbol of Object.getOwnPropertySymbols(channel)) {
      candidates.push((channel as Record<symbol, unknown>)[symbol]);
    }
  }
  const seen = new Set<object>();
  for (const handle of candidates) {
    if (typeof handle !== 'object' || handle === null) continue;
    const proto = getPrototypeOf(handle) as Record<string, unknown> | null;
    if (!proto || seen.has(proto) || proto.constructor?.name !== 'Pipe') continue;
    seen.add(proto);
    for (const key of ['connect', 'bind', 'listen'] as const) {
      if (typeof getOwnPropertyDescriptor(proto, key)?.value === 'function') {
        lock(proto, key, () => EACCES);
      }
    }
  }
}

/**
 * Guard every DNS entry point: names outside `allow.net` are never asked
 * about, reverse questions and server changes are refused, and a lookup's
 * answers are re-checked for rebinding.
 *
 * @param entries - The prepared list.
 */
function installDnsGuard(entries: readonly GuardEntry[]): void {
  const shownName = (name: unknown): string => (typeof name === 'string' ? name : 'That name');
  /** Throw unless `name` is a string matching an entry on any port. */
  const requireName = (name: unknown): { local: boolean } => {
    if (typeof name !== 'string') throw netDenied(shownName(name));
    const target = normalizeTarget(name);
    if (!target) throw netDenied(name);
    const match = matchTarget(entries, target, null);
    if (!match.matched) throw netDenied(name);
    return { local: match.local || target.kind !== 'name' };
  };
  /** Check lookup answers for rebinding. */
  const answersOk = (answers: unknown, local: boolean): boolean => {
    const list = isArray(answers) ? answers : [answers];
    for (let i = 0; i < list.length; i++) {
      const raw = list[i] as unknown;
      const address =
        typeof raw === 'string' ? raw : (raw as { address?: unknown } | null)?.address;
      if (typeof address !== 'string') return false;
      const target = normalizeTarget(address);
      if (!target || target.kind === 'name') return false;
      if (isLocalTarget(target) && !local && !matchTarget(entries, target, null).matched) {
        return false;
      }
    }
    return true;
  };
  const refuse = (what: string) => () => {
    throw codedError(NET_DENIED_CODE, `Isolated extensions can't use dns.${what}.`);
  };
  const refuseAsync = (what: string) => async () => {
    throw codedError(NET_DENIED_CODE, `Isolated extensions can't use dns.${what}.`);
  };

  // dns.lookup (callback form).
  const lookup = dns.lookup as (...a: unknown[]) => unknown;
  lock(dns, 'lookup', function guardedLookup(this: unknown, ...args: unknown[]) {
    const name = args[0];
    const { local } = requireName(name);
    const cbIndex = typeof args[1] === 'function' ? 1 : 2;
    const cb = args[cbIndex] as (...r: unknown[]) => void;
    if (typeof cb !== 'function') return apply(lookup, this, args);
    const wrapped = (err: unknown, address: unknown, family: unknown): void => {
      if (err) return cb(err);
      if (!answersOk(address, local)) return cb(netDenied(name as string));
      cb(null, address, family);
    };
    const next = cbIndex === 1 ? [name, wrapped] : [name, args[1], wrapped];
    return apply(lookup, this, next);
  });

  const promises = dns.promises as unknown as Record<string, unknown>;
  const promiseLookup = promises.lookup as (...a: unknown[]) => Promise<unknown>;
  lock(promises, 'lookup', async function guardedPromiseLookup(...args: unknown[]) {
    const { local } = requireName(args[0]);
    const result = (await apply(promiseLookup, promises, args)) as unknown;
    const answers = isArray(result) ? result : (result as { address?: unknown } | null);
    if (!answersOk(answers, local)) throw netDenied(args[0] as string);
    return result;
  });

  /** Wrap a name-taking method (resolve*) on one object. */
  const guardResolvers = (target: Record<string, unknown>, isAsync: boolean): void => {
    for (const key of Object.getOwnPropertyNames(target)) {
      const value = getOwnPropertyDescriptor(target, key)?.value as unknown;
      if (typeof value !== 'function') continue;
      if (key === 'reverse' || key === 'lookupService') {
        lock(target, key, isAsync ? refuseAsync(key) : refuse(key));
      } else if (key === 'setServers' || key === 'setLocalAddress') {
        lock(target, key, refuse(key));
      } else if (key.startsWith('resolve')) {
        const original = value as (...a: unknown[]) => unknown;
        lock(
          target,
          key,
          isAsync
            ? async function guardedResolveAsync(this: unknown, ...args: unknown[]) {
                requireName(args[0]);
                return apply(original, this, args);
              }
            : function guardedResolve(this: unknown, ...args: unknown[]) {
                requireName(args[0]);
                return apply(original, this, args);
              }
        );
      }
    }
  };
  guardResolvers(dns as unknown as Record<string, unknown>, false);
  guardResolvers(promises, true);
  const resolverClasses = [dns.Resolver, (promises.Resolver as typeof dns.Resolver) ?? null];
  const seenProtos = new Set<object>();
  for (const Resolver of resolverClasses) {
    if (!Resolver) continue;
    let proto: object | null = Resolver.prototype;
    while (proto && proto !== Object.prototype) {
      if (!seenProtos.has(proto)) {
        seenProtos.add(proto);
        guardResolvers(proto as Record<string, unknown>, Resolver !== dns.Resolver);
      }
      proto = getPrototypeOf(proto) as object | null;
    }
  }

  // The native resolver handle behind every Resolver: queries for names
  // outside the list, reverse queries and server changes are refused there
  // too, for a request object obtained around the JS layer.
  const sample = new dns.Resolver() as unknown as { _handle?: object };
  const channelProto = sample._handle
    ? (getPrototypeOf(sample._handle) as Record<string, unknown>)
    : null;
  if (channelProto) {
    for (const key of Object.getOwnPropertyNames(channelProto)) {
      const value = getOwnPropertyDescriptor(channelProto, key)?.value as unknown;
      if (typeof value !== 'function') continue;
      if (key === 'getHostByAddr' || key === 'setServers' || key === 'setLocalAddress') {
        lock(channelProto, key, refuse(key));
      } else if (key.startsWith('query')) {
        const original = value as (...a: unknown[]) => unknown;
        lock(channelProto, key, function guardedQuery(this: unknown, ...args: unknown[]) {
          requireName(args[1]);
          return apply(original, this, args);
        });
      }
    }
  }
}
