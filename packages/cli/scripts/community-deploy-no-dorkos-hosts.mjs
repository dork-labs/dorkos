/**
 * A Node preload that refuses every attempt to reach a DorkOS host, so "a self-hosted Community
 * never needs DorkOS Cloud" is a mechanical check instead of a design claim (DOR-2593).
 *
 * Load it into the launcher with `NODE_OPTIONS=--import=<file URL of this module>` and name a
 * record file in `DORKOS_NO_DORKOS_HOSTS_RECORD`; the guard creates that file as it loads. Every
 * refused attempt is appended to it as one JSON line, `{"seam":"fetch","host":"dorkos.ai"}`, and
 * then fails where it was made. The file is the evidence: a launcher that swallows the failure (a
 * best-effort crash report, say) still leaves its line behind, so the caller fails on a non-empty
 * file, never on the launcher's exit.
 *
 * A DorkOS host is `dorkos.ai`, any subdomain of it, and the host of `DORKOS_CLOUD_URL` when that
 * is set: the one DorkOS Cloud address the public app reads (`resolveCloudBaseUrl`, whose default
 * is `https://dorkos.ai`), so a run pointed at another Cloud origin is guarded against that too.
 *
 * It intercepts the seams a launcher can reach the network or another program through:
 *
 * - `fetch` (wrapped last, so it sits outside any offline fake an earlier `--import` installed);
 * - `http`/`https` `request` and `get`;
 * - `net.connect`/`createConnection` and `tls.connect`, the sockets Node's built-in fetch (undici)
 *   and any bundled HTTP client open, so a request that never passes through `fetch` is still seen;
 * - `dns.lookup` and `dns.promises.lookup`;
 * - every `child_process` spawner, refusing a command whose program, arguments or environment
 *   values name a DorkOS host (a provider CLI or `curl` pointed at one).
 *
 * The ESM named exports of those built-ins are re-synced after patching, so a bundle that did
 * `import { spawn } from 'node:child_process'` sees the guarded function too.
 *
 * @module scripts/community-deploy-no-dorkos-hosts
 */
import childProcess from 'node:child_process';
import dns from 'node:dns';
import { appendFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import process from 'node:process';
import tls from 'node:tls';
import { URL } from 'node:url';

/** The environment variable naming the file every refused attempt is appended to. */
export const NO_DORKOS_HOSTS_RECORD_VARIABLE = 'DORKOS_NO_DORKOS_HOSTS_RECORD';

const DORKOS_DOMAIN = 'dorkos.ai';
// `dorkos.ai` or a subdomain of it, standing alone in a longer string: not `notdorkos.ai`, and not
// `dorkos.ai.example` (a different registrable domain that merely starts with the same labels).
const DORKOS_HOST_IN_TEXT = /(?<![a-z0-9.-])(?:[a-z0-9-]+\.)*dorkos\.ai(?!\.?[a-z0-9-])/iu;

/**
 * Reduce a host, `host:port`, bracketed IPv6 literal or URL to a bare lowercase host name.
 *
 * @param value - Anything a caller may pass as a host.
 * @returns The bare host, or an empty string when none can be read.
 */
export function normalizeHost(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  let host = value.trim().toLowerCase();
  if (host.includes('://')) {
    try {
      host = new URL(host).hostname;
    } catch {
      return '';
    }
  }
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return host.slice(1, end > 0 ? end : undefined);
  }
  // Only a single colon is a port; more than one is an unbracketed IPv6 literal.
  if (host.split(':').length === 2) host = host.slice(0, host.indexOf(':'));
  return host.replace(/\.+$/u, '');
}

/**
 * The extra hosts that count as DorkOS hosts in this process: the host of `DORKOS_CLOUD_URL`.
 *
 * @param environment - The environment to read (the process's own by default).
 * @returns Lowercase host names; empty when the variable is unset or not a URL.
 */
export function cloudHostsFrom(environment = process.env) {
  const configured = environment.DORKOS_CLOUD_URL;
  const host = configured ? normalizeHost(configured) : '';
  return host ? [host] : [];
}

/**
 * Whether `value` names a DorkOS host: `dorkos.ai`, a subdomain of it, or one of `extraHosts`.
 *
 * @param value - A host, `host:port`, or URL.
 * @param extraHosts - Further hosts that count, already normalized (see {@link cloudHostsFrom}).
 * @returns `true` when a request to it must be refused.
 */
export function isDorkosHost(value, extraHosts = []) {
  const host = normalizeHost(value);
  if (!host) return false;
  return host === DORKOS_DOMAIN || host.endsWith(`.${DORKOS_DOMAIN}`) || extraHosts.includes(host);
}

/**
 * The first DorkOS host named anywhere in a piece of text, such as a command-line argument.
 *
 * @param text - The text to search.
 * @param extraHosts - Further hosts that count, already normalized.
 * @returns The host found, or `null`.
 */
export function findDorkosHostInText(text, extraHosts = []) {
  if (typeof text !== 'string') return null;
  const match = DORKOS_HOST_IN_TEXT.exec(text);
  if (match) return match[0].toLowerCase();
  const lower = text.toLowerCase();
  for (const host of extraHosts) {
    const escaped = host.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    if (new RegExp(`(?<![a-z0-9.-])${escaped}(?!\\.?[a-z0-9-])`, 'u').test(lower)) return host;
  }
  return null;
}

