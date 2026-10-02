import { isIP } from 'node:net';
import { EgressPolicyError } from './errors.js';

/** The single canonical authority shared by policy and a future forwarding broker. */
export interface CanonicalDestination {
  readonly scheme: 'http' | 'https' | 'ws' | 'wss';
  readonly hostname: string;
  readonly port: number;
  readonly authority: string;
  readonly origin: string;
  readonly family: 0 | 4 | 6;
}

function invalid(): never {
  throw new EgressPolicyError('INVALID_DESTINATION');
}

/** ASCII DNS names only; normalize case and one root dot, never numeric shorthand or escapes. */
export function canonicalHostname(value: string): string {
  if (typeof value !== 'string' || value.length > 254 || !/^[\x21-\x7e]+$/.test(value)) invalid();
  const host = value.toLowerCase().replace(/\.$/, '');
  if (
    !host ||
    host.length > 253 ||
    host
      .split('.')
      .some((label) => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
  )
    invalid();
  let parsed: string;
  try {
    parsed = new URL(`http://${host}/`).hostname;
  } catch {
    invalid();
  }
  if (parsed !== host) invalid();
  return host;
}

function authority(value: string, scheme: CanonicalDestination['scheme']): CanonicalDestination {
  if (typeof value !== 'string' || value.length > 512 || /[@%\\/?#\s]/.test(value)) invalid();
  const parts = value.startsWith('[')
    ? /^\[([^\]]+)\](?::([0-9]+))?$/.exec(value)
    : /^([^:]+)(?::([0-9]+))?$/.exec(value);
  if (!parts) invalid();
  const raw = parts[1]!;
  const family = isIP(raw) as 0 | 4 | 6;
  if (value.startsWith('[') ? family !== 6 : family === 6) invalid();
  let hostname: string;
  if (family === 6) hostname = new URL(`http://[${raw}]/`).hostname.slice(1, -1);
  else hostname = canonicalHostname(raw);
  if (family === 0 && isIP(hostname)) invalid();
  const defaultPort = scheme === 'http' || scheme === 'ws' ? 80 : 443;
  if (parts[2] && !/^[1-9][0-9]{0,4}$/.test(parts[2])) invalid();
  const port = parts[2] ? Number(parts[2]) : defaultPort;
  if (port > 65535) invalid();
  const rendered = family === 6 ? `[${hostname}]` : hostname;
  const canonical = `${rendered}:${port}`;
  return Object.freeze({
    scheme,
    hostname,
    port,
    authority: canonical,
    origin: `${scheme}://${rendered}${port === defaultPort ? '' : ':' + port}`,
    family,
  });
}

/** Parse absolute-form page destinations once and compare a separately supplied Host header. */
export function parseDestination(input: {
  url: string;
  hostHeader?: string;
}): CanonicalDestination {
  if (!input || typeof input !== 'object') invalid();
  if (
    typeof input.url !== 'string' ||
    input.url.length > 8192 ||
    /[\s\\]/.test(input.url) ||
    [...input.url].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    invalid();
  const match = /^([a-z]+):\/\/([^/?#]+)/i.exec(input.url);
  if (!match) invalid();
  const scheme = match[1]!.toLowerCase();
  if (scheme !== 'http' && scheme !== 'https' && scheme !== 'ws' && scheme !== 'wss')
    throw new EgressPolicyError('FORBIDDEN_SCHEME');
  const target = authority(match[2]!, scheme);
  if (
    input.hostHeader !== undefined &&
    authority(input.hostHeader, scheme).authority !== target.authority
  )
    throw new EgressPolicyError('HOST_MISMATCH');
  return target;
}

/** CONNECT contains no URL scheme: conservatively classify it as HTTPS with an explicit port. */
export function parseConnectAuthority(value: string, hostHeader?: string): CanonicalDestination {
  if (typeof value !== 'string' || !/:\d+$/.test(value)) invalid();
  const target = authority(value, 'https');
  if (hostHeader !== undefined && authority(hostHeader, 'https').authority !== target.authority)
    throw new EgressPolicyError('HOST_MISMATCH');
  return target;
}
