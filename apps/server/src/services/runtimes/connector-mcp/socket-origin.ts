/** Socket, Host, and Origin boundary for the connector-only loopback listener. */
import type { IncomingMessage } from 'node:http';

/** Whether a network address is an IPv4 or IPv6 loopback address. */
function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return (
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('127.') ||
    address.startsWith('::ffff:127.')
  );
}

/** Recover the hostname from an HTTP Host header without accepting junk. */
function hostName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(`http://${value}`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return undefined;
  }
}

/** Whether a Host header names the listener's loopback interface. */
function isLoopbackHost(value: string | undefined): boolean {
  const hostname = hostName(value);
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

/** The JSON-RPC refusal an MCP client is answered with, status 403. */
export const LOOPBACK_REFUSAL = {
  jsonrpc: '2.0',
  error: { code: -32002, message: 'Loopback origin required' },
  id: null,
} as const;

/**
 * Whether a request clears the loopback boundary: a loopback TCP peer and
 * Host, plus, for a browser, the listener's exact HTTP origin.
 *
 * Native MCP clients normally omit Origin and are accepted after the socket and
 * Host checks. Browsers must present the listener's exact HTTP origin.
 *
 * @param req - The raw Node request, read before anything else is.
 * @returns `true` when the request may go on.
 */
export function clearsConnectorRuntimeLoopback(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (!isLoopbackAddress(req.socket.remoteAddress) || !isLoopbackHost(host)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:' && parsed.host === host;
  } catch {
    return false;
  }
}
