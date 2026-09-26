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
import {
  COMMUNITY_RESERVED_SHORT_NAMES,
  COMMUNITY_SHORT_NAME_PATTERN,
} from '@dorkos/shared/community-admin-wire';
import {
  CommunityWireErrorCodeSchema,
  type CommunityWireErrorCode,
} from '@dorkos/shared/community-wire';

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

/** A remote status observed through the pinned socket, with no free-form body text or URL. */
export class PinnedHttpError extends Error {
  /**
   * Preserve only the semantic HTTP status and, when the Community sent one,
   * its error code from the closed wire enum. A remote message is untrusted
   * text and is never kept, so it cannot reach a person.
   */
  constructor(
    readonly status: number,
    readonly remoteCode?: CommunityWireErrorCode
  ) {
    super(`Remote community returned HTTP ${status}`);
    this.name = 'PinnedHttpError';
  }
  /** Retain the existing safe transport classification for callers that do not branch on status. */
  readonly code = 'REMOTE_RESPONSE' as const;
}

const communityIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A checked Community link keeps tenant selection separate from its socket origin. */
export interface ParsedCommunityLink {
  /** Origin used for DNS validation and every network request. */
  origin: URL;
  /** Explicit immutable tenant, or null for the singleton path and for a short-name link. */
  communityId: string | null;
  /**
   * A lower-cased short name from a `/<name>` link, or null. It is only an address: the caller
   * resolves it to the community's UUID through the host's lookup and stores only the UUID.
   */
  shortName: string | null;
}

const reservedShortNames = new Set(COMMUNITY_RESERVED_SHORT_NAMES);

/**
 * Parse an origin root, the exact canonical `/c/:communityId` browser link, or an exact
 * `/<name>` short-name link. A short name is lower-cased and must match the grammar and not be
 * reserved; it is read from the raw path, so a percent-encoded spelling (`/%61cme`), a trailing
 * slash, or a deeper path is refused rather than guessed at.
 */
export function parseCommunityLink(input: string): ParsedCommunityLink {
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
    url.hash
  )
    throw new PinnedOriginError('INVALID_ORIGIN');
  const origin = new URL(url.origin);
  if (url.pathname === '/' || url.pathname === '') {
    return { origin, communityId: null, shortName: null };
  }
  const canonical = /^\/c\/([^/]+)$/.exec(url.pathname);
  if (canonical) {
    if (!communityIdPattern.test(canonical[1])) throw new PinnedOriginError('INVALID_ORIGIN');
    return { origin, communityId: canonical[1], shortName: null };
  }
  const named = /^\/([^/]+)$/.exec(url.pathname);
  const shortName = named?.[1].toLowerCase();
  if (
    !shortName ||
    !COMMUNITY_SHORT_NAME_PATTERN.test(shortName) ||
    reservedShortNames.has(shortName)
  )
    throw new PinnedOriginError('INVALID_ORIGIN');
  return { origin, communityId: null, shortName };
}

/** Whether a string is a canonical community UUID, as `/c/<uuid>` links carry it. */
export function isCommunityId(value: string): boolean {
  return communityIdPattern.test(value);
}

/** Qualify one fixed v1 API path with the selected immutable tenant UUID. */
export function communityApiPath(communityId: string, path: string): string {
  if (!communityIdPattern.test(communityId) || !path.startsWith('/api/v1/'))
    throw new PinnedOriginError('INVALID_ORIGIN');
  return `/api/v1/communities/${communityId}${path.slice('/api/v1'.length)}`;
}

/** Accept HTTPS hosts, or literal localhost for disposable development servers. */
export function parseCommunityOrigin(input: string): URL {
  const parsed = parseCommunityLink(input);
  if (parsed.communityId || parsed.shortName) throw new PinnedOriginError('INVALID_ORIGIN');
  return parsed.origin;
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

/** Read only the closed-enum error code from a Community error body; anything else is dropped. */
function remoteErrorCode(content: Buffer): CommunityWireErrorCode | undefined {
  try {
    const parsed = CommunityWireErrorCodeSchema.safeParse(
      (JSON.parse(content.toString('utf8')) as { code?: unknown } | null)?.code
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Send one bounded JSON request; redirects and unexpected content never reach another host. */
export async function pinnedJson(
  origin: URL,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    authorization?: string;
    maxBytes?: number;
    accept?: readonly number[];
    rawBody?: Buffer;
    contentType?: string;
    headers?: Record<string, string>;
    response?: 'json' | 'buffer';
  } = {}
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
  const payload =
    options.rawBody ?? (body === undefined ? undefined : Buffer.from(JSON.stringify(body)));
  const method = options.method ?? (payload ? 'POST' : 'GET');
  const maxBytes = options.maxBytes ?? 64 * 1024;
  const boundedSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    : AbortSignal.timeout(10_000);
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const request = (origin.protocol === 'https:' ? httpsRequest : httpRequest)(
        target,
        {
          method,
          agent,
          timeout: 10_000,
          signal: boundedSignal,
          headers: {
            ...(payload
              ? {
                  'content-type': options.contentType ?? 'application/json',
                  'content-length': payload.length,
                }
              : {}),
            ...(options.authorization ? { authorization: `Bearer ${options.authorization}` } : {}),
            ...options.headers,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > maxBytes) {
              request.destroy();
              reject(new PinnedOriginError('REMOTE_RESPONSE'));
            } else chunks.push(chunk);
          });
          response.on('end', () => {
            if (response.statusCode === 204) {
              resolve(null);
              return;
            }
            const content = Buffer.concat(chunks);
            if (!(options.accept ?? [200, 201]).includes(response.statusCode ?? 0)) {
              reject(new PinnedHttpError(response.statusCode ?? 502, remoteErrorCode(content)));
              return;
            }
            if (options.response === 'buffer') {
              resolve(content);
              return;
            }
            try {
              resolve(JSON.parse(content.toString('utf8')));
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

/** Open one pinned SSE response without following redirects or re-resolving DNS. */
export async function* pinnedSse(
  origin: URL,
  path: string,
  authorization: string,
  lastEventId?: string,
  signal?: AbortSignal
): AsyncGenerator<unknown> {
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
  const boundedSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  let request: import('node:http').ClientRequest | undefined;
  let response: import('node:http').IncomingMessage | undefined;
  try {
    response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      request = (origin.protocol === 'https:' ? httpsRequest : httpRequest)(
        target,
        {
          method: 'GET',
          agent,
          signal: boundedSignal,
          headers: {
            accept: 'text/event-stream',
            authorization: `Bearer ${authorization}`,
            ...(lastEventId ? { 'last-event-id': lastEventId } : {}),
          },
        },
        (opened) => {
          if (opened.statusCode !== 200) {
            opened.resume();
            reject(new PinnedHttpError(opened.statusCode ?? 502));
            return;
          }
          resolve(opened);
        }
      );
      request.on('error', () => reject(new PinnedOriginError('REMOTE_UNAVAILABLE')));
      request.end();
    });
    let buffer = '';
    for await (const chunk of response) {
      buffer += Buffer.from(chunk).toString('utf8');
      if (buffer.length > 64 * 1024) throw new PinnedOriginError('REMOTE_RESPONSE');
      for (;;) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary < 0) break;
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split('\n').find((line) => line.startsWith('data: '));
        if (!data) continue;
        try {
          yield JSON.parse(data.slice(6));
        } catch {
          throw new PinnedOriginError('REMOTE_RESPONSE');
        }
      }
    }
  } finally {
    response?.destroy();
    request?.destroy();
    agent.destroy();
  }
}
