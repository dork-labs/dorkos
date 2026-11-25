/**
 * DOR-2620: a 401 from a managed-connector route is not proof the key is dead.
 * Only the heartbeat, the authoritative key check, may drop it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CloudLinkManager } from '../../cloud-link.js';
import { linkProofForKey, ManagedConnectorCloudError } from '../../cloud-link-client.js';
import {
  bearer,
  callKinds,
  callsTo,
  cloudRoutes,
  command,
  deferred,
  heartbeat,
  manage,
  managedCall,
  memoryConfig,
  response,
  stopManagers,
} from './cloud-link-lifecycle.fixtures.js';

/** A linked manager whose managed routes answer 401 and whose heartbeat answers `onHeartbeat`. */
function refusedRoutes(
  onHeartbeat: (init?: RequestInit) => Promise<Response>,
  now: () => number = Date.now
) {
  const config = memoryConfig('good-key');
  const heartbeats: RequestInit[] = [];
  const fetchImpl = cloudRoutes({
    heartbeat: (init) => {
      heartbeats.push(init ?? {});
      return onHeartbeat(init);
    },
    connectors: () => response(401),
  });
  const sync = vi.fn();
  const manager = manage(config, fetchImpl, { now });
  manager.setManagedProviderSync(sync);
  return { config, manager, heartbeats, sync };
}

const usage = (manager: CloudLinkManager) => managedCall(manager, 'managed');

describe('CloudLinkManager key check after a refused call', () => {
  afterEach(stopManagers);

  it.each(callKinds)(
    'keeps the link and its key when the heartbeat vouches for a key a %s call refused',
    async (kind) => {
      const { config, manager, heartbeats, sync } = refusedRoutes(async () =>
        heartbeat('still-linked')
      );

      // The call still fails, but as one refused request: never "unlinked"
      // while the link is fine. The route's own refusal is kept as the cause.
      const error = await managedCall(manager, kind).catch((caught: unknown) => caught);
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

  // Also the plain case: a regular heartbeat 401 unlinks and keeps the relink proof.
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
    const manager = manage(
      config,
      cloudRoutes({
        token: () => tokenReply.promise,
        heartbeat: () => heartbeat('old-account'),
        connectors: () => response(401),
      })
    );

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
    const fetchImpl = cloudRoutes({
      heartbeat: (init) => (bearer(init) === 'old-key' ? reply.promise : heartbeat('new-account')),
      connectors: () => response(401),
    });
    const manager = manage(config, fetchImpl);

    const failure = usage(manager).catch((error: unknown) => error);
    await vi.waitFor(() => expect(callsTo(fetchImpl, '/instances/heartbeat')).toBe(1));
    await manager.startLink();
    await manager.pendingLink;
    reply.resolve(response(401));

    await expect(failure).resolves.toMatchObject({ code: 'unauthorized' });
    expect(config.getToken()).toBe('new-key');
    expect(config.getPreviousLinkProof()).toBeNull();
    expect(manager.getStatus().state).toBe('linked');
  });
});
