import { createHash } from 'node:crypto';
import { BrokerError } from './errors.js';
import type { OriginResponse } from './transport.js';
import type { BrokerIssuer } from './issuer.js';
/** Validate the actual origin upgrade before enabling bidirectional forwarding. */
export function validateUpgrade(response: OriginResponse, key: string) {
  const expected = createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  if (
    response.status !== 101 ||
    response.headers.upgrade?.toLowerCase() !== 'websocket' ||
    !response.headers.connection
      ?.toLowerCase()
      .split(',')
      .map((v) => v.trim())
      .includes('upgrade') ||
    response.websocketAccept !== expected ||
    response.headers['sec-websocket-accept'] !== expected
  )
    throw new BrokerError('UPGRADE_REFUSED');
}
/** Strip origin hop fields; transfer decoding remains the trusted Node parser's responsibility. */
export function renderResponse(
  response: OriginResponse,
  upgrade: boolean,
  limits: BrokerIssuer['limits']
) {
  if (
    !Number.isInteger(response.status) ||
    response.status < 100 ||
    response.status > 599 ||
    (!upgrade && response.status < 200)
  )
    throw new BrokerError('FRAMING_REFUSED');
  const cookies = response.setCookies ?? [];
  if (response.headers['set-cookie'] !== undefined && cookies.length)
    throw new BrokerError('FRAMING_REFUSED');
  const entries = [
    ...Object.entries(response.headers),
    ...cookies.map((value): [string, string] => ['set-cookie', value]),
  ];
  if (entries.length > limits.headerFields) throw new BrokerError('FRAMING_REFUSED');
  let bytes = 32;
  const names = new Set<string>();
  for (const [name, value] of entries) {
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    if (
      bytes > limits.headerBytes ||
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) ||
      (names.has(name.toLowerCase()) && name !== 'set-cookie') ||
      /[^\t\x20-\x7e]/.test(value)
    )
      throw new BrokerError('FRAMING_REFUSED');
    names.add(name.toLowerCase());
  }
  const hop = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ]);
  const nominated = (response.headers.connection ?? '')
    .split(',')
    .map((v) => v.trim().toLowerCase());
  const headers = entries.filter(
    ([k, v]) => !hop.has(k) && !nominated.includes(k) && !/[^\t\x20-\x7e]/.test(v)
  );
  if (upgrade) headers.push(['connection', 'Upgrade'], ['upgrade', 'websocket']);
  else headers.push(['connection', 'close']);
  return Buffer.from(
    `HTTP/1.1 ${response.status} Origin\r\n${headers.map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`
  );
}
