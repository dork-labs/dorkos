import { vi, type Mock } from 'vitest';
import {
  CloudLinkManager,
  type CloudConfigPort,
  type CloudLinkManagerOptions,
} from '../../cloud-link.js';
import type { FetchLike } from '../../cloud-link-client.js';

/** A promise the test settles by hand. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A JSON response with the given status. */
export function response(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status });
}

/** A device-code answer whose user code equals its device code. */
export function codes(deviceCode: string): Response {
  return response(200, {
    device_code: deviceCode,
    user_code: deviceCode,
    verification_uri: 'https://dorkos.ai/activate',
    expires_in: 1800,
    interval: 5,
  });
}

/** A heartbeat answer naming the linked account. */
export function heartbeat(label: string): Response {
  return response(200, {
    instanceId: 'instance-a',
    lastSeenAt: `2026-09-27T00:00:0${label.length}Z`,
    accountLabel: label,
  });
}

/** The key a request carried, without its `Bearer ` prefix. */
export function bearer(init?: RequestInit): string | undefined {
  const auth = new Headers(init?.headers).get('authorization');
  return auth?.replace(/^Bearer /, '');
}

/** An in-memory cloud config with the same clear/save semantics as the real one. */
export function memoryConfig(
  initialToken: string | null = null,
  initialProof: string | null = null
): CloudConfigPort {
  let token = initialToken;
  let label: string | null = null;
  let previousLinkProof = initialProof;
  return {
    getToken: () => token,
    getAccountLabel: () => label,
    getPreviousLinkProof: () => previousLinkProof,
    save: (link) => {
      token = link.instanceToken;
      previousLinkProof = null;
    },
    setAccountLabel: (value) => {
      label = value;
    },
    clear: (keep) => {
      token = null;
      label = null;
      previousLinkProof = keep.previousLinkProof;
    },
  };
}

type Route = (init?: RequestInit) => Response | Promise<Response>;

/**
 * A fetch that answers the cloud's link routes. The device code, token and
 * heartbeat default to a fresh link of `new-key` for `new-account`; any route
 * left out that is called fails the test.
 */
export function cloudRoutes(
  routes: {
    code?: Route;
    token?: Route;
    heartbeat?: Route;
    connectors?: Route;
    revoke?: Route;
  } = {}
): Mock<FetchLike> {
  const {
    code = () => codes('new-code'),
    token = () => response(200, { access_token: 'new-key' }),
    heartbeat: onHeartbeat = () => heartbeat('new-account'),
    connectors,
    revoke,
  } = routes;
  return vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const route = path.endsWith('/device/code')
      ? code
      : path.endsWith('/device/token')
        ? token
        : path.endsWith('/instances/heartbeat')
          ? onHeartbeat
          : path.includes('/instances/connectors/')
            ? connectors
            : path.endsWith('/instances/revoke')
              ? revoke
              : undefined;
    if (!route) throw new Error(`Unexpected request: ${path}`);
    return route(init);
  });
}

/** How many requests a fetch mock made to a path ending in `suffix`. */
export function callsTo(fetchImpl: Mock<FetchLike>, suffix: string): number {
  return fetchImpl.mock.calls.filter(([url]) => String(url).endsWith(suffix)).length;
}

export const noSleep = async (): Promise<void> => {};

export const command = {
  version: 1,
  commandId: 'command-a',
  managedConnectionId: 'managed-a',
  scopeVersion: 1,
  kind: 'set_connection_lifecycle',
  lifecycle: 'paused',
} as const;

/** The three managed-connector calls a refused key can come back on. */
export const callKinds = ['managed', 'submit', 'read'] as const;

/** Makes one managed-connector call of the given kind. */
export function managedCall(
  manager: CloudLinkManager,
  kind: (typeof callKinds)[number]
): Promise<unknown> {
  if (kind === 'submit') return manager.submitConnectorAuthorityCommand(command);
  if (kind === 'read') return manager.readConnectorAuthorityCommand(command.commandId);
  return manager.listManagedConnectorUsage({ version: 1, limit: 50 }, new AbortController().signal);
}

const managers: CloudLinkManager[] = [];

/** Stops every manager `manage` made; call it from `afterEach`. */
export function stopManagers(): void {
  for (const manager of managers) manager.stop();
  managers.length = 0;
  vi.useRealTimers();
}

/** A manager over `config` and `fetchImpl` that never sleeps; `stopManagers` stops it. */
export function manage(
  config: CloudConfigPort,
  fetchImpl: FetchLike,
  options: Partial<CloudLinkManagerOptions> = {}
): CloudLinkManager {
  const manager = new CloudLinkManager({
    config,
    fetchImpl,
    sleep: noSleep,
    resolveTelemetryInstanceId: async () => undefined,
    ...options,
  });
  managers.push(manager);
  return manager;
}