/** The error a refused attempt fails with. */
export class DorkosHostRefusedError extends Error {
  /**
   * @param seam - Where the attempt was made (`fetch`, `https.request`, `spawn`, ...).
   * @param host - The DorkOS host it named.
   */
  constructor(seam, host) {
    super(`Refused ${seam} to ${host}: a self-hosted Community launch must not contact DorkOS`);
    this.name = 'DorkosHostRefusedError';
    this.code = 'DORKOS_HOST_REFUSED';
    this.seam = seam;
    this.host = host;
  }
}

function hostOfRequestInput(input) {
  if (typeof input === 'string') return normalizeHost(input);
  if (input instanceof URL) return input.hostname.toLowerCase();
  if (input && typeof input === 'object' && typeof input.url === 'string')
    return normalizeHost(input.url);
  return '';
}

function hostOfOptions(options) {
  if (!options || typeof options !== 'object') return '';
  if (typeof options.hostname === 'string') return normalizeHost(options.hostname);
  if (typeof options.host === 'string') return normalizeHost(options.host);
  if (typeof options.servername === 'string') return normalizeHost(options.servername);
  return '';
}

/**
 * Install the guard on this process's network and process seams.
 *
 * @param options - Where refusals are recorded, and which extra hosts count.
 * @param options.recordPath - File every refused attempt is appended to as one JSON line.
 * @param options.extraHosts - Further DorkOS hosts (defaults to {@link cloudHostsFrom}).
 * @returns A function that restores every patched seam (for tests).
 */
export function installNoDorkosHostsGuard({ recordPath, extraHosts = cloudHostsFrom() }) {
  const restores = [];
  const refuse = (seam, host) => {
    // Recorded before the throw: the caller may swallow the error, the record survives.
    appendFileSync(recordPath, `${JSON.stringify({ seam, host })}\n`);
    return new DorkosHostRefusedError(seam, host);
  };
  const patch = (target, name, wrap) => {
    const original = target[name];
    if (typeof original !== 'function') return;
    target[name] = wrap(original);
    restores.push(() => {
      target[name] = original;
    });
  };
  const hostGuard = (seam, readHost) => (original) =>
    function guarded(...args) {
      const host = readHost(args);
      if (host && isDorkosHost(host, extraHosts)) throw refuse(seam, host);
      return original.apply(this, args);
    };

  if (typeof globalThis.fetch === 'function') {
    const original = globalThis.fetch;
    globalThis.fetch = function guardedFetch(input, init) {
      const host = hostOfRequestInput(input);
      if (host && isDorkosHost(host, extraHosts)) return Promise.reject(refuse('fetch', host));
      return original.call(this, input, init);
    };
    restores.push(() => {
      globalThis.fetch = original;
    });
  }

  // `request(url | options, [options], [callback])`: the host is on the URL or either options.
  const requestHost = ([first, second]) =>
    hostOfRequestInput(first) || hostOfOptions(first) || hostOfOptions(second);
  for (const [label, module] of [
    ['http', http],
    ['https', https],
  ]) {
    patch(module, 'request', hostGuard(`${label}.request`, requestHost));
    patch(module, 'get', hostGuard(`${label}.get`, requestHost));
  }

  // `connect(options, [cb])`, `connect(port, [host], [cb])`, or `connect(path, [cb])` for a socket.
  const socketHost = ([first, second]) =>
    hostOfOptions(first) || (typeof second === 'string' ? normalizeHost(second) : '');
  patch(net, 'connect', hostGuard('net.connect', socketHost));
  patch(net, 'createConnection', hostGuard('net.createConnection', socketHost));
  patch(tls, 'connect', hostGuard('tls.connect', socketHost));

  const lookupHost = ([hostname]) => normalizeHost(hostname);
  patch(dns, 'lookup', hostGuard('dns.lookup', lookupHost));
  patch(
    dns.promises,
    'lookup',
    (original) =>
      function guardedLookup(...args) {
        const host = lookupHost(args);
        if (host && isDorkosHost(host, extraHosts)) {
          return Promise.reject(refuse('dns.promises.lookup', host));
        }
        return original.apply(this, args);
      }
  );

  // A spawner's program, arguments and environment values are all it can aim at a host.
  const commandHost = ([command, second, third]) => {
    const args = Array.isArray(second) ? second : [];
    const options = Array.isArray(second) ? third : second;
    const environment =
      options && typeof options === 'object' && options.env && typeof options.env === 'object'
        ? Object.values(options.env)
        : [];
    for (const text of [command, ...args, ...environment]) {
      const host = findDorkosHostInText(String(text ?? ''), extraHosts);
      if (host) return host;
    }
    return '';
  };
  for (const name of [
    'spawn',
    'spawnSync',
    'exec',
    'execSync',
    'execFile',
    'execFileSync',
    'fork',
  ]) {
    patch(childProcess, name, hostGuard(name, commandHost));
  }

  syncBuiltinESMExports();
  return () => {
    for (const restore of restores.reverse()) restore();
    syncBuiltinESMExports();
  };
}

// Loaded as a preload: install only when a record file is named, so importing the module for its
// helpers (the unit tests do) changes nothing. Creating the (empty) record file first is how the
// caller knows the guard loaded at all: no file means an unguarded run, never a clean one.
const recordPath = process.env[NO_DORKOS_HOSTS_RECORD_VARIABLE];
if (recordPath) {
  appendFileSync(recordPath, '');
  installNoDorkosHostsGuard({ recordPath });
}
