/**
 * Loopback port probe for the workbench embedded browser.
 *
 * The canvas frames a local dev server by URL. When nothing is running on that
 * port the frame renders as a blank white page and the parent has no signal to
 * explain it — a browser cannot tell its embedder that a connection was refused.
 * So the client asks the server first, and the server can answer honestly
 * because it is the same machine the dev server would be running on.
 *
 * The probe opens a TCP connection and closes it immediately: it sends no bytes,
 * reads no response, and forwards nothing. The host is pinned to the loopback
 * addresses (never a caller-supplied one), so this cannot be aimed at another
 * machine — the same rule the reverse-proxy follows.
 *
 * @module services/workbench-serve/probe
 */
import net from 'net';
import { WORKBENCH } from '../../config/constants.js';

/**
 * Loopback addresses tried in parallel.
 *
 * Both, not just IPv4: a dev server that binds `localhost` may end up on `::1`
 * only, and the browser resolves `localhost` for itself when it loads the frame.
 * Probing one family would report "nothing is running there" about a server the
 * frame goes on to render perfectly.
 */
const LOOPBACK_ADDRESSES = ['127.0.0.1', '::1'] as const;

/** Try one address; resolve true only if the connection is actually accepted. */
function connects(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (listening: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * Whether anything on this machine is listening on a loopback port.
 *
 * @param port - The port to check (already range-validated by the route schema).
 * @param timeoutMs - How long to wait for a connection before giving up.
 * @returns True when either loopback address accepted a connection.
 */
export async function probeLoopbackPort(
  port: number,
  timeoutMs: number = WORKBENCH.PROBE_TIMEOUT_MS
): Promise<boolean> {
  const results = await Promise.all(
    LOOPBACK_ADDRESSES.map((host) => connects(host, port, timeoutMs))
  );
  return results.some(Boolean);
}
