/**
 * DNS-checked, origin-pinned HTTP requests to an independently hosted community.
 * DNS is resolved once per request and the checked address is supplied to the
 * socket lookup, so a second DNS answer cannot redirect a bearer into a LAN.
 *
 * @module services/communities/remote/pinned-origin
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, Agent as HttpAgent } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { LookupFunction } from 'node:net';

const blocked = new BlockList();
for (const [address, prefix, type] of [
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['192.0.2.0', 24, 'ipv4'],
  ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
  ['2001:db8::', 32, 'ipv6'],
] as const)
  blocked.addSubnet(address, prefix, type);

/** A transport failure that carries no URL, response body or credential. */
export class PinnedOriginError extends Error {
  /** Stable reason suitable for mapping to a local API response. */
  constructor(
    readonly code: 'INVALID_ORIGIN' | 'UNSAFE_ADDRESS' | 'REMOTE_UNAVAILABLE' | 'REMOTE_RESPONSE'
  ) {
    super(code);
    this.name = 'PinnedOriginError';
  }
}

/** Accept HTTPS hosts, or literal localhost for disposable development servers. */
export function parseCommunityOrigin(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new PinnedOriginError('INVALID_ORIGIN');
  }
  const local =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  )
    throw new PinnedOriginError('INVALID_ORIGIN');
  return new URL(url.origin);
}

/** Verify every DNS answer before any socket is opened. */
export async function checkedAddress(
  origin: URL,
  resolve: (host: string) => Promise<Array<{ address: string; family: number }>> = (host) =>
    dnsLookup(host, { all: true, verbatim: true })
): Promise<{ address: string; family: 4 | 6 }> {
  const host = origin.hostname.replace(/^\[|\]$/g, '');
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answers = isIP(host)
    ? [{ address: host, family: isIP(host) as 4 | 6 }]
    : await Promise.race([
        resolve(host),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new PinnedOriginError('REMOTE_UNAVAILABLE')), 5_000);
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
  if (!answers.length) throw new PinnedOriginError('UNSAFE_ADDRESS');
  for (const answer of answers) {
    if (answer.family !== 4 && answer.family !== 6) throw new PinnedOriginError('UNSAFE_ADDRESS');
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(answer.address)?.[1];
    const value = mapped ?? answer.address;
    const family = mapped ? 'ipv4' : answer.family === 4 ? 'ipv4' : 'ipv6';
    const loopback = value === '::1' || (family === 'ipv4' && value.startsWith('127.'));
    if (local ? !loopback : blocked.check(value, family))
      throw new PinnedOriginError('UNSAFE_ADDRESS');
  }
  // Docker's localhost port forwarding often binds IPv4 only even when the
  // resolver lists ::1 first. Both addresses were checked as loopback above.
  return (local ? (answers.find((answer) => answer.family === 4) ?? answers[0]) : answers[0]) as {
    address: string;
    family: 4 | 6;
  };
}

/** Send one bounded JSON request; redirects and unexpected content never reach another host. */
export async function pinnedJson(
  origin: URL,
  path: string,
  body?: unknown,
  signal?: AbortSignal
): Promise<unknown> {
  const target = new URL(path, origin);
  if (target.origin !== origin.origin || !path.startsWith('/api/v1/'))
    throw new PinnedOriginError('INVALID_ORIGIN');
  const address = await checkedAddress(origin);
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, [address]);
    else callback(null, address.address, address.family);
  };
  const agent =
    origin.protocol === 'https:'
      ? new HttpsAgent({ keepAlive: false, lookup })
      : new HttpAgent({ keepAlive: false, lookup });
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const boundedSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    : AbortSignal.timeout(10_000);
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const request = (origin.protocol === 'https:' ? httpsRequest : httpRequest)(
        target,
        {
          method: payload ? 'POST' : 'GET',
          agent,
          timeout: 10_000,
          signal: boundedSignal,
          headers: payload
            ? { 'content-type': 'application/json', 'content-length': payload.length }
            : undefined,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 64 * 1024) {
              request.destroy();
              reject(new PinnedOriginError('REMOTE_RESPONSE'));
            } else chunks.push(chunk);
          });
          response.on('end', () => {
            if (response.statusCode === 204) {
              resolve(null);
              return;
            }
            if (response.statusCode !== 200 && response.statusCode !== 201) {
              reject(new PinnedOriginError('REMOTE_RESPONSE'));
              return;
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
              reject(new PinnedOriginError('REMOTE_RESPONSE'));
            }
          });
        }
      );
      request.on('timeout', () => request.destroy(new PinnedOriginError('REMOTE_UNAVAILABLE')));
      request.on('error', () => reject(new PinnedOriginError('REMOTE_UNAVAILABLE')));
      request.end(payload);
    });
  } finally {
    agent.destroy();
  }
}
