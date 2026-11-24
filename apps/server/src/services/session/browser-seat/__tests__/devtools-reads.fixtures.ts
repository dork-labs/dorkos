/** The devtools read handlers bound to one session, and seeded capture stores, shared by the devtools read tests. */
import type { DevtoolsConsoleEntry, DevtoolsNetworkEntry } from '@dorkos/shared/schemas';
import {
  readConsole,
  readNetwork,
  takeScreenshot,
  type DevtoolsReadStore,
  type ReadConsoleInput,
  type ReadNetworkInput,
} from '../devtools-reads.js';
import { DevtoolsCaptureStore } from '../../devtools-capture-store.js';

export const SESSION_ID = 'sess-1';
export const resolveSession = () => SESSION_ID;

/**
 * The handler shape these cases were written against, over the capability
 * handlers that replaced them.
 *
 * The verbs take a session id resolved by their SURFACE now, which is the whole
 * point of the `ui` domain — but what each case below asserts is the read
 * itself, so binding the id once here keeps every case about the thing it names.
 */
export function createReadConsoleHandler(
  resolve: () => string | undefined,
  store: DevtoolsReadStore
) {
  return (input: Record<string, unknown> = {}) =>
    readConsole(input as ReadConsoleInput, resolve(), store);
}

/** The network read, bound the same way. */
export function createReadNetworkHandler(
  resolve: () => string | undefined,
  store: DevtoolsReadStore
) {
  return (input: Record<string, unknown> = {}) =>
    readNetwork(input as ReadNetworkInput, resolve(), store);
}

/** The screenshot round trip, bound the same way. */
export function createBrowserScreenshotHandler(
  resolve: () => string | undefined,
  store: DevtoolsReadStore,
  timeoutMs: number
) {
  return () => takeScreenshot(resolve(), store, timeoutMs);
}

/** The plain payload a `ui` verb answers with. */
export function parse(payload: unknown): Record<string, unknown> {
  return payload as Record<string, unknown>;
}

export function consoleEntry(over: Partial<DevtoolsConsoleEntry> = {}): DevtoolsConsoleEntry {
  return { level: 'log', text: 'hello', timestamp: 1, ...over };
}

export function networkEntry(over: Partial<DevtoolsNetworkEntry> = {}): DevtoolsNetworkEntry {
  return {
    method: 'GET',
    url: 'http://localhost:3000/api',
    status: 200,
    ok: true,
    durationMs: 12,
    timestamp: 1,
    ...over,
  };
}

/** A store seeded with one ingest batch for `sessionId` (default SESSION_ID). */
export function seededStore(
  consoleEntries: DevtoolsConsoleEntry[],
  networkEntries: DevtoolsNetworkEntry[] = [],
  sessionId = SESSION_ID
): DevtoolsCaptureStore {
  const store = new DevtoolsCaptureStore();
  store.ingest(sessionId, {
    seq: 1,
    logicalUrl: 'http://localhost:3000/',
    documentId: 'doc-1',
    console: consoleEntries,
    network: networkEntries,
  });
  return store;
}
