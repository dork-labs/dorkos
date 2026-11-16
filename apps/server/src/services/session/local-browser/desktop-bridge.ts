/* eslint-disable no-restricted-syntax -- Read and delete the private shell handoff before any agent child can inherit it. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { LocalBrowserError } from './errors.js';
import type { HistoryStepOutcome, PageHistoryEntries } from './history/page-history.js';

/**
 * What the Mac app says a guest's history is. An entry too long to be a real
 * address (a page's own `pushState` can make one) reads as no address, which
 * the rules refuse, so one odd entry never turns Back and Forward off.
 */
const GuestHistorySchema = z
  .object({
    index: z.number().int().nonnegative(),
    entries: z
      .array(z.object({ url: z.string().transform((url) => (url.length > 65_536 ? '' : url)) }))
      .max(1_000),
  })
  .refine(({ index, entries }) => index < entries.length);

/** A history step waits on the page: longer than the Mac app's own 15 s step limit. */
const HISTORY_STEP_BRIDGE_TIMEOUT_MS = 25_000;

/** Desktop returns an authenticated connection to one guest page, never its app shell. */
export interface EmbeddedBrowserPort {
  forgetSignIns?(): Promise<void>;
  open(connectionId: string): Promise<{
    endpoint: string;
    headers: Record<string, string>;
    close(): Promise<void>;
    detach?(): Promise<void>;
    reattach?(): Promise<void>;
    /** The guest's history, read by the Mac app (DOR-4449). Absent on an older app. */
    history?(refused: readonly string[]): Promise<PageHistoryEntries>;
    /** Move to an entry the Mac app re-checks against its own rules first. */
    goToHistory?(
      index: number,
      url: string,
      refused: readonly string[]
    ): Promise<HistoryStepOutcome>;
  }>;
}

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
  const call = async (
    operation: string,
    connectionId: string,
    extra: Record<string, unknown> = {},
    timeoutMs = 15_000
  ): Promise<Response> => {
    const response = await fetch(new URL(operation, address), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...extra, connectionId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error('The desktop browser did not answer');
    return response;
  };
  return {
    async forgetSignIns() {
      await call('/forget-sign-ins', 'default');
    },
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
        detach: async () => {
          await call('/detach', connectionId);
        },
        reattach: async () => {
          await call('/reattach', connectionId);
        },
        close: async () => {
          await call('/close', connectionId);
        },
        // Every call hands the host DorkOS's own addresses, which its guard refuses.
        history: async (refused) =>
          GuestHistorySchema.parse(
            await (await call('/history', connectionId, { refused })).json()
          ),
        // The address goes as its hash: the host compares it with the entry it holds.
        goToHistory: async (index, url, refused) => {
          const urlHash = createHash('sha256').update(url).digest('hex');
          const response = await call(
            '/history/go',
            connectionId,
            { index, urlHash, refused },
            HISTORY_STEP_BRIDGE_TIMEOUT_MS
          );
          const { outcome } = (await response.json()) as { outcome?: unknown };
          if (outcome === 'changed')
            throw new LocalBrowserError(
              'history_changed',
              'The page’s history changed. Try again.'
            );
          return outcome === 'moved' ? 'moved' : 'refused';
        },
      };
    },
  };
}
