/** Socket, Host, and Origin boundary for the connector-only loopback listener. */
import type { NextFunction, Request, Response } from 'express';

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

/** Return a JSON-RPC refusal suitable for an MCP client. */
function refuse(res: Response): void {
  res.status(403).json({
    jsonrpc: '2.0',
    error: { code: -32002, message: 'Loopback origin required' },
    id: null,
  });
}

/**
 * Enforce loopback TCP peer and Host, plus same-origin browser requests.
 *
 * Native MCP clients normally omit Origin and are accepted after the socket and
 * Host checks. Browsers must present the listener's exact HTTP origin.
 */
export function requireConnectorRuntimeLoopback(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!isLoopbackAddress(req.socket.remoteAddress) || !isLoopbackHost(req.header('host'))) {
    refuse(res);
    return;
  }

  const origin = req.header('origin');
  if (origin) {
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== 'http:' || parsed.host !== req.header('host')) {
        refuse(res);
        return;
      }
    } catch {
      refuse(res);
      return;
    }
  }
  next();
}
