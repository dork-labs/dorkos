/* eslint-disable no-restricted-syntax -- Read and delete the private shell handoff before any agent child can inherit it. */
import type { EmbeddedBrowserPort } from './service.js';

/** Shell-only secret: never returned through UI state or agent tools. */
export function desktopBrowserPort(): EmbeddedBrowserPort | undefined {
  if (process.env.DORKOS_MANAGED_BY !== 'desktop') return undefined;
  const endpoint = process.env.DORKOS_LOCAL_BROWSER_BRIDGE;
  const token = process.env.DORKOS_LOCAL_BROWSER_BRIDGE_TOKEN;
  // Agent harness children inherit process.env. Keep this shell-only secret in the closure.
  delete process.env.DORKOS_LOCAL_BROWSER_BRIDGE;
  delete process.env.DORKOS_LOCAL_BROWSER_BRIDGE_TOKEN;
  if (!endpoint || !token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
  const address = new URL(endpoint);
  if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || !address.port)
    return undefined;
  const call = async (operation: string, connectionId: string): Promise<Response> => {
    const response = await fetch(new URL(operation, address), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error('The desktop browser did not answer');
    return response;
  };
  return {
    async open(connectionId) {
      const response = await call('/open', connectionId);
      const guest = (await response.json()) as {
        endpoint: string;
        headers: Record<string, string>;
      };
      const socket = new URL(guest.endpoint);
      if (
        socket.protocol !== 'ws:' ||
        socket.hostname !== address.hostname ||
        socket.port !== address.port ||
        socket.pathname !== `/page/${connectionId}`
      ) {
        await call('/close', connectionId);
        throw new Error('The desktop browser address did not match');
      }
      return {
        endpoint: guest.endpoint,
        headers: guest.headers,
        close: async () => {
          await call('/close', connectionId);
        },
      };
    },
  };
}
