import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudLinkManager, type CloudConfigPort } from '../cloud-link.js';
import { linkProofForKey, ManagedConnectorCloudError } from '../cloud-link-client.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function response(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status });
}

function codes(deviceCode: string): Response {
  return response(200, {
    device_code: deviceCode,
    user_code: deviceCode,
    verification_uri: 'https://dorkos.ai/activate',
    expires_in: 1800,
    interval: 5,
  });
}

function heartbeat(label: string): Response {
  return response(200, {
    instanceId: 'instance-a',
    lastSeenAt: `2026-09-27T00:00:0${label.length}Z`,
    accountLabel: label,
  });
}

function bearer(init?: RequestInit): string | undefined {
  const auth = new Headers(init?.headers).get('authorization');
  return auth?.replace(/^Bearer /, '');
}

function memoryConfig(initialToken: string | null = null, initialProof: string | null = null) {
  let token = initialToken;
  let label: string | null = null;
  let previousLinkProof = initialProof;
  const config: CloudConfigPort = {
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
  return config;
}

const noSleep = async () => {};
const command = {
  version: 1,
  commandId: 'command-a',
  managedConnectionId: 'managed-a',
  scopeVersion: 1,
  kind: 'set_connection_lifecycle',
  lifecycle: 'paused',
} as const;

describe('CloudLinkManager lifecycle ownership', () => {
  const managers: CloudLinkManager[] = [];

  afterEach(() => {
    for (const manager of managers) manager.stop();
    managers.length = 0;
    vi.useRealTimers();
  });

  it.each([200, 401])(
    'ignores old heartbeat HTTP %i after a replacement link',
    async (oldStatus) => {
      const oldReply = deferred<Response>();
      const config = memoryConfig('old-key');
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        if (path.endsWith('/device/code')) return codes('new-code');
        if (path.endsWith('/device/token')) return response(200, { access_token: 'new-key' });
        if (path.endsWith('/instances/heartbeat')) {
          return init?.headers &&
            (init.headers as Record<string, string>).authorization === 'Bearer old-key'
            ? oldReply.promise
            : heartbeat('new-account');
        }
        throw new Error(`Unexpected request: ${path}`);
      });
      const manager = new CloudLinkManager({
        config,
        fetchImpl,
        sleep: noSleep,
        resolveTelemetryInstanceId: async () => undefined,
      });
      managers.push(manager);

      const oldStartup = manager.initOnStartup();
      await manager.startLink();
      await manager.pendingLink;
      const before = manager.getStatus();
      oldReply.resolve(oldStatus === 200 ? heartbeat('old-account') : response(401));
      await oldStartup;

      expect(config.getToken()).toBe('new-key');
      expect(config.getAccountLabel()).toBe('new-account');
      expect(manager.getStatus()).toEqual(before);
    }
  );

  it.each(['managed', 'submit', 'read'] as const)(
    'does not let an old %s refusal clear the replacement link',
    async (kind) => {
      const oldReply = deferred<Response>();
      const config = memoryConfig('old-key');
      const fetchImpl = vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path.endsWith('/device/code')) return codes('new-code');
        if (path.endsWith('/device/token')) return response(200, { access_token: 'new-key' });
        if (path.endsWith('/instances/heartbeat')) return heartbeat('new-account');
        if (path.includes('/instances/connectors/')) return oldReply.promise;
        throw new Error(`Unexpected request: ${path}`);
      });
      const manager = new CloudLinkManager({
        config,
        fetchImpl,
        sleep: noSleep,
        resolveTelemetryInstanceId: async () => undefined,
      });
      managers.push(manager);
      const signal = new AbortController().signal;
      const oldRequest =
        kind === 'managed'
          ? manager.listManagedConnectorUsage({ version: 1, limit: 50 }, signal)
          : kind === 'submit'
            ? manager.submitConnectorAuthorityCommand(command)
            : manager.readConnectorAuthorityCommand(command.commandId);
      const oldFailure = oldRequest.catch((error: unknown) => error);

      await manager.startLink();
      await manager.pendingLink;
      oldReply.resolve(response(401));
      await expect(oldFailure).resolves.toMatchObject({ code: 'unauthorized' });
      expect(config.getToken()).toBe('new-key');
      expect(manager.getStatus().state).toBe('linked');
    }
  );

  it('keeps a pending re-link alive when the old key is refused mid-poll (DOR-2521)', async () => {
    const tokenReply = deferred<Response>();
    const config = memoryConfig('old-key');
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/device/code')) return codes('new-code');
      if (path.endsWith('/device/token')) return tokenReply.promise;
      // The heartbeat refuses the old key and accepts the new one.
      if (path.endsWith('/instances/heartbeat')) {
        return bearer(init) === 'old-key' ? response(401) : heartbeat('new-account');
      }
      if (path.includes('/instances/connectors/')) return response(401);
      throw new Error(`Unexpected request: ${path}`);
    });
    const manager = new CloudLinkManager({
      config,
      fetchImpl,
      sleep: noSleep,
      resolveTelemetryInstanceId: async () => undefined,
    });
    managers.push(manager);

    await manager.startLink();
    await vi.waitFor(() => {
      expect(
        fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/device/token'))
      ).toHaveLength(1);
    });
    // The old key is refused while the person is still approving the new link.
    await expect(
      manager.listManagedConnectorUsage({ version: 1, limit: 50 }, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect(config.getToken()).toBeNull();
    expect(config.getPreviousLinkProof()).toBe(linkProofForKey('old-key'));
    expect(manager.getStatus().state).toBe('pending');

    tokenReply.resolve(response(200, { access_token: 'new-key' }));
    await manager.pendingLink;

    expect(config.getToken()).toBe('new-key');
    expect(config.getPreviousLinkProof()).toBeNull();
    expect(config.getAccountLabel()).toBe('new-account');
    expect(manager.getStatus().state).toBe('linked');
  });

  it('keeps the proof of a key a managed-connector call finds refused (DOR-2521)', async () => {
    const config = memoryConfig('old-key');
    const manager = new CloudLinkManager({
      config,
      fetchImpl: vi.fn(async () => response(401)),
      sleep: noSleep,
    });
    managers.push(manager);

    await expect(manager.submitConnectorAuthorityCommand(command)).rejects.toMatchObject({
      code: 'unauthorized',
    });

    expect(config.getToken()).toBeNull();
    expect(config.getPreviousLinkProof()).toBe(linkProofForKey('old-key'));
    expect(manager.getStatus().state).toBe('unlinked');
  });

  it('treats a 401 after a finished link as an unlink, not a pending re-link', async () => {
    const config = memoryConfig('old-key');
    let refuse = false;
    const fetchImpl = vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/device/code')) return codes('new-code');
      if (path.endsWith('/device/token')) return response(200, { access_token: 'new-key' });
      if (path.endsWith('/instances/heartbeat')) {
        return refuse ? response(401) : heartbeat('new-account');
      }
      if (path.includes('/instances/connectors/')) return refuse ? response(401) : response(500);
      throw new Error(`Unexpected request: ${path}`);
    });
    const manager = new CloudLinkManager({
      config,
      fetchImpl,
      sleep: noSleep,
      resolveTelemetryInstanceId: async () => undefined,
    });
    managers.push(manager);

    await manager.startLink();
    await manager.pendingLink;
    refuse = true;
    await expect(manager.submitConnectorAuthorityCommand(command)).rejects.toMatchObject({
      code: 'unauthorized',
    });

    expect(config.getToken()).toBeNull();
    expect(config.getPreviousLinkProof()).toBe(linkProofForKey('new-key'));
    expect(manager.getStatus().state).toBe('unlinked');
  });

  it('ignores a superseded device-code response before polling', async () => {
    const firstCode = deferred<Response>();
    const config = memoryConfig();
    let codeRequests = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/device/code')) {
        return ++codeRequests === 1 ? firstCode.promise : codes('new-code');
      }
      if (path.endsWith('/device/token')) return response(200, { access_token: 'new-key' });
      if (path.endsWith('/instances/heartbeat')) return heartbeat('new-account');
      throw new Error(`Unexpected request: ${path}`);
    });
    const manager = new CloudLinkManager({
      config,
      fetchImpl,
      sleep: noSleep,
      resolveTelemetryInstanceId: async () => undefined,
    });
    managers.push(manager);

    const oldStart = manager.startLink().catch((error: unknown) => error);
    await vi.waitFor(() => {
      expect(
        fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/device/code'))
      ).toHaveLength(1);
    });
    await manager.startLink();
    await manager.pendingLink;
    firstCode.resolve(codes('old-code'));
    await expect(oldStart).resolves.toMatchObject({ message: 'Cloud link request was superseded' });

    expect(config.getToken()).toBe('new-key');
    expect(manager.getStatus().state).toBe('linked');
    expect(
      fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/device/token'))
    ).toHaveLength(1);
  });

  it('ignores an old poll approval after replacement', async () => {
    const oldPoll = deferred<Response>();
    const config = memoryConfig();
    let codeRequests = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/device/code'))
        return codes(++codeRequests === 1 ? 'old-code' : 'new-code');
      if (path.endsWith('/device/token')) {
        const body = JSON.parse(String(init?.body)) as { device_code: string };
        return body.device_code === 'old-code'
          ? oldPoll.promise
          : response(200, { access_token: 'new-key' });
      }
      if (path.endsWith('/instances/heartbeat')) return heartbeat('new-account');
      throw new Error(`Unexpected request: ${path}`);
    });
    const manager = new CloudLinkManager({
      config,
      fetchImpl,
      sleep: noSleep,
      resolveTelemetryInstanceId: async () => undefined,
    });
    managers.push(manager);

    await manager.startLink();
    const oldTask = manager.pendingLink;
    await manager.startLink();
    await manager.pendingLink;
    oldPoll.resolve(response(200, { access_token: 'old-key' }));
    await oldTask;

    expect(config.getToken()).toBe('new-key');
    expect(config.getAccountLabel()).toBe('new-account');
    expect(manager.getStatus().state).toBe('linked');
    expect(
      fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/instances/heartbeat'))
    ).toHaveLength(1);
  });

  it('withdraws locally before revoke settles and preserves an equal-token replacement', async () => {
    const revoke = deferred<Response>();
    const config = memoryConfig('same-key');
    const fetchImpl = vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/instances/revoke')) return revoke.promise;
      if (path.endsWith('/device/code')) return codes('new-code');
      if (path.endsWith('/device/token')) return response(200, { access_token: 'same-key' });
      if (path.endsWith('/instances/heartbeat')) return heartbeat('replacement');
      throw new Error(`Unexpected request: ${path}`);
    });
    const manager = new CloudLinkManager({
      config,
      fetchImpl,
      sleep: noSleep,
      resolveTelemetryInstanceId: async () => undefined,
    });
    managers.push(manager);

    const unlink = manager.unlink();
    expect(config.getToken()).toBeNull();
    expect(manager.getStatus()).toEqual({ state: 'idle' });
    await manager.startLink();
    await manager.pendingLink;
    const replacement = manager.getStatus();
    revoke.resolve(response(200, { ok: true }));
    await unlink;

    expect(config.getToken()).toBe('same-key');
    expect(config.getAccountLabel()).toBe('replacement');
    expect(manager.getStatus()).toEqual(replacement);
  });

  it('ignores an old heartbeat 401 across unlink and same-token relink', async () => {
    const oldHeartbeat = deferred<Response>();
    const config = memoryConfig('same-key');
    let heartbeatRequests = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/instances/heartbeat')) {
        return ++heartbeatRequests === 1 ? oldHeartbeat.promise : heartbeat('replacement');
      }
      if (path.endsWith('/instances/revoke')) return response(200, { ok: true });
      if (path.endsWith('/device/code')) return codes('new-code');
      if (path.endsWith('/device/token')) return response(200, { access_token: 'same-key' });
      throw new Error(`Unexpected request: ${path}`);
    });
    const manager = new CloudLinkManager({
      config,
      fetchImpl,
      sleep: noSleep,
      resolveTelemetryInstanceId: async () => undefined,
    });
    managers.push(manager);

    const oldStartup = manager.initOnStartup();
    await manager.unlink();
    await manager.startLink();
    await manager.pendingLink;
    oldHeartbeat.resolve(response(401));
    await oldStartup;

    expect(config.getToken()).toBe('same-key');
    expect(config.getAccountLabel()).toBe('replacement');
    expect(manager.getStatus().state).toBe('linked');
  });

  it('retains the current credential and retries after a transient heartbeat failure', async () => {
    vi.useFakeTimers();
    const config = memoryConfig('current-key');
    let heartbeatRequests = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (new URL(url).pathname.endsWith('/instances/heartbeat')) {
        return ++heartbeatRequests === 1 ? response(503) : heartbeat('current-account');
      }
      throw new Error('Unexpected request');
    });
    const manager = new CloudLinkManager({ config, fetchImpl, heartbeatIntervalMs: 100 });
    managers.push(manager);

    await manager.initOnStartup();
    expect(config.getToken()).toBe('current-key');
    expect(manager.getStatus().state).toBe('linked');
    await vi.advanceTimersByTimeAsync(100);

    expect(heartbeatRequests).toBe(2);
    expect(config.getAccountLabel()).toBe('current-account');
    expect(config.getToken()).toBe('current-key');
  });

  it('stop prevents an in-flight heartbeat from restoring state or a timer', async () => {
    vi.useFakeTimers();
    const held = deferred<Response>();
    const config = memoryConfig('key');
    const fetchImpl = vi.fn(async (url: string) => {
      if (new URL(url).pathname.endsWith('/instances/heartbeat')) return held.promise;
      throw new Error('Unexpected request');
    });
    const manager = new CloudLinkManager({
      config,
      fetchImpl,
      heartbeatIntervalMs: 100,
    });
    managers.push(manager);
    const startup = manager.initOnStartup();
    manager.stop();
    held.resolve(heartbeat('old-account'));
    await startup;
    await vi.advanceTimersByTimeAsync(500);

    expect(manager.getStatus().lastHeartbeatAt).toBeUndefined();
    expect(config.getAccountLabel()).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

/**
 * DOR-2620: a 401 from a managed-connector route is not proof the key is dead.
 * Only the heartbeat, the authoritative key check, may drop it.
 */
describe('CloudLinkManager key check after a refused call', () => {
  const managers: CloudLinkManager[] = [];

  afterEach(() => {
    for (const manager of managers) manager.stop();
    managers.length = 0;
    vi.useRealTimers();
  });

  /** A linked manager whose managed routes answer 401 and whose heartbeat answers `onHeartbeat`. */
  function refusedRoutes(
    onHeartbeat: (init?: RequestInit) => Promise<Response>,
    now: () => number = Date.now
  ) {
    const config = memoryConfig('good-key');
    const heartbeats: RequestInit[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/instances/heartbeat')) {
        heartbeats.push(init ?? {});
        return onHeartbeat(init);
      }
      if (path.includes('/instances/connectors/')) return response(401);
      throw new Error(`Unexpected request: ${path}`);
    });
    const sync = vi.fn();
    const manager = new CloudLinkManager({ config, fetchImpl, sleep: noSleep, now });
    manager.setManagedProviderSync(sync);
    managers.push(manager);
    return { config, manager, heartbeats, sync };
  }

  const usage = (manager: CloudLinkManager) =>
    manager.listManagedConnectorUsage({ version: 1, limit: 50 }, new AbortController().signal);

  it.each(['managed', 'submit', 'read'] as const)(
    'keeps the link and its key when the heartbeat vouches for a key a %s call refused',
    async (kind) => {
      const { config, manager, heartbeats, sync } = refusedRoutes(async () =>
        heartbeat('still-linked')
      );
      const request =
        kind === 'managed'
          ? usage(manager)
          : kind === 'submit'
            ? manager.submitConnectorAuthorityCommand(command)
            : manager.readConnectorAuthorityCommand(command.commandId);

      // The call still fails, but as one refused request: never "unlinked"
      // while the link is fine. The route's own refusal is kept as the cause.
      const error = await request.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ManagedConnectorCloudError);
      expect(error).toMatchObject({
        code: 'request_failed',
        status: 401,
        message: 'DorkOS’s servers turned the request down.',
        cause: expect.objectContaining({ code: 'unauthorized', status: 401 }),
      });

      expect(heartbeats).toHaveLength(1);
      expect(bearer(heartbeats[0])).toBe('good-key');
      expect(config.getToken()).toBe('good-key');
      expect(config.getPreviousLinkProof()).toBeNull();
      expect(config.getAccountLabel()).toBe('still-linked');
      expect(manager.isLinked()).toBe(true);
      expect(manager.getStatus()).toMatchObject({
        state: 'linked',
        lastHeartbeatAt: '2026-09-27T00:00:012Z',
      });
      expect(sync).not.toHaveBeenCalled();
    }
  );

  it('unlinks, keeping the relink proof, when the heartbeat refuses the key too', async () => {
    const { config, manager, heartbeats, sync } = refusedRoutes(async () => response(401));

    await expect(usage(manager)).rejects.toMatchObject({ code: 'unauthorized' });

    expect(heartbeats).toHaveLength(1);
    expect(config.getToken()).toBeNull();
    expect(config.getPreviousLinkProof()).toBe(linkProofForKey('good-key'));
    expect(manager.isLinked()).toBe(false);
    expect(manager.getStatus().state).toBe('unlinked');
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('sends one heartbeat for a burst of refused calls', async () => {
    const reply = deferred<Response>();
    const { config, manager, heartbeats } = refusedRoutes(() => reply.promise);

    const failures = [
      usage(manager),
      usage(manager),
      manager.submitConnectorAuthorityCommand(command),
      manager.readConnectorAuthorityCommand(command.commandId),
    ].map((request) => request.catch((error: unknown) => error));
    await vi.waitFor(() => expect(heartbeats).toHaveLength(1));
    reply.resolve(heartbeat('still-linked'));

    for (const failure of await Promise.all(failures)) {
      expect(failure).toMatchObject({ code: 'request_failed', status: 401 });
    }
    expect(heartbeats).toHaveLength(1);
    expect(config.getToken()).toBe('good-key');
  });

  it('lets a check that kept the key answer later refusals for five minutes', async () => {
    const start = Date.parse('2026-09-30T12:00:00Z');
    let clock = start;
    const { config, manager, heartbeats } = refusedRoutes(
      async () => heartbeat('still-linked'),
      () => clock
    );

    // One refusal after another, as a recovery pass or the event pull makes,
    // up to the last moment of the cooldown.
    for (const at of [0, 60_000, 120_000, 240_000, 299_999]) {
      clock = start + at;
      await expect(usage(manager)).rejects.toMatchObject({ code: 'request_failed' });
    }
    expect(heartbeats).toHaveLength(1);
    expect(config.getToken()).toBe('good-key');

    // Once the cooldown is over, the next refusal asks again.
    clock = start + 300_000;
    await expect(usage(manager)).rejects.toMatchObject({ code: 'request_failed' });
    expect(heartbeats).toHaveLength(2);
  });

  it('still unlinks on a heartbeat 401 inside the cooldown', async () => {
    let answer = heartbeat('still-linked');
    const { config, manager } = refusedRoutes(async () => answer);
    await expect(usage(manager)).rejects.toMatchObject({ code: 'request_failed' });

    answer = response(401);
    await manager.initOnStartup();

    expect(config.getToken()).toBeNull();
    expect(config.getPreviousLinkProof()).toBe(linkProofForKey('good-key'));
    expect(manager.getStatus().state).toBe('unlinked');
    await expect(usage(manager)).rejects.toMatchObject({
      code: 'unauthorized',
      name: 'ManagedConnectorLinkRequiredError',
    });
  });

  it('releases the refused call when the heartbeat hangs past its bound', async () => {
    vi.useFakeTimers();
    const { config, manager, heartbeats } = refusedRoutes(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    let settled = false;
    const failure = usage(manager)
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(heartbeats).toHaveLength(1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(failure).resolves.toMatchObject({ code: 'request_failed', status: 401 });
    expect(config.getToken()).toBe('good-key');
  });

  it.each([
    ['a server error', async () => response(503)],
    [
      'a network failure',
      async (): Promise<Response> => {
        throw new TypeError('fetch failed');
      },
    ],
    ['an unreadable answer', async () => new Response('not json', { status: 200 })],
  ] as const)('keeps the key when the heartbeat fails with %s', async (_label, onHeartbeat) => {
    const { config, manager, heartbeats } = refusedRoutes(onHeartbeat);

    await expect(usage(manager)).rejects.toMatchObject({ code: 'request_failed', status: 401 });

    expect(heartbeats).toHaveLength(1);
    expect(config.getToken()).toBe('good-key');
    expect(config.getPreviousLinkProof()).toBeNull();
    expect(manager.getSummary().linked).toBe(true);
    expect(manager.getStatus().state).not.toBe('unlinked');
  });

  it('still unlinks straight away when a regular heartbeat refuses the key', async () => {
    const { config, manager, heartbeats } = refusedRoutes(async () => response(401));

    await manager.initOnStartup();

    expect(heartbeats).toHaveLength(1);
    expect(config.getToken()).toBeNull();
    expect(config.getPreviousLinkProof()).toBe(linkProofForKey('good-key'));
    expect(manager.getStatus().state).toBe('unlinked');
  });

  it('keeps showing a re-link in progress when the check vouches for the old key', async () => {
    const tokenReply = deferred<Response>();
    const config = memoryConfig('old-key');
    const fetchImpl = vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/device/code')) return codes('new-code');
      if (path.endsWith('/device/token')) return tokenReply.promise;
      if (path.endsWith('/instances/heartbeat')) return heartbeat('old-account');
      if (path.includes('/instances/connectors/')) return response(401);
      throw new Error(`Unexpected request: ${path}`);
    });
    const manager = new CloudLinkManager({
      config,
      fetchImpl,
      sleep: noSleep,
      resolveTelemetryInstanceId: async () => undefined,
    });
    managers.push(manager);

    await manager.startLink();
    await expect(usage(manager)).rejects.toMatchObject({ code: 'request_failed' });

    expect(config.getToken()).toBe('old-key');
    expect(manager.getStatus().state).toBe('pending');
    tokenReply.resolve(response(200, { access_token: 'new-key' }));
    await manager.pendingLink;
    expect(config.getToken()).toBe('new-key');
    expect(manager.getStatus().state).toBe('linked');
  });

  it('lets a check that settles after an unlink change nothing', async () => {
    const reply = deferred<Response>();
    const { config, manager, heartbeats } = refusedRoutes(() => reply.promise);
    const failure = usage(manager).catch((error: unknown) => error);
    await vi.waitFor(() => expect(heartbeats).toHaveLength(1));

    await manager.unlink().catch(() => {});
    reply.resolve(heartbeat('stale-account'));

    await expect(failure).resolves.toMatchObject({ code: 'unauthorized' });
    expect(config.getToken()).toBeNull();
    expect(config.getAccountLabel()).toBeNull();
    expect(manager.getStatus()).toEqual({ state: 'idle' });
  });

  it('lets a refusing check that settles after a new link leave the new key alone', async () => {
    const reply = deferred<Response>();
    const config = memoryConfig('old-key');
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/device/code')) return codes('new-code');
      if (path.endsWith('/device/token')) return response(200, { access_token: 'new-key' });
      if (path.endsWith('/instances/heartbeat')) {
        return bearer(init) === 'old-key' ? reply.promise : heartbeat('new-account');
      }
      if (path.includes('/instances/connectors/')) return response(401);
      throw new Error(`Unexpected request: ${path}`);
    });
    const manager = new CloudLinkManager({
      config,
      fetchImpl,
      sleep: noSleep,
      resolveTelemetryInstanceId: async () => undefined,
    });
    managers.push(manager);

    const failure = usage(manager).catch((error: unknown) => error);
    await vi.waitFor(() =>
      expect(
        fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/instances/heartbeat'))
      ).toHaveLength(1)
    );
    await manager.startLink();
    await manager.pendingLink;
    reply.resolve(response(401));

    await expect(failure).resolves.toMatchObject({ code: 'unauthorized' });
    expect(config.getToken()).toBe('new-key');
    expect(config.getPreviousLinkProof()).toBeNull();
    expect(manager.getStatus().state).toBe('linked');
  });
});
