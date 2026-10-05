import {
  parseConnectAuthority,
  parseDestination,
  type CanonicalDestination,
} from '../destination.js';
import { BrokerError } from './errors.js';
import type { BrokerLimits } from './limits.js';
/** Node's strict parser supplies raw pairs before normalized header processing. */
export interface RawRequest {
  readonly method: string;
  readonly target: string;
  readonly rawHeaders: readonly string[];
  readonly head: Uint8Array;
}
/** A validated HTTP or opaque endpoint intent; CONNECT never certifies an inner scheme. */
export interface FramedRequest {
  readonly kind: 'http' | 'websocket' | 'opaque-connect';
  readonly destination: CanonicalDestination;
  readonly url: string;
  readonly method: string;
  readonly path: string;
  readonly credential: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly contentLength?: number;
  readonly websocketKey?: string;
}
const TOKEN = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i;
const HOPS = new Set([
  'connection',
  'proxy-connection',
  'proxy-authorization',
  'proxy-authenticate',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const SINGLE = new Set([
  'host',
  'proxy-authorization',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
  'sec-websocket-key',
  'sec-websocket-version',
]);
function refused(): never {
  throw new BrokerError('FRAMING_REFUSED');
}
/** Refuse ambiguous raw framing before DNS or dial; remove authentication and nominated hops. */
export function frameRequest(
  raw: RawRequest,
  limits: Readonly<Record<keyof BrokerLimits, number>>
): FramedRequest {
  if (
    raw.rawHeaders.length % 2 ||
    raw.rawHeaders.length / 2 > limits.headerFields ||
    Buffer.byteLength(raw.rawHeaders.join('\r\n')) > limits.headerBytes ||
    !TOKEN.test(raw.method) ||
    raw.target.length > 8192 ||
    raw.target.includes('#') ||
    raw.head.byteLength > limits.headBytes
  )
    refused();
  const fields = new Map<string, string>();
  for (let n = 0; n < raw.rawHeaders.length; n += 2) {
    const name = raw.rawHeaders[n]!.toLowerCase(),
      value = raw.rawHeaders[n + 1]!;
    if (!TOKEN.test(name) || /[\r\n\0]/.test(value) || (SINGLE.has(name) && fields.has(name)))
      refused();
    fields.set(name, fields.has(name) ? fields.get(name) + ', ' + value : value);
  }
  const host = fields.get('host'),
    auth = fields.get('proxy-authorization');
  if (!host || !auth || Buffer.byteLength(auth) > limits.credentialBytes)
    throw new BrokerError('CREDENTIAL_REFUSED');
  let credential: string;
  if (/^Bearer [A-Za-z0-9_-]+$/.test(auth)) credential = auth.slice(7);
  else {
    const basic = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(auth);
    if (!basic) throw new BrokerError('CREDENTIAL_REFUSED');
    const decoded = Buffer.from(basic[1]!, 'base64');
    const plain = decoded.toString('utf8');
    const secret = /^dorkos:([A-Za-z0-9_-]{43})$/.exec(plain);
    if (decoded.toString('base64') !== basic[1] || !Buffer.from(plain).equals(decoded) || !secret)
      throw new BrokerError('CREDENTIAL_REFUSED');
    credential = secret[1]!;
  }
  if (fields.has('expect')) refused();
  const te = fields.get('transfer-encoding');
  if (te && (te.toLowerCase() !== 'chunked' || fields.has('content-length'))) refused();
  const cl = fields.get('content-length');
  let contentLength: number | undefined;
  if (cl !== undefined) {
    if (!/^(0|[1-9][0-9]*)$/.test(cl)) refused();
    contentLength = Number(cl);
    if (!Number.isSafeInteger(contentLength) || contentLength > limits.bodyBytes) refused();
  }
  const nominated = (fields.get('connection') ?? '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  if (
    nominated.some(
      (v) =>
        !TOKEN.test(v) ||
        ['host', 'proxy-authorization', 'content-length', 'transfer-encoding'].includes(v)
    )
  )
    refused();
  const method = raw.method.toUpperCase();
  let kind: FramedRequest['kind'] = 'http';
  let destination: CanonicalDestination;
  let url: string;
  let path: string;
  if (method === 'CONNECT') {
    if (contentLength || te || fields.has('upgrade')) refused();
    kind = 'opaque-connect';
    destination = parseConnectAuthority(raw.target, host);
    url = destination.origin + '/';
    path = '';
  } else {
    destination = parseDestination({ url: raw.target, hostHeader: host });
    if (destination.scheme !== 'http' && destination.scheme !== 'ws') refused();
    url = raw.target;
    const parsed = new URL(url);
    path = parsed.pathname + parsed.search;
    if (fields.has('upgrade')) {
      if (
        destination.scheme !== 'ws' ||
        method !== 'GET' ||
        fields.get('upgrade')?.toLowerCase() !== 'websocket' ||
        !nominated.includes('upgrade') ||
        fields.get('sec-websocket-version') !== '13' ||
        !/^[A-Za-z0-9+/]{22}==$/.test(fields.get('sec-websocket-key') ?? '') ||
        contentLength
      )
        throw new BrokerError('UPGRADE_REFUSED');
      kind = 'websocket';
    } else if (destination.scheme !== 'http' || raw.head.byteLength) refused();
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of fields)
    if (!HOPS.has(key) && !nominated.includes(key)) headers[key] = value;
  headers.host = destination.authority;
  headers.connection = kind === 'websocket' ? 'Upgrade' : 'close';
  if (kind === 'websocket') headers.upgrade = 'websocket';
  return Object.freeze({
    kind,
    destination,
    url,
    path,
    method,
    credential,
    headers: Object.freeze(headers),
    ...(contentLength === undefined ? {} : { contentLength }),
    ...(kind === 'websocket' ? { websocketKey: fields.get('sec-websocket-key')! } : {}),
  });
}

/** Validate an unauthenticated proxy challenge without creating a forwarding credential. */
export function validateProxyChallenge(
  raw: RawRequest,
  limits: Readonly<Record<keyof BrokerLimits, number>>
): void {
  if (
    raw.rawHeaders.some(
      (name, index) => index % 2 === 0 && name.toLowerCase() === 'proxy-authorization'
    )
  )
    throw new BrokerError('CREDENTIAL_REFUSED');
  frameRequest(
    {
      ...raw,
      rawHeaders: [...raw.rawHeaders, 'Proxy-Authorization', 'Bearer challengevalidationonly'],
    },
    limits
  );
}
